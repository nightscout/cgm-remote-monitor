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
 it('admits legacy exact versions and fractional due once, then makes the old reader refuse',async()=>{
  const checkpoint=require('../lib/pgstream/checkpoint');
  admissionPool=new Pool({connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI,max:1});
  const port={query:(...args)=>admin.query(...args),withTenant:async(_tenant,fn)=>{await admin.query('BEGIN');try{const value=await fn();await admin.query('COMMIT');return value;}catch(e){await admin.query('ROLLBACK');throw e;}}};
  // This suite isolates physical migration/admission SQL; native backend authority has separate gates.
  port.admitEvaluatorTyped=options=>require('../lib/pgstream/work-state').admit({pool:admissionPool,observeBackend:async()=>{},...options});
  const options={connection:port,namespace,consumer:'evaluator-admit',maxBytes:1048576,timeIntervalMs:60000};
  const legacy=require('./fixtures/legacy-evaluator-checkpoint')(namespace,options.consumer),typed=checkpoint.create({...options,typed:true});
  const state={kind:'evaluator-work-v1',observed:{clock:'9007199254740993'},completed:{clock:'9007199254740993'},observedAt:{clock:0},pendingAt:null,nextDueAt:8572.42857142857,completedAt:0,enabled:true,output:null};
  await admin.query(`INSERT INTO ${table} (tenant_id,consumer,contract_digest,checkpoint,projection) VALUES ($1,$2,$3,0,$4::jsonb)`,[tenant,legacy.consumer,legacy.digest,JSON.stringify([state])]);
  await typed.admit([tenant]);
  const before=(await admin.query(`SELECT * FROM ${table} WHERE consumer=$1`,[typed.consumer])).rows[0];
  assert.equal(before.work_due_at,'8573');assert.equal(before.work_observed[0],'9007199254740993');assert.deepEqual(before.projection,[{kind:'evaluator-work-v2',output:null}]);
  await typed.admit([tenant]);assert.deepEqual((await admin.query(`SELECT * FROM ${table} WHERE consumer=$1`,[typed.consumer])).rows[0],before);
  assert.throws(()=>checkpoint.create(options),/EVALUATOR_CHECKPOINT_TYPED_REQUIRED/,'retired runtime is refused before any read');
  assert.deepEqual(await typed.begin(tenant),{clock:'9007199254740993'});
 });
 it('rejects a changed migration checksum',()=>{const broken=structuredClone(candidate);broken.migrations[1].checksum='0'.repeat(64);assert.throws(()=>catalogue.validateCatalogue(broken),/checksum mismatch/);});
});

