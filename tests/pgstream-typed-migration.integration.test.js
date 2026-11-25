'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const tenantScope=require('../lib/storage/tenant-scope');
const {Client,Pool}=require('pg');
const {optInSuite}=require('./support/opt-in');
const {run}=require('../lib/migrations/postgres');
const catalogue=require('../lib/migrations/catalogue');
const candidate=require('../migrations/candidates/postgres-evaluator-work-v2.json');
optInSuite(process.env.NS_PGSTREAM_ROLE_TEST==='1'&&!!process.env.NS_TEST_POSTGRES_ADMIN_URI,'NS_PGSTREAM_ROLE_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')('typed evaluator catalogue on actual PostgreSQL',function(){
 this.timeout(30000);
 const namespace='typed_work_'+crypto.randomBytes(6).toString('hex'),tenant='00000000-0000-0000-0000-000000000001';
 const table='"'+namespace+'".tenant_consumer_checkpoint';
 let admin,connected=false,admissionPool,tenancyMode;
 const migrate=()=>run('up',{direct:true,connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI,namespace,catalogue:candidate});
 before(async()=>{tenancyMode=tenantScope.getTenancyMode();tenantScope.setTenancyMode('multi');admin=new Client({connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI,connectionTimeoutMillis:5000});await admin.connect();connected=true;});
 after(async()=>{if(tenancyMode)tenantScope.setTenancyMode(tenancyMode);await admissionPool?.end();if(admin){try{if(connected)await admin.query('DROP SCHEMA IF EXISTS "'+namespace+'" CASCADE');}finally{await admin.end();}}});
 it('applies the appended DDL and replays the exact ledger without changing it',async()=>{
  const first=await migrate();assert.deepEqual(first.done,candidate.migrations.map(m=>m.name));
  const ledger=await admin.query('SELECT name,checksum FROM "'+namespace+'".schema_migrations ORDER BY name');
  const second=await migrate();assert.deepEqual(second.done,[]);
  assert.deepEqual((await admin.query('SELECT name,checksum FROM "'+namespace+'".schema_migrations ORDER BY name')).rows,ledger.rows);
  assert.deepEqual(candidate.migrations[0],require('../migrations/candidates/postgres-consumer-checkpoint-v1.json').migrations[0]);
 });
 it('rejects reordered versions, malformed arrays, early epoch overflow and delivery ACK beyond production',async()=>{
  await admin.query(`INSERT INTO ${table} (tenant_id,consumer,contract_digest,checkpoint) VALUES ($1,'evaluator-native-completed',$2,0)`,[tenant,'a'.repeat(64)]);
  const invalid=["work_version=2","work_observed=ARRAY[1,2]::bigint[]","work_observed=ARRAY[1,NULL,NULL,NULL,NULL,NULL]::bigint[],work_completed=ARRAY[2,NULL,NULL,NULL,NULL,NULL]::bigint[]","work_due_at=8640000000000000","delivery_ack_revision=1","output_revision=9007199254740992","output_restore_generation=0"];
  for(const set of invalid)await assert.rejects(admin.query(`UPDATE ${table} SET ${set} WHERE tenant_id=$1`,[tenant]),error=>error.code==='23514');
  await admin.query(`UPDATE ${table} SET work_due_at=8573 WHERE tenant_id=$1`,[tenant]);
  assert.equal((await admin.query(`SELECT work_due_at::text AS due FROM ${table} WHERE tenant_id=$1`,[tenant])).rows[0].due,'8573');
  await admin.query(`UPDATE ${table} SET work_observed=ARRAY[9007199254740993,NULL,9223372036854775807,NULL,NULL,NULL]::bigint[],output_restore_generation=9223372036854775807 WHERE tenant_id=$1`,[tenant]);
  const captured=(await admin.query(`SELECT work_observed,output_restore_generation FROM ${table} WHERE tenant_id=$1`,[tenant])).rows[0];assert.deepEqual(captured.work_observed,['9007199254740993',null,'9223372036854775807',null,null,null]);assert.equal(captured.output_restore_generation,'9223372036854775807');
 });
 it('detects a removed SQL delivery-order control and restores its rejection',async()=>{
  await admin.query(`ALTER TABLE ${table} DROP CONSTRAINT evaluator_delivery_order`);
  try{await admin.query(`UPDATE ${table} SET delivery_ack_revision=1 WHERE tenant_id=$1`,[tenant]);assert.equal((await admin.query(`SELECT delivery_ack_revision::text AS ack FROM ${table} WHERE tenant_id=$1`,[tenant])).rows[0].ack,'1','broken schema must actually permit bad ACK');}
  finally{await admin.query(`UPDATE ${table} SET delivery_ack_revision=0 WHERE tenant_id=$1`,[tenant]);await admin.query(candidate.migrations[1].up.find(sql=>sql.includes('ADD CONSTRAINT evaluator_delivery_order')).replace('tenant_consumer_checkpoint',table));}
  await assert.rejects(admin.query(`UPDATE ${table} SET delivery_ack_revision=1 WHERE tenant_id=$1`,[tenant]),error=>error.code==='23514');
 });
 it('initializes only a fresh current-format row and refuses legacy progress unchanged',async()=>{
  const work=require('../lib/pgstream/work-state');admissionPool=new Pool({connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI,max:1});
  const consumer='evaluator-admit-completed',digest='b'.repeat(64),options={pool:admissionPool,observeBackend:async()=>{},table:namespace+'.tenant_consumer_checkpoint',consumer,digest,tenants:[tenant]};
  await admin.query(`INSERT INTO ${table} (tenant_id,consumer,contract_digest,checkpoint) VALUES ($1,$2,$3,0)`,[tenant,consumer,digest]);
  await work.admit(options);const before=(await admin.query(`SELECT * FROM ${table} WHERE consumer=$1`,[consumer])).rows[0];assert.equal(before.work_version,2);assert.deepEqual(before.work_observed,[null,null,null,null,null,null]);
  await work.admit(options);assert.deepEqual((await admin.query(`SELECT * FROM ${table} WHERE consumer=$1`,[consumer])).rows[0],before);
  await admin.query(`UPDATE ${table} SET work_version=0,projection=$2::jsonb WHERE consumer=$1`,[consumer,JSON.stringify([{kind:'evaluator-work-v1',observed:{clock:'9007199254740993'}}])]);
  const legacy=(await admin.query(`SELECT * FROM ${table} WHERE consumer=$1`,[consumer])).rows[0];await assert.rejects(work.admit(options),/EVALUATOR_OUTPUT_CONTRACT/);assert.deepEqual((await admin.query(`SELECT * FROM ${table} WHERE consumer=$1`,[consumer])).rows[0],legacy);
 });
 it('rejects a changed migration checksum',()=>{const broken=structuredClone(candidate);broken.migrations[1].checksum='0'.repeat(64);assert.throws(()=>catalogue.validateCatalogue(broken),/checksum mismatch/);});
});

