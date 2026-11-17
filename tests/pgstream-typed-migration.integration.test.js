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
optInSuite(process.env.NS_PGSTREAM_ROLE_TEST==='1'&&!!process.env.NS_TEST_POSTGRES_ADMIN_URI,'NS_PGSTREAM_ROLE_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')('realtime-owned delivery progress SQL on actual PostgreSQL',function(){
 this.timeout(30000);
 const suffix=crypto.randomBytes(6).toString('hex'),namespace='typed_rt_'+suffix,source='typed_ev_'+suffix;
 const tenant='11111111-1111-4111-8111-111111111111',worker='22222222-2222-4222-8222-222222222222',nextWorker='33333333-3333-4333-8333-333333333333';
 const table='"'+namespace+'".tenant_consumer_checkpoint',obligations='"'+source+'".tenant_consumer_checkpoint',consumer='realtime-native',evaluatorConsumer='evaluator-native';
 let admin,observer,nativePool,metadataRole,connected=false,observerConnected=false,protocol,create,at=100,failCommit=false,rollbackCommit=false,commitGate=null,commitEntered=null,store;
 const statements=[];
 const metadataPool={connect:async()=>{const client=await nativePool.connect();return {release:error=>client.release(error),query:async(text,values)=>{statements.push(typeof text==='string'?text:text.text);if(text==='COMMIT'){if(commitEntered)commitEntered();if(commitGate)await commitGate;if(failCommit)throw new Error('SYNTHETIC_RECEIPT_COMMIT_FAILURE');if(rollbackCommit)return client.query('ROLLBACK');}return client.query(text,values);}};}};
 const portWith=helper=>({query:(...args)=>admin.query(...args),readOnly:(text,values)=>{statements.push(text);return nativePool.query(text,values);},updateRealtimeReceipts:options=>helper.update({pool:metadataPool,observeBackend:async client=>{const role=(await client.query('SELECT r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user')).rows[0];assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);},...options})});
 const port=portWith(require('../lib/pgstream/realtime-receipt-sql'));
 const config={namespaces:{checkpoint:namespace},consumer,maxTenants:64,completedOutput:{namespace:source,consumer:evaluatorConsumer}};
 const make=(owner,connection=port)=>create({config,connection,worker:owner,now:()=>at});
 const row=async(id=tenant)=>((await observer.query(`SELECT output_received::text AS received,output_completed::text AS completed,output_retry_at::text AS retry,output_owner::text AS owner FROM ${table} WHERE tenant_id=$1 AND consumer=$2`,[id,consumer])).rows[0]);
 const commit=(revision,id=tenant)=>admin.query(`UPDATE ${obligations} SET delivery_revision=$3 WHERE tenant_id=$1 AND consumer=$2`,[id,evaluatorConsumer+'-completed',revision]);
 const provision=async id=>{
  await admin.query(`INSERT INTO ${table} (tenant_id,consumer,contract_digest,checkpoint) VALUES ($1,$2,$3,0)`,[id,consumer,'a'.repeat(64)]);
  await admin.query(`INSERT INTO ${obligations} (tenant_id,consumer,contract_digest,checkpoint,work_version,work_observed,work_completed,work_observed_at) VALUES ($1,$2,$3,0,2,$4::bigint[],$4::bigint[],$4::bigint[])`,[id,evaluatorConsumer+'-completed','b'.repeat(64),[null,null,null,null,null,null]]);
 };
 const ok=(rows,value=true)=>new Map(rows.map(value_=>[value_.tenant,value]));
 before(async()=>{
  admin=new Client({connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI,connectionTimeoutMillis:5000});await admin.connect();connected=true;
  observer=new Client({connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI,connectionTimeoutMillis:5000});await observer.connect();observerConnected=true;
  await run('up',{direct:true,connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI,namespace,catalogue:require('../migrations/candidates/postgres-realtime-output-v2.json')});
  await run('up',{direct:true,connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI,namespace:source,catalogue:candidate});
  metadataRole=namespace+'_metadata';const password=crypto.randomBytes(24).toString('hex');
  await admin.query(`CREATE ROLE "${metadataRole}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
  await admin.query(`GRANT USAGE ON SCHEMA "${namespace}" TO "${metadataRole}"`);
  await admin.query(`GRANT SELECT,UPDATE(output_received,output_completed,output_owner,output_retry_at,output_delivery_version) ON ${table} TO "${metadataRole}"`);
  await admin.query(`CREATE POLICY receipt_metadata_select ON ${table} FOR SELECT TO "${metadataRole}" USING (consumer='realtime-native')`);
  await admin.query(`CREATE POLICY receipt_metadata_update ON ${table} FOR UPDATE TO "${metadataRole}" USING (consumer='realtime-native') WITH CHECK (consumer='realtime-native')`);
  // The deployed realtime reader of the evaluator checkpoint (deploy pgstream.js): SELECT, completed consumer only.
  await admin.query(`GRANT USAGE ON SCHEMA "${source}" TO "${metadataRole}"`);
  await admin.query(`GRANT SELECT ON ${obligations} TO "${metadataRole}"`);
  await admin.query(`CREATE POLICY realtime_output_select ON ${obligations} FOR SELECT TO "${metadataRole}" USING (consumer='${evaluatorConsumer}-completed')`);
  await admin.query(`CREATE TABLE "${namespace}".clinical (tenant_id uuid,value jsonb)`);
  const roleUri=new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI);roleUri.username=metadataRole;roleUri.password=password;nativePool=new Pool({connectionString:roleUri.toString(),max:2});
  create=require('../lib/pgstream/realtime-receipt').create;
  protocol=require('./fixtures/operation-window-runtime-protocol')({trustedWorker:true});await protocol.window.ready();store=make(worker);await store.verify();
 });
 beforeEach(async()=>{at=100;failCommit=false;rollbackCommit=false;commitGate=null;commitEntered=null;await admin.query(`DELETE FROM ${table}`);await admin.query(`DELETE FROM ${obligations}`);await provision(tenant);});
 after(async()=>{await protocol?.window.close();await nativePool?.end();if(observerConnected)await observer.end();if(admin){try{if(connected){await admin.query('DROP SCHEMA IF EXISTS "'+namespace+'" CASCADE');await admin.query('DROP SCHEMA IF EXISTS "'+source+'" CASCADE');if(metadataRole){await admin.query('DROP OWNED BY "'+metadataRole+'"');await admin.query('DROP ROLE "'+metadataRole+'"');}}}finally{await admin.end();}}});
 it('selects only owed revisions in one read and records nothing until physical COMMIT',async()=>{
  assert.deepEqual(await store.work([tenant]),[],'NO_COMMITTED_REVISION_NO_WORK');
  await commit('1');statements.length=0;const rows=await store.work([tenant]);assert.deepEqual(rows,[{tenant,received:'1'}]);
  assert.equal(statements.length,1,'ONE_READ_STATEMENT');
  let release,entered;commitGate=new Promise(resolve=>{release=resolve;});const waiting=new Promise(resolve=>{entered=resolve;});commitEntered=entered;
  let done=false;const finishing=store.finish(rows,ok(rows),1100).then(()=>{done=true;});
  try{await waiting;assert.equal((await row()).completed,'0');assert.equal(done,false);}
  finally{commitEntered=null;commitGate=null;release();await finishing;}
  assert.deepEqual(await row(),{received:'1',completed:'1',retry:null,owner:worker});assert.deepEqual(await store.work([tenant]),[]);
  await commit('2');const next=await store.work([tenant]);
  failCommit=true;await assert.rejects(store.finish(next,ok(next),1100),/SYNTHETIC_RECEIPT_COMMIT_FAILURE/);failCommit=false;assert.equal((await row()).completed,'1');
  rollbackCommit=true;await assert.rejects(store.finish(next,ok(next),1100),/REALTIME_RECEIPT_COMMIT/);rollbackCommit=false;assert.equal((await row()).completed,'1');
  await store.finish(next,ok(next),1100);assert.equal((await row()).completed,'2');
 });
 it('(b) a failed attempt keeps completion, sets one durable due time, and a newer revision is due at once',async()=>{
  await commit('1');const rows=await store.work([tenant]);await store.finish(rows,ok(rows,false),1100);
  assert.deepEqual(await row(),{received:'1',completed:'0',retry:'1100',owner:worker},'FAILED_ATTEMPT_MUST_NOT_COMPLETE');
  assert.deepEqual(await store.work([tenant]),[],'NOT_DUE_BEFORE_RETRY_TIME');at=1100;assert.deepEqual(await store.work([tenant]),[{tenant,received:'1'}],'DUE_AT_RETRY_TIME');
  at=100;await commit('2');assert.deepEqual(await store.work([tenant]),[{tenant,received:'2'}],'NEWER_REVISION_BYPASSES_BACKOFF');
  const next=await store.work([tenant]);await store.finish(next,ok(next),1200);assert.deepEqual(await row(),{received:'2',completed:'2',retry:null,owner:worker});
 });
 it('(c) never moves completion backwards; a revision committed during delivery remains pending',async()=>{
  async function criterion(connection){
   await admin.query(`DELETE FROM ${table}`);await admin.query(`DELETE FROM ${obligations}`);await provision(tenant);
   const selected=make(worker,connection);
   await commit('1');const rows=await selected.work([tenant]);
   await commit('2');// the evaluator commits a newer revision while the page is delivered
   await selected.finish(rows,ok(rows),1100);assert.equal((await row()).completed,'1','DELIVERED_PAGE_RECORDS_ITS_OWN_REVISION');
   assert.deepEqual(await selected.work([tenant]),[{tenant,received:'2'}],'NEWER_REVISION_REMAINS_PENDING');
   const next=await selected.work([tenant]);await selected.finish(next,ok(next),1100);assert.equal((await row()).completed,'2');
   await selected.finish(rows,ok(rows),1100);assert.deepEqual(await row(),{received:'2',completed:'2',retry:null,owner:worker},'STALE_SUCCESS_MUST_NOT_REGRESS');
   await selected.finish(rows,ok(rows,false),1100);assert.deepEqual(await row(),{received:'2',completed:'2',retry:null,owner:worker},'STALE_FAILURE_MUST_NOT_REOPEN');
  }
  const fs=require('node:fs'),vm=require('node:vm'),file=require.resolve('../lib/pgstream/realtime-receipt-sql'),text=fs.readFileSync(file,'utf8'),needle='output_completed=CASE WHEN w.ok THEN GREATEST(c.output_completed,w.revision::bigint) ELSE';
  assert.equal(text.split(needle).length,2,'MONOTONE_NEEDLE');const broken={exports:{}};
  vm.runInThisContext('(function(require,module,exports){'+text.replace(needle,'output_completed=CASE WHEN w.ok THEN w.revision::bigint ELSE').replace("'realtime-receipt-v3:'","'realtime-receipt-regress:'")+'\n})',{filename:file})(require,broken,broken.exports);
  await assert.rejects(criterion(portWith(broken.exports)),error=>{console.log('REALTIME_MONOTONE_ABLATION_RED '+error.message.split('\n')[0]);return /STALE_SUCCESS_MUST_NOT_REGRESS/.test(error.message);});
  await criterion(port);
  for(const value of ['0','01','9223372036854775808'])await assert.rejects(store.finish([{tenant,received:value}],ok([{tenant}]),1100),/Exact positive delivery revision/);
 });
 it('(d) a non-owner realtime cannot select or complete another owner\'s tenant; a claim transfers it',async()=>{
  async function criterion(connection){
   await admin.query(`DELETE FROM ${table}`);await admin.query(`DELETE FROM ${obligations}`);await provision(tenant);
   await commit('1');const rows=await store.work([tenant]);await store.finish(rows,ok(rows),1100);await commit('2');
   const other=make(nextWorker,connection);
   assert.deepEqual(await other.work([tenant]),[],'NON_OWNER_MUST_NOT_SELECT');
   await other.finish([{tenant,received:'2'}],ok([{tenant}]),1100).catch(()=>{});
   assert.deepEqual(await row(),{received:'1',completed:'1',retry:null,owner:worker},'NON_OWNER_MUST_NOT_COMPLETE');
   await other.recover([tenant]);assert.equal((await row()).owner,nextWorker);
   await assert.rejects(store.finish([{tenant,received:'2'}],ok([{tenant}]),1100),/REALTIME_RECEIPT_NOT_PROVISIONED_OR_REPLACED/);
   const owned=await other.work([tenant]);await other.finish(owned,ok(owned),1100);assert.deepEqual(await row(),{received:'2',completed:'2',retry:null,owner:nextWorker});
  }
  const fs=require('node:fs'),vm=require('node:vm'),file=require.resolve('../lib/pgstream/realtime-receipt-sql'),text=fs.readFileSync(file,'utf8'),needle=' AND (c.output_owner IS NULL OR c.output_owner=$2::uuid)\n';
  assert.equal(text.split(needle).length,2,'OWNER_FENCE_NEEDLE');const broken={exports:{}};
  vm.runInThisContext('(function(require,module,exports){'+text.replace(needle,'\n').replace("'realtime-receipt-v3:'","'realtime-receipt-ablated:'")+'\n})',{filename:file})(require,broken,broken.exports);
  await assert.rejects(criterion(portWith(broken.exports)),error=>{console.log('REALTIME_OWNER_FENCE_ABLATION_RED '+error.message.split('\n')[0]);return /NON_OWNER_MUST_NOT_COMPLETE/.test(error.message);});
  await criterion(port);
 });
 it('claims owned rows for a replacement worker and makes a known retry due at once',async()=>{
  await commit('9007199254740993');const rows=await store.work([tenant]);await store.finish(rows,ok(rows,false),1100);
  const replacement=make(nextWorker);await replacement.recover([tenant]);
  assert.deepEqual(await row(),{received:'9007199254740993',completed:'0',retry:null,owner:nextWorker});
  assert.deepEqual(await replacement.work([tenant]),[{tenant,received:'9007199254740993'}]);
  const tuple=async()=>(await observer.query(`SELECT ctid::text AS tuple FROM ${table} WHERE tenant_id=$1 AND consumer=$2`,[tenant,consumer])).rows[0].tuple;
  const before=await tuple();await replacement.recover([tenant]);assert.equal(await tuple(),before,'REPEATED_CLAIM_MUST_NOT_REWRITE');
 });
 it('progresses suspended control through metadata SQL while serving admission is closed',async()=>{
  const suspended=require('./fixtures/operation-window-runtime-protocol')({trustedWorker:true,phases:{[tenant]:'suspended'}});await suspended.window.ready();
  const paused=make(worker);
  try{
   await assert.rejects(suspended.window.run(tenant,()=>{}),/LIFECYCLE_WINDOW_SUSPENDED/,'control proves serving admission is closed');
   await commit('1');await paused.recover([tenant]);const rows=await paused.work([tenant]);await paused.finish(rows,ok(rows),1100);assert.equal((await row()).completed,'1');
  }finally{await suspended.window.close();}
 });
 it('executes one read and one set-oriented metadata UPDATE for a realized multi-tenant page',async()=>{
  const ids=Array.from({length:16},(_,i)=>'44444444-4444-4444-8444-'+String(i+1).padStart(12,'0'));
  for(const id of ids){await provision(id);await commit('9007199254740993',id);}
  statements.length=0;
  const rows=await store.work(ids);await store.finish(rows,new Map(rows.map((value,i)=>[value.tenant,i%2===0])),1100);
  assert.equal(rows.length,16);assert.equal(statements.filter(sql=>/^\s*SELECT\b/i.test(sql)&&sql.includes('tenant_consumer_checkpoint')).length,1,'one physical read must select the page');
  assert.equal(statements.filter(sql=>/\bUPDATE\b/i.test(sql)).length,1,'one physical metadata statement must realize the page');
  const after=await Promise.all(ids.map(id=>row(id)));assert.deepEqual(after.map(value=>value.completed),ids.map((_,i)=>i%2===0?'9007199254740993':'0'));
  console.log('REALTIME_NATIVE_METADATA_BATCH '+JSON.stringify({selected:ids.length,returned:rows.length,readStatements:1,updateStatements:1}));
 });
 it('keeps fixed metadata grants and UPDATE policy narrow, with a removed-policy red control',async()=>{
  await admin.query(`INSERT INTO ${table} (tenant_id,consumer,contract_digest,checkpoint) VALUES ($1,'other-consumer',$2,0)`,[tenant,'b'.repeat(64)]);
  assert.equal((await nativePool.query(`SELECT * FROM ${table} WHERE consumer='other-consumer'`)).rowCount,0);
  assert.equal((await nativePool.query(`UPDATE ${table} SET output_retry_at=1 WHERE consumer='other-consumer'`)).rowCount,0);
  await admin.query(`INSERT INTO ${obligations} (tenant_id,consumer,contract_digest,checkpoint) VALUES ($1,'evaluator-native',$2,0)`,[tenant,'c'.repeat(64)]);
  assert.equal((await nativePool.query(`SELECT * FROM ${obligations} WHERE consumer='evaluator-native'`)).rowCount,0,'ONLY_COMPLETED_OUTPUT_ROWS_VISIBLE');
  for(const sql of [`UPDATE ${table} SET tenant_id='55555555-5555-4555-8555-555555555555'`,`INSERT INTO ${table} (tenant_id,consumer,contract_digest,checkpoint) VALUES ('55555555-5555-4555-8555-555555555555','realtime-native','${'a'.repeat(64)}',0)`,`DELETE FROM ${table}`,`SELECT * FROM "${namespace}".clinical`,
   `UPDATE ${obligations} SET delivery_ack_revision=1`,`UPDATE ${obligations} SET delivery_revision=9`])await assert.rejects(nativePool.query(sql),error=>error.code==='42501');
  await commit('1');const rows=await store.work([tenant]);
  await admin.query(`DROP POLICY receipt_metadata_update ON ${table}`);
  try{await assert.rejects(store.finish(rows,ok(rows),1100),/REALTIME_RECEIPT/);assert.equal((await row()).completed,'0');}
  finally{await admin.query(`CREATE POLICY receipt_metadata_update ON ${table} FOR UPDATE TO "${metadataRole}" USING (consumer='realtime-native') WITH CHECK (consumer='realtime-native')`);}
  await store.finish(rows,ok(rows),1100);assert.equal((await row()).completed,'1');
 });
});
// Actual lower-port snapshots; this checks concurrent bytes/revisions, while
// serving assignment and lifecycle exclusion keep their separate native gates.
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