// Physical receipt SQL and COMMIT visibility; lifecycle fencing uses the
// recording protocol fixture and does not certify native authority admission.
optInSuite(process.env.NS_PGSTREAM_ROLE_TEST==='1'&&!!process.env.NS_TEST_POSTGRES_ADMIN_URI,'NS_PGSTREAM_ROLE_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')('typed realtime receipt SQL on actual PostgreSQL',function(){
 this.timeout(30000);
 const namespace='typed_rt_'+crypto.randomBytes(6).toString('hex');
 const tenant='11111111-1111-4111-8111-111111111111',worker='22222222-2222-4222-8222-222222222222',nextWorker='33333333-3333-4333-8333-333333333333';
 const table='"'+namespace+'".tenant_consumer_checkpoint',consumer='realtime-native';
 let admin,observer,nativePool,metadataRole,connected=false,observerConnected=false,protocol,create,at=100,failCommit=false,rollbackCommit=false,commitGate=null,commitEntered=null,store;
 const statements=[];
 const metadataPool={connect:async()=>{const client=await nativePool.connect();return {release:error=>client.release(error),query:async(text,values)=>{statements.push(typeof text==='string'?text:text.text);if(text==='COMMIT'){if(commitEntered)commitEntered();if(commitGate)await commitGate;if(failCommit)throw new Error('SYNTHETIC_RECEIPT_COMMIT_FAILURE');if(rollbackCommit)return client.query('ROLLBACK');}return client.query(text,values);}};}};
 const port={query:(...args)=>admin.query(...args),readOnly:(...args)=>nativePool.query(...args),updateRealtimeReceipts:options=>require('../lib/pgstream/realtime-receipt-sql').update({pool:metadataPool,observeBackend:async client=>{const role=(await client.query('SELECT r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user')).rows[0];assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);},...options})};
 const make=owner=>create({config:{namespaces:{checkpoint:namespace},consumer,maxTenants:2},connection:port,operationWindow:protocol.window,worker:owner,now:()=>at});
 const row=async()=>((await observer.query(`SELECT output_received::text AS received,output_completed::text AS completed,output_retry_at::text AS retry,output_owner::text AS owner FROM ${table} WHERE tenant_id=$1 AND consumer=$2`,[tenant,consumer])).rows[0]);
 before(async()=>{
  admin=new Client({connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI,connectionTimeoutMillis:5000});await admin.connect();connected=true;
  observer=new Client({connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI,connectionTimeoutMillis:5000});await observer.connect();observerConnected=true;
  await run('up',{direct:true,connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI,namespace,catalogue:require('../migrations/candidates/postgres-realtime-output-v2.json')});
  metadataRole=namespace+'_metadata';const password=crypto.randomBytes(24).toString('hex');
  await admin.query(`CREATE ROLE "${metadataRole}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
  await admin.query(`GRANT USAGE ON SCHEMA "${namespace}" TO "${metadataRole}"`);
  await admin.query(`GRANT SELECT,UPDATE(output_received,output_completed,output_owner,output_retry_at,output_delivery_version) ON ${table} TO "${metadataRole}"`);
  await admin.query(`CREATE POLICY receipt_metadata_select ON ${table} FOR SELECT TO "${metadataRole}" USING (consumer='realtime-native')`);
  await admin.query(`CREATE POLICY receipt_metadata_update ON ${table} FOR UPDATE TO "${metadataRole}" USING (consumer='realtime-native') WITH CHECK (consumer='realtime-native')`);
  await admin.query(`CREATE TABLE "${namespace}".clinical (tenant_id uuid,value jsonb)`);
  const roleUri=new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI);roleUri.username=metadataRole;roleUri.password=password;nativePool=new Pool({connectionString:roleUri.toString(),max:2});
  create=require('../lib/pgstream/realtime-receipt').create;
  protocol=require('./fixtures/operation-window-runtime-protocol')({trustedWorker:true});await protocol.window.ready();store=make(worker);await store.verify();
 });
 beforeEach(async()=>{at=100;failCommit=false;rollbackCommit=false;commitGate=null;commitEntered=null;await admin.query(`DELETE FROM ${table}`);await admin.query(`INSERT INTO ${table} (tenant_id,consumer,contract_digest,checkpoint) VALUES ($1,$2,$3,0)`,[tenant,consumer,'a'.repeat(64)]);});
 after(async()=>{await protocol?.window.close();await nativePool?.end();if(observerConnected)await observer.end();if(admin){try{if(connected){await admin.query('DROP SCHEMA IF EXISTS "'+namespace+'" CASCADE');if(metadataRole){await admin.query('DROP OWNED BY "'+metadataRole+'"');await admin.query('DROP ROLE "'+metadataRole+'"');}}}finally{await admin.end();}}});
 it('does not acknowledge receipt until physical COMMIT and rolls back a failed COMMIT',async()=>{
  let release,entered;commitGate=new Promise(resolve=>{release=resolve;});const waiting=new Promise(resolve=>{entered=resolve;});commitEntered=entered;
  let producerAck=false;const receiving=store.receive(tenant,'1').then(()=>{producerAck=true;});
  try{await waiting;assert.equal((await row()).received,'0');assert.equal(producerAck,false);}
  finally{commitEntered=null;commitGate=null;release();await receiving;}
  assert.equal(producerAck,true);assert.equal((await row()).received,'1');
  failCommit=true;await assert.rejects(store.receive(tenant,'2'),/SYNTHETIC_RECEIPT_COMMIT_FAILURE/);failCommit=false;assert.equal((await row()).received,'1');
  rollbackCommit=true;await assert.rejects(store.receive(tenant,'2'),/REALTIME_RECEIPT_COMMIT/);rollbackCommit=false;assert.equal((await row()).received,'1');
  await store.receive(tenant,'2');assert.equal((await row()).received,'2');
 });
 it('coalesces the same producer revision and preserves newer work across old completion or retry',async()=>{
  await store.receive(tenant,'1');await store.receive(tenant,'1');assert.equal((await row()).received,'1');
  const selected=await store.work();assert.deepEqual(selected,[{tenant,received:'1'}]);
  await store.receive(tenant,'2');await store.retry(tenant,selected[0].received);assert.equal((await row()).retry,null);
  await store.complete(tenant,selected[0].received);assert.equal((await row()).completed,'1');assert.deepEqual(await store.work(),[{tenant,received:'2'}]);
  await store.retry(tenant,'2');assert.equal(await store.nextDue(),1100);assert.deepEqual(await store.work(),[]);
  await store.receive(tenant,'2');assert.equal((await row()).retry,'1100','duplicate must not erase known backoff');
  await store.receive(tenant,'3');assert.equal((await row()).retry,null);assert.deepEqual(await store.work(),[{tenant,received:'3'}]);
  await store.complete(tenant,'3');assert.deepEqual(await store.work(),[]);assert.equal(await store.nextDue(),null);
 });
 it('recovers persisted pending receipts to a replacement worker and rejects the old worker ACK',async()=>{
  await store.receive(tenant,'9007199254740993');await store.retry(tenant,'9007199254740993');
  const replacement=make(nextWorker);await replacement.recover([tenant]);
  assert.equal((await row()).received,'9007199254740993');assert.equal((await row()).owner,nextWorker);assert.equal((await row()).retry,null);
  await assert.rejects(store.complete(tenant,'9007199254740993'),/REALTIME_RECEIPT_NOT_PROVISIONED_OR_REPLACED/);
  assert.equal((await row()).completed,'0');await replacement.complete(tenant,'9007199254740993');assert.equal((await row()).completed,'9007199254740993');
 });
 it('acknowledges duplicate and older hints without rewriting an already owned durable receipt',async()=>{
  const tuple=async()=>(await observer.query(`SELECT ctid::text AS tuple FROM ${table} WHERE tenant_id=$1 AND consumer=$2`,[tenant,consumer])).rows[0].tuple;
  await store.receive(tenant,'2');await store.retry(tenant,'2');
  const pending=await tuple(),before=await row();
  for(const revision of ['2','1','2'])assert.equal(await store.receive(tenant,revision),'2');
  assert.equal(await tuple(),pending,'DUPLICATE_HINT_MUST_NOT_REWRITE_PENDING_RECEIPT');assert.deepEqual(await row(),before);
  await store.complete(tenant,'2');const completed=await tuple();
  await store.receive(tenant,'2');await store.receive(tenant,'1');
  assert.equal(await tuple(),completed,'OLD_HINT_MUST_NOT_REWRITE_COMPLETED_RECEIPT');
  const replacement=make(nextWorker);await replacement.receive(tenant,'1');
  assert.notEqual(await tuple(),completed,'DIFFERENT_OWNER_STILL_REQUIRES_DURABLE_WRITE');assert.equal((await row()).owner,nextWorker);
 });
 it('holds duplicate ACK until COMMIT and serializes a concurrent newer receipt behind it',async()=>{
  await store.receive(tenant,'1');
  let release,entered,acked=false;
  commitGate=new Promise(resolve=>{release=resolve;});const waiting=new Promise(resolve=>{entered=resolve;});commitEntered=entered;
  const duplicate=store.receive(tenant,'1').then(()=>{acked=true;});let newer;
  try{
   await waiting;assert.equal(acked,false,'DUPLICATE_ACK_MUST_WAIT_FOR_COMMIT');
   commitGate=null;commitEntered=null;newer=store.receive(tenant,'2');
   let blocked=false;
   for(let i=0;i<100;i++){
    blocked=(await observer.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'",[metadataRole])).rowCount>0;
    if(blocked)break;await new Promise(resolve=>setTimeout(resolve,5));
   }
   assert.equal(blocked,true,'DUPLICATE_RECEIVE_MUST_LOCK_DURABLE_OWNERSHIP');assert.equal((await row()).received,'1');assert.equal(acked,false);
  }finally{commitGate=null;commitEntered=null;release();await Promise.all([duplicate,newer]);}
  assert.equal(acked,true);assert.equal((await row()).received,'2');assert.deepEqual(await store.work(),[{tenant,received:'2'}]);
 });
 it('rejects noncanonical or overflowing revisions before mutating the physical receipt',async()=>{
  for(const value of ['0','01','9223372036854775808',9007199254740992])await assert.rejects(store.receive(tenant,value),/Exact positive delivery revision/);
  assert.equal((await row()).received,'0');await store.receive(tenant,'9223372036854775807');await store.receive(tenant,'9223372036854775807');assert.equal((await row()).received,'9223372036854775807');
 });
 it('rechecks a duplicate waiting behind a newer uncommitted revision',async()=>{
  await store.receive(tenant,'1');await admin.query('BEGIN');
  let duplicate,acked=false;
  try{
   await admin.query(`UPDATE ${table} SET output_received=2 WHERE tenant_id=$1 AND consumer=$2`,[tenant,consumer]);
   duplicate=store.receive(tenant,'1').then(value=>{acked=true;return value;});
   let blocked=false;
   for(let i=0;i<100;i++){
    blocked=(await observer.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'",[metadataRole])).rowCount>0;
    if(blocked)break;await new Promise(resolve=>setTimeout(resolve,5));
   }
   assert.equal(blocked,true,'DUPLICATE_MUST_WAIT_FOR_NEWER_TRANSACTION');assert.equal(acked,false);assert.equal((await row()).received,'1');
   await admin.query('COMMIT');assert.equal(await duplicate,'2');assert.equal((await row()).received,'2');
  }finally{await admin.query('ROLLBACK');await Promise.allSettled([duplicate]);}
 });
 it('returns each mixed batch tenant once and rewrites only its changed receipt',async()=>{
  const ids=[tenant,'44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555'];
  for(const id of ids.slice(1))await admin.query(`INSERT INTO ${table} (tenant_id,consumer,contract_digest,checkpoint) VALUES ($1,$2,$3,0)`,[id,consumer,'a'.repeat(64)]);
  const update=(mode,rows)=>port.updateRealtimeReceipts({table:namespace+'.tenant_consumer_checkpoint',consumer,worker,mode,rows});
  const capture=async()=>new Map((await observer.query(`SELECT tenant_id::text AS tenant,ctid::text AS tuple,output_retry_at::text AS retry FROM ${table} WHERE consumer=$1`,[consumer])).rows.map(value=>[value.tenant,value]));
  await update('receive',ids.map(tenant=>({tenant,revision:'2'})));await update('retry',ids.map(tenant=>({tenant,revision:'2',due:1100})));
  const before=await capture(),result=await update('receive',ids.map((tenant,i)=>({tenant,revision:['3','2','1'][i]}))),after=await capture();
  assert.equal(result.rows.length,3);assert.deepEqual(new Map(result.rows.map(row=>[row.tenant,row.received])),new Map(ids.map((tenant,i)=>[tenant,i===0?'3':'2'])),'MIXED_RECEIPT_EACH_TENANT_ONCE');
  assert.notEqual(before.get(tenant).tuple,after.get(tenant).tuple);assert.equal(after.get(tenant).retry,null);
  for(const id of ids.slice(1))assert.deepEqual(after.get(id),before.get(id),'UNCHANGED_BATCH_RECEIPT_MUST_KEEP_TUPLE_AND_BACKOFF');
 });
 it('receives and recovers suspended control through metadata SQL while serving admission is closed',async()=>{
  const suspended=require('./fixtures/operation-window-runtime-protocol')({trustedWorker:true,phases:{[tenant]:'suspended'}});await suspended.window.ready();
  const paused=create({config:{namespaces:{checkpoint:namespace},consumer,maxTenants:2},connection:port,operationWindow:suspended.window,worker,now:()=>at});
  try{
   await assert.rejects(suspended.window.run(tenant,()=>{}),/LIFECYCLE_WINDOW_SUSPENDED/,'control proves serving admission is closed');
   await paused.receive(tenant,'1');await paused.recover([tenant]);assert.equal((await row()).received,'1');
   await paused.complete(tenant,'1');assert.equal((await row()).completed,'1');
  }finally{await suspended.window.close();}
 });
 it('executes one set-oriented metadata UPDATE for a realized multi-tenant receipt batch',async()=>{
  const ids=Array.from({length:16},(_,i)=>'44444444-4444-4444-8444-'+String(i+1).padStart(12,'0'));
  for(const id of ids)await admin.query(`INSERT INTO ${table} (tenant_id,consumer,contract_digest,checkpoint) VALUES ($1,$2,$3,0)`,[id,consumer,'a'.repeat(64)]);
  statements.length=0;
  const updated=await port.updateRealtimeReceipts({table:namespace+'.tenant_consumer_checkpoint',consumer,worker,mode:'receive',rows:ids.map(id=>({tenant:id,revision:'9007199254740993'}))});
  assert.equal(updated.rows.length,16);assert(updated.rows.every(value=>value.received==='9007199254740993'));
  assert.equal(statements.filter(sql=>/\bUPDATE\b/i.test(sql)).length,1,'one physical metadata statement must realize the batch');
  console.log('REALTIME_NATIVE_METADATA_BATCH '+JSON.stringify({selected:ids.length,returned:updated.rows.length,updateStatements:1}));
 });

 it('keeps fixed metadata grants and UPDATE policy narrow, with a removed-policy red control',async()=>{
  await admin.query(`INSERT INTO ${table} (tenant_id,consumer,contract_digest,checkpoint) VALUES ($1,'other-consumer',$2,0)`,[tenant,'b'.repeat(64)]);
  assert.equal((await nativePool.query(`SELECT * FROM ${table} WHERE consumer='other-consumer'`)).rowCount,0);
  assert.equal((await nativePool.query(`UPDATE ${table} SET output_retry_at=1 WHERE consumer='other-consumer'`)).rowCount,0);
  for(const sql of [`UPDATE ${table} SET tenant_id='55555555-5555-4555-8555-555555555555'`,`INSERT INTO ${table} (tenant_id,consumer,contract_digest,checkpoint) VALUES ('55555555-5555-4555-8555-555555555555','realtime-native','${'a'.repeat(64)}',0)`,`DELETE FROM ${table}`,`SELECT * FROM "${namespace}".clinical`])await assert.rejects(nativePool.query(sql),error=>error.code==='42501');
  await store.receive(tenant,'1');
  await admin.query(`DROP POLICY receipt_metadata_update ON ${table}`);
  try{for(const revision of ['1','2'])await assert.rejects(store.receive(tenant,revision),/REALTIME_RECEIPT/);assert.equal((await row()).received,'1');}
  finally{await admin.query(`CREATE POLICY receipt_metadata_update ON ${table} FOR UPDATE TO "${metadataRole}" USING (consumer='realtime-native') WITH CHECK (consumer='realtime-native')`);}
  await store.receive(tenant,'2');assert.equal((await row()).received,'2');
 });

});

// Actual lower-port snapshots; this checks concurrent bytes/revisions, while
// serving assignment and lifecycle exclusion keep their separate native gates.
optInSuite(process.env.NS_PGSTREAM_ROLE_TEST==='1'&&!!process.env.NS_TEST_POSTGRES_ADMIN_URI,'NS_PGSTREAM_ROLE_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')('typed delivery snapshot on actual PostgreSQL',function(){
 this.timeout(30000);
 const lab=require('./fixtures/tenant-projection-evaluator')();
 let store,table,publish=false,snapshot=true,physicalReads=0;
 const identity='a'.repeat(64),consumer='evaluator-snapshot';
 const body=revision=>({tenant:lab.A,inputCheckpoint:revision,checkpoint:revision,trigger:'acquisition',result:{privateResult:'must stay in evaluator'},rows:[],frame:{revision,lastUpdated:revision}});
 const seed=revision=>lab.admin.query('UPDATE '+table+' SET output_revision=$3,output_digest=$4,projection=$5::jsonb WHERE tenant_id=$1 AND consumer=$2',[lab.A,store.consumer,revision,String(revision).repeat(64),JSON.stringify([{kind:'evaluator-work-v2',output:body(revision)}])]);
 before(async()=>{
  await lab.open();table='"'+lab.replayNamespace+'".tenant_consumer_checkpoint';
  await run('up',{direct:true,connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI,namespace:lab.replayNamespace,catalogue:candidate});
  const checkpoint=require('../lib/pgstream/checkpoint');
  await lab.admin.query('GRANT UPDATE('+checkpoint.WORK_COLUMNS.join(',')+') ON '+table+' TO "'+lab.readerRole+'"');
  await lab.admin.query('CREATE POLICY typed_snapshot_metadata ON '+table+' TO "'+lab.readerRole+'" USING (consumer=\''+consumer+'-completed\') WITH CHECK (consumer=\''+consumer+'-completed\')');
  const port={...lab.reader,snapshotTransaction:fn=>snapshot?lab.reader.snapshotTransaction(fn):fn(),query:async(text,values)=>{
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
  await seed(1);snapshot=false;publish=true;const broken=await store.output(lab.A,identity,{delivery:true});
  assert.throws(()=>coherent(broken),/REVISION_FRAME_MUST_SHARE_SNAPSHOT/);
  snapshot=true;await seed(1);publish=true;coherent(await store.output(lab.A,identity,{delivery:true}));
 });
 it('acquires one result-free physical output per revision and reuses the intact retained delivery',async()=>{
  await seed(1);const first=await store.output(lab.A,identity,{delivery:true});coherent(first);
  const before=physicalReads;assert.equal(await store.output(lab.A,identity,{delivery:true,retained:first}),first);assert.equal(physicalReads,before);
  await seed(2);const next=await store.output(lab.A,identity,{delivery:true,retained:first});coherent(next);assert.equal(physicalReads,before+1);
 });
});