// Physical delivery-progress SQL and COMMIT visibility. Realtime reads the
// evaluator's committed delivery_revision and owns completion and retry;
// lifecycle fencing uses the recording protocol fixture.
optInSuite(process.env.NS_PGSTREAM_ROLE_TEST==='1'&&!!process.env.NS_TEST_POSTGRES_ADMIN_URI,'NS_PGSTREAM_ROLE_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')('realtime receipt removal on actual PostgreSQL (decision D23)',function(){
 this.timeout(30000);
 const suffix=crypto.randomBytes(6).toString('hex'),namespace='typed_rt_'+suffix,source='typed_ev_'+suffix;
 const table='"'+namespace+'".tenant_consumer_checkpoint',obligations='"'+source+'".tenant_consumer_checkpoint';
 const current=require('../migrations/candidates/postgres-realtime-output-v2.json'),removal=require('../lib/pgstream/realtime-receipt-removal-sql');
 // The catalogue as a populated deployment holds it: everything before the removal.
 const prior={...current,migrations:current.migrations.filter(migration=>migration.name!==removal.NAME)};
 const migrate=(target,selected)=>run('up',{direct:true,connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI,namespace:target,catalogue:selected});
 let admin,connected=false;
 before(async()=>{admin=new Client({connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI,connectionTimeoutMillis:5000});await admin.connect();connected=true;});
 after(async()=>{if(admin){try{if(connected)for(const name of [namespace,source,namespace+'_new'])await admin.query('DROP SCHEMA IF EXISTS "'+name+'" CASCADE');}finally{await admin.end();}}});
 const shape=async()=>({file:(await admin.query("SELECT pg_relation_filenode($1::regclass) AS file",[table])).rows[0].file,
  triggers:(await admin.query('SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname=ANY($1)',[[namespace,source]])).rows[0].n,
  functions:(await admin.query('SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1',[namespace])).rows[0].n,
  columns:(await admin.query('SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum',[table])).rows.map(row=>row.attname),
  indexes:(await admin.query("SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND tablename='tenant_consumer_checkpoint' ORDER BY 1",[namespace])).rows.map(row=>row.indexname)});
 it('removes the obligation triggers, function, owed index and receipt columns from a populated table without rewriting it',async()=>{
  assert.equal(current.migrations.at(-1).name,removal.NAME);assert.equal(prior.migrations.length,3);
  await migrate(namespace,prior);await migrate(source,candidate);
  // The deployment's DBA step installed the obligation under a name derived from its namespaces.
  const name='rt_obligation_'+crypto.randomBytes(16).toString('hex'),fn='"'+namespace+'".'+name;
  await admin.query('CREATE FUNCTION '+fn+'() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_RELID=\''+obligations+'\'::regclass THEN UPDATE '+table+' SET output_target=NEW.delivery_revision WHERE tenant_id=NEW.tenant_id; RETURN NULL; END IF; RETURN NEW; END $$');
  await admin.query('CREATE TRIGGER rt_subscription_native BEFORE INSERT ON '+table+' FOR EACH ROW EXECUTE FUNCTION '+fn+'()');
  await admin.query('CREATE TRIGGER '+name+' AFTER UPDATE OF delivery_revision ON '+obligations+' FOR EACH ROW EXECUTE FUNCTION '+fn+'()');
  await admin.query('CREATE TRIGGER '+name+'_lifetime AFTER INSERT OR DELETE ON '+obligations+' FOR EACH ROW EXECUTE FUNCTION '+fn+'()');
  const digest='a'.repeat(64);
  await admin.query('INSERT INTO '+table+"(tenant_id,consumer,contract_digest,checkpoint) SELECT gen_random_uuid(),'realtime-native',$1,0 FROM generate_series(1,500)",[digest]);
  await admin.query('INSERT INTO '+obligations+"(tenant_id,consumer,contract_digest,checkpoint,work_version,work_observed,work_completed,work_observed_at) SELECT tenant_id,'evaluator-native-completed',$1,0,2,'{0,0,0,0,0,0}','{0,0,0,0,0,0}','{0,0,0,0,0,0}' FROM "+table,[digest]);
  await admin.query('UPDATE '+obligations+' SET delivery_revision=2');
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM '+table+' WHERE output_pending_tenant IS NOT NULL')).rows[0].n,500,'the installed obligation marks receipts before the migration');
  const populated=await shape();
  assert.equal(populated.triggers,3);assert.deepEqual(populated.indexes,['pgstream_realtime_owed','tenant_consumer_checkpoint_pkey']);
  assert.deepEqual((await migrate(namespace,current)).done,[removal.NAME]);
  const after=await shape();
  assert.equal(after.file,populated.file,'NO_REWRITE the table keeps its file');
  assert.equal(after.triggers,0,'the triggers on both checkpoint tables are gone');assert.equal(after.functions,0);
  assert.deepEqual(after.columns,['tenant_id','consumer','contract_digest','checkpoint','projection']);
  assert.deepEqual(after.indexes,['tenant_consumer_checkpoint_pkey']);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n,500);
  // The evaluator keeps writing, and the ledger replays unchanged.
  await admin.query('UPDATE '+obligations+' SET delivery_revision=delivery_revision+1,output_revision=output_revision+1');
  assert.deepEqual((await migrate(namespace,current)).done,[]);
 });
 it('applies to a database that never held an obligation, and refuses changed removal SQL',async()=>{
  assert.equal((await migrate(namespace+'_new',current)).done.length,4);
  const broken=structuredClone(current);broken.migrations.at(-1).up[3]+=', DROP COLUMN projection';broken.migrations.at(-1).checksum=catalogue.checksum(broken.migrations.at(-1).up);
  assert.throws(()=>catalogue.validateCatalogue(broken),{code:'MIG_OPERATION_SQL'});
  assert.throws(()=>removal.build({namespace:'public'}),/REALTIME_RECEIPT_REMOVAL_BINDING/);
 });
});
optInSuite(process.env.NS_PGSTREAM_ROLE_TEST==='1'&&!!process.env.NS_TEST_POSTGRES_ADMIN_URI,'NS_PGSTREAM_ROLE_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')('typed delivery snapshot on actual PostgreSQL',function(){
 this.timeout(30000);
 const lab=require('./fixtures/tenant-projection-evaluator')();
 let store,table,publish=false,snapshot=true,physicalReads=0,attemptWrite=false;
 const identity='a'.repeat(64),consumer='evaluator-snapshot';
 const body=revision=>({tenant:lab.A,inputCheckpoint:revision,checkpoint:revision,trigger:'acquisition',result:{privateResult:'must stay in evaluator'},rows:[],frame:{revision,lastUpdated:revision}});
 const seed=revision=>lab.admin.query('UPDATE '+table+' SET output_revision=$3,output_digest=$4,projection=$5::jsonb WHERE tenant_id=$1 AND consumer=$2',[lab.A,store.consumer,revision,String(revision).repeat(64),JSON.stringify([{kind:'evaluator-work-v2',output:body(revision)}])]);
 before(async()=>{
  await lab.open();table='"'+lab.replayNamespace+'".tenant_consumer_checkpoint';
  await run('up',{direct:true,connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI,namespace:lab.replayNamespace,catalogue:candidate});
  const checkpoint=require('../lib/pgstream/checkpoint');
  await lab.admin.query('GRANT UPDATE('+checkpoint.WORK_COLUMNS.join(',')+') ON '+table+' TO "'+lab.readerRole+'"');
  await lab.admin.query('CREATE POLICY typed_snapshot_metadata ON '+table+' TO "'+lab.readerRole+'" USING (consumer=\''+consumer+'-completed\') WITH CHECK (consumer=\''+consumer+'-completed\')');
  const port={...lab.reader,readOnlyTransaction:fn=>snapshot?lab.reader.readOnlyTransaction(fn):fn(),query:async(text,values)=>{
   if(attemptWrite){attemptWrite=false;await lab.reader.query('UPDATE '+table+' SET output_revision=output_revision WHERE tenant_id=$1',[lab.A]);}
   const result=await lab.reader.query(text,values);
   if(/AS output\b/.test(text))physicalReads++;
   if(publish&&/AS output_summary/.test(text)){publish=false;await seed(2);}
   return result;
  }};
  store=checkpoint.create({typed:true,connection:port,namespace:lab.replayNamespace,consumer,maxBytes:1048576,timeIntervalMs:60000});
  await lab.provision(store.consumer,lab.A,null,0,store.digest);await store.admit([lab.A]);
  await lab.admin.query('UPDATE '+table+' SET output_identity=$3,output_restore_generation=1 WHERE tenant_id=$1 AND consumer=$2',[lab.A,store.consumer,identity]);
 });
 after(async()=>{await store?.close();await lab.close();});
 const coherent=output=>{assert.equal(output.outputRevision,output.frame.revision,'REVISION_FRAME_MUST_SHARE_SNAPSHOT');assert.equal(Object.hasOwn(output,'result'),false,'DELIVERY_MUST_NOT_COPY_CLINICAL_RESULT');};
 it('keeps publication between metadata and frame in one snapshot, with a broken/restored native control',async()=>{
  await seed(1);publish=true;coherent(await store.output(lab.A,identity,{delivery:true}));
  await seed(1);snapshot=false;publish=true;const before=physicalReads;
  await assert.rejects(store.output(lab.A,identity,{delivery:true}),/EVALUATOR_OUTPUT_REPEATABLE_READ_REQUIRED/);
  assert.equal(physicalReads,before,'WEAK_SNAPSHOT_MUST_REFUSE_BEFORE_PHYSICAL_FRAME');
  snapshot=true;await seed(1);publish=true;coherent(await store.output(lab.A,identity,{delivery:true}));
 });
 it('refuses a delivery read that would inherit a weaker ambient write snapshot',async()=>{
  await seed(1);publish=true;
  const read=async()=>{const value=await store.output(lab.A,identity,{delivery:true});console.log('R4_WEAK_DELIVERY_ACCEPTED '+JSON.stringify({metadataRevision:value.outputRevision,frameRevision:value.frame.revision}));return value;};
  await assert.rejects(tenantScope.withTenant(lab.A,()=>lab.reader.transaction(read)),/EVALUATOR_OUTPUT_REPEATABLE_READ_REQUIRED/,'DELIVERY_MUST_NOT_INHERIT_READ_COMMITTED');
  publish=false;coherent(await store.output(lab.A,identity,{delivery:true}));
 });
 it('refuses a physical checkpoint write through the actual delivery reader',async()=>{
  await seed(1);attemptWrite=true;
  await assert.rejects(store.output(lab.A,identity,{delivery:true}),error=>error.code==='25006','DELIVERY_PORT_MUST_REFUSE_WRITES');
  coherent(await store.output(lab.A,identity,{delivery:true}));
 });
 it('acquires one result-free physical output per revision and reuses the intact retained delivery',async()=>{
  await seed(1);const first=await store.output(lab.A,identity,{delivery:true});coherent(first);
  const before=physicalReads;assert.equal(await store.output(lab.A,identity,{delivery:true,retained:first}),first);assert.equal(physicalReads,before);
  await seed(2);const next=await store.output(lab.A,identity,{delivery:true,retained:first});coherent(next);assert.equal(physicalReads,before+1);
 });
});
