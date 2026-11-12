'use strict';
// Native operation lifetime/outbox durability. Clinical output and suppression
// reader are explicit synthetic ports; adapter accepts a controlled handoff.
// This is not the shipping Socket.IO/clinical-model composition proof.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {execFileSync,spawnSync}=require('node:child_process'),{Client,Pool}=require('pg');
const {run}=require('../lib/migrations/postgres'),connect=require('../lib/storage/postgres-connection');
const scope=require('../lib/storage/tenant-scope'),contexts=require('../lib/server/serve/evaluator-job-context');
const start=require('../lib/server/serve/evaluator-runtime'),coordinate=require('../lib/server/serve/evaluator-consumers').coordinate;
const {optInSuite}=require('./support/opt-in');
const IMAGE='postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<2000;i++){if(await fn())return;await delay(5);}assert.fail('NATIVE_SCHEDULER_PROGRESS_TIMEOUT');}
optInSuite(process.env.NS_EVALUATOR_JOB_DOCKER_TEST==='1','NS_EVALUATOR_JOB_DOCKER_TEST=1')('native trusted evaluator jobs with one physical lifetime client',function(){
 this.timeout(60000);
 const container='ns-evaluator-job-'+crypto.randomBytes(6).toString('hex'),control='job_control',outbox='job_outbox';
 let owned=false,admin,pool,window,connection,release,runtime,consumers,oldMode,clinicalJobs,deliveryJobs;
 const effects=[];let requested=false,paused=false,allowTimers=true;
 const q=name=>'"'+name+'"';
 before(async function(){
  const password=crypto.randomBytes(24).toString('hex');
  execFileSync('docker',['run','--name',container,'--label','nightscout.test=evaluator-trusted-jobs','-d','-p','127.0.0.1::5432','-e','POSTGRES_USER=bootstrap','-e','POSTGRES_PASSWORD='+password,'-e','POSTGRES_DB=evaluator_job_test',IMAGE],{stdio:'pipe'});owned=true;
  const port=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8'}))[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
  const uri='postgres://bootstrap:'+password+'@127.0.0.1:'+port+'/evaluator_job_test';
  for(let i=0;i<100;i++){try{admin=new Client({connectionString:uri});await admin.connect();break;}catch{await admin?.end().catch(()=>{});admin=null;await delay(100);}}
  assert(admin,'owned PostgreSQL ready');
  await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');await admin.query('REVOKE CREATE ON DATABASE evaluator_job_test FROM PUBLIC');
  await admin.query('CREATE ROLE job_owner NOLOGIN NOSUPERUSER NOBYPASSRLS');
  const urls={};
  for(const role of ['job_lifetime','job_worker']){const secret=crypto.randomBytes(24).toString('hex');await admin.query('CREATE ROLE '+q(role)+" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '"+secret+"'");const url=new URL(uri);url.username=role;url.password=secret;urls[role]=url.toString();}
  for(const [namespace,catalogue]of [[control,require('../lib/tenant-lifecycle/postgres-candidate.json')],[outbox,require('../lib/tenant-notifications/postgres-candidate.json')]]){
   await admin.query('CREATE SCHEMA '+q(namespace));await run('up',{direct:true,connectionString:uri,namespace,catalogue});
   for(const row of(await admin.query('SELECT tablename FROM pg_tables WHERE schemaname=$1',[namespace])).rows)await admin.query('ALTER TABLE '+q(namespace)+'.'+q(row.tablename)+' OWNER TO job_owner');
   for(const row of(await admin.query('SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1',[namespace])).rows)await admin.query('ALTER FUNCTION '+row.signature+' OWNER TO job_owner');
   await admin.query('ALTER SCHEMA '+q(namespace)+' OWNER TO job_owner');
  }
  for(const role of ['job_lifetime','job_worker']){
   await admin.query('GRANT USAGE ON SCHEMA '+q(control)+' TO '+q(role));
   for(const table of ['schema_migrations','tenant_lifecycle_windows','tenant_lifecycle_operations'])await admin.query('GRANT SELECT ON '+q(control)+'.'+q(table)+' TO '+q(role));
  }
  await admin.query('GRANT INSERT(tenant_id,operation_id,generation),UPDATE(finished) ON '+q(control)+'.tenant_lifecycle_operations TO job_lifetime');
  await admin.query('GRANT EXECUTE ON FUNCTION '+q(control)+'.tenant_lifecycle_backend_birth() TO job_lifetime');
  await admin.query('INSERT INTO '+q(control)+".tenant_lifecycle_windows(tenant_id,lock_key,phase,generation) VALUES ($1,17,'active',1),($2,19,'active',1)",[A,B]);
  await admin.query('GRANT USAGE ON SCHEMA '+q(outbox)+' TO job_worker');await admin.query('GRANT SELECT ON '+q(outbox)+'.schema_migrations TO job_worker');
  await admin.query('GRANT SELECT,INSERT,UPDATE(request_id,blocked_until) ON '+q(outbox)+'.tenant_notification_heads TO job_worker');
  await admin.query('GRANT SELECT,INSERT,UPDATE(state,next_at,attempt,attempt_token,attempt_until,accepted_at,receipt,cleared_at) ON '+q(outbox)+'.tenant_notification_requests TO job_worker');
  await admin.query('GRANT SELECT,INSERT,UPDATE(revision,config_identity,producer) ON '+q(outbox)+'.tenant_notification_state TO job_worker');
  oldMode=scope.getTenancyMode();scope.setTenancyMode('multi');
  pool=new Pool({connectionString:urls.job_lifetime,max:1,connectionTimeoutMillis:1000});
  window=require('../lib/tenant-lifecycle/operation-window').create({namespace:control,locks:[{tenant:A,key:'17'},{tenant:B,key:'19'}],pool});
  await window.ready();release=connect.installOperationWindow(window);
  clinicalJobs=contexts.create('clinical');deliveryJobs=contexts.create('delivery');
  connection=await connect({connectionString:urls.job_worker,max:1,statement_timeout:2000});
  const store=require('../lib/tenant-notifications/postgres')({connection,namespace:outbox,maxRows:10,maxBytes:65536});
  const current=async tenant=>({tenant,identity:'a'.repeat(64),env:{settings:{heartbeat:1}}});
  const activity={check:async()=>({eligible:!paused,code:paused?'PAUSED':null,state:{paused,suspended:false}})};
  const result=()=>({tenant:A,checkpoint:0,now:Date.now(),emitted:[],requested:requested?[{kind:'notify',title:'Synthetic alarm',message:'Synthetic details',level:1,group:'default',plugin:{name:'synthetic'}}]:[],properties:{requested}});
  runtime=await start({tenants:[A],operationWindow:window,jobContext:clinicalJobs,readCurrent:current,activity,
   create:async()=>({evaluate:async()=>result(),evaluateTime:async()=>result(),close(){}}),
   recoveryIntervalMs:60000,timeIntervalMs:20,setTimer:(fn,ms)=>setTimeout(()=>{if(allowTimers)fn();},ms),schedule:()=>({}),cancel(){},onRevision:tenant=>consumers?.revised(tenant)});
  consumers=coordinate({tenants:[A],operationWindow:window,jobContext:deliveryJobs,current:runtime.last,currentConfig:current,isCurrent:runtime.isCurrent,store,
   reader:{read:async()=>[],allows:async()=>true},adapter:{id:'native-controlled',send(request,callback){
    admin.query('SELECT state FROM '+q(outbox)+'.tenant_notification_requests WHERE request_id=$1',[request.id]).then(({rows})=>{
     assert.equal(rows.length,1,'INTENT_VISIBLE_OUTSIDE_WORKER_TRANSACTION_BEFORE_HANDOFF');
     assert.equal(rows[0].state,'attempting');effects.push(request);callback(null,{accepted:true,receipt:null,clearedRequestIds:[]});
    }).catch(error=>callback(error));
   }},activity,
   maxRows:10,maxBytes:65536,maxPayloadBytes:10000,maxInflight:1,attemptTimeoutMs:1000,retryDelayMs:1,pollIntervalMs:60000,retryIntervalMs:60000,schedule:()=>({}),cancel(){}});
  consumers.start();await consumers.flush(A);
 });
 after(async function(){
  const errors=[];
  for(const close of [()=>consumers?.close(),()=>runtime?.close(),()=>connection?.end(),()=>release?.(),()=>window?.close(),()=>pool?.end(),()=>admin?.end()]){
   try{await close();}catch(error){errors.push(error);}
  }
  clinicalJobs?.close();deliveryJobs?.close();if(oldMode)scope.setTenancyMode(oldMode);
  if(owned)try{execFileSync('docker',['rm','-f','-v',container],{stdio:'pipe'});assert.equal(spawnSync('docker',['inspect',container],{stdio:'pipe'}).status,1,'OWNED_NATIVE_CONTAINER_REMOVED');console.log('NATIVE_JOB_CLEANUP '+JSON.stringify({containerRemoved:true,anonymousVolumesRemoved:true,image:IMAGE}));}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(errors,'Native scheduler fixture cleanup failed');
 });
 it('commits revision intents and accepted handoffs, repeats, and makes time-only progress without writes',async function(){
  requested=true;
  await until(()=>effects.length>0);
  const first=effects.length;
  await until(()=>effects.length>first);
  const rows=(await admin.query('SELECT state,accepted_at FROM '+q(outbox)+'.tenant_notification_requests')).rows;
  assert(rows.some(row=>row.state==='accepted'&&row.accepted_at),'ACTUAL_DURABLE_ACCEPTED_HANDOFF');
  assert(runtime.health([A]).tenants[0].progress.completedTimeCycles>=2);
  assert.equal(pool.totalCount,1,'ONE_PHYSICAL_LIFETIME_CLIENT');
  const sessions=(await admin.query("SELECT usename,count(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database() AND usename IN ('job_lifetime','job_worker') GROUP BY usename ORDER BY usename")).rows;
  assert.deepEqual(sessions,[{usename:'job_lifetime',count:1},{usename:'job_worker',count:1}]);
  console.log('NATIVE_JOB_BACKENDS '+JSON.stringify({lifetimePoolMax:1,outboxPoolMax:1,sessions}));
  // A waiter is normal while the due timer and consumer share this one
  // physical client. Real completion and nested admission, rather than a
  // transient waitingCount==0 sample, discriminate a pool-slot deadlock.
  allowTimers=false;await runtime.tick(A);await consumers.flush(A);
  const completed=runtime.health([A]).tenants[0].progress.completedAcquisitions;
  await window.run(A,async()=>{
   await Promise.all([runtime.acquire(A),runtime.acquire(A)]);
   await Promise.all([consumers.wake(A),consumers.wake(A)]);
   assert.equal(runtime.health([A]).tenants[0].progress.completedAcquisitions,completed,'BORROWED_RUNTIME_CALLS_GET_NO_FRESH_CREDIT');
   const pending=async()=> (await admin.query('SELECT operation_id FROM '+q(control)+'.tenant_lifecycle_operations WHERE NOT finished ORDER BY operation_id')).rows;
   const before=await pending();assert.equal(before.length,1);
   await window.run(A,async()=>{await delay(2);window.assertCurrent(A);assert.deepEqual(await pending(),before,'LEGITIMATE_NESTED_AWAIT_REUSES_OWN_LIFETIME');});
  });
  await assert.rejects(window.run(B,()=>runtime.acquire(A)),/LIFECYCLE_WINDOW_SCOPE_INVALID/);
  let ownedRuntime,ownedDelivery;
  await window.run(A,async()=>{
   ownedRuntime=clinicalJobs.run(()=>runtime.tick(A));await delay(2);
   await assert.rejects(runtime.acquire(A),{code:'EVALUATOR_JOB_PARENT_BUSY'});
   ownedDelivery=deliveryJobs.run(()=>consumers.wake(A));await delay(2);
   await assert.rejects(consumers.wake(A),{code:'EVALUATOR_JOB_PARENT_BUSY'});
  });
  await Promise.all([ownedRuntime,ownedDelivery]);
  allowTimers=true;await runtime.tick(A);
 });
 it('refuses fresh suspended jobs and paused delivery, then resumes through fresh admission',async function(){
  paused=true;await runtime.tick(A);await consumers.wake(A);
  assert.equal(runtime.health([A]).tenants[0].activity.paused,true);
  await admin.query('UPDATE '+q(control)+".tenant_lifecycle_windows SET phase='suspended',claim_id=$2,artifact_digest=repeat('a',64) WHERE tenant_id=$1",[A,crypto.randomUUID()]);
  paused=false;await runtime.acquire(A);await consumers.wake(A);
  assert.equal(runtime.health([A]).tenants[0].code,'EVALUATOR_WINDOW_REFUSED');
  assert.equal(consumers.health([A]).tenants[0].code,'EVALUATOR_CONSUMER_REFUSED');
  await admin.query('UPDATE '+q(control)+".tenant_lifecycle_windows SET phase='active',claim_id=NULL,artifact_digest=NULL,generation=generation+1 WHERE tenant_id=$1",[A]);
  await runtime.acquire(A);await consumers.wake(A);
  assert.equal(runtime.health([A]).tenants[0].code,null);
  let late;await window.run(A,()=>{late=new Promise(resolve=>setTimeout(()=>resolve(window.run(A,()=>assert.fail('late application work'))),5));late.catch(()=>{});});
  await assert.rejects(late,/LIFECYCLE_WINDOW_SCOPE_INVALID/);
  let lateAcquire;await window.run(A,()=>{lateAcquire=new Promise(resolve=>setTimeout(()=>resolve(runtime.acquire(A)),5));lateAcquire.catch(()=>{});});
  await assert.rejects(lateAcquire,/LIFECYCLE_WINDOW_SCOPE_INVALID/);
  let lateWake;await window.run(A,()=>{lateWake=new Promise(resolve=>setTimeout(()=>resolve(consumers.wake(A)),5));lateWake.catch(()=>{});});
  await assert.rejects(lateWake,/LIFECYCLE_WINDOW_SCOPE_INVALID/);
  paused=true;await runtime.tick(A);await runtime.invalidateTenant(A);await consumers.invalidateTenant(A);
  assert.equal((await admin.query('SELECT count(*)::integer AS n FROM '+q(control)+'.tenant_lifecycle_operations WHERE NOT finished')).rows[0].n,0);
 });
});
