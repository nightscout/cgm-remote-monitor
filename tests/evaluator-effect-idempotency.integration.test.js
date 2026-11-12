'use strict';
// Native effect-idempotency causal discriminator. Actual runtime/producer/
// outbox/window and clinical view rules; fixed synthetic clinical output and
// suppression ports isolate a fresh-owner unavailable-model warm barrier.
// The original shipping two-to-three failure is recorded separately.
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
optInSuite(process.env.NS_EVALUATOR_EFFECT_DOCKER_TEST==='1','NS_EVALUATOR_EFFECT_DOCKER_TEST=1')('native evaluator unavailable-model effect idempotency',function(){
 this.timeout(60000);
 const container='ns-evaluator-effect-'+crypto.randomBytes(6).toString('hex'),control='effect_control',outbox='effect_outbox';
 let owned=false,admin,pool,window,connection,release,runtime,consumers,oldMode,clinicalJobs,deliveryJobs;let volumes=[];
 const effects=[],workers=[];let clock,store,clinical;
 const at=Date.UTC(2026,10,12,12),identity='a'.repeat(64);
 const q=name=>'"'+name+'"';
 before(async function(){
  const password=crypto.randomBytes(24).toString('hex');
  execFileSync('docker',['run','--name',container,'--label','nightscout.test=evaluator-effect-idempotency','-d','-p','127.0.0.1::5432','-e','POSTGRES_USER=bootstrap','-e','POSTGRES_PASSWORD='+password,'-e','POSTGRES_DB=evaluator_effect_test',IMAGE],{stdio:'pipe'});owned=true;
  const inspected=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8'}))[0];
  const port=inspected.NetworkSettings.Ports['5432/tcp'][0].HostPort;
  volumes=inspected.Mounts.filter(row=>row.Type==='volume').map(row=>row.Name);
  const uri='postgres://bootstrap:'+password+'@127.0.0.1:'+port+'/evaluator_effect_test';
  for(let i=0;i<100;i++){try{admin=new Client({connectionString:uri});await admin.connect();break;}catch{await admin?.end().catch(()=>{});admin=null;await delay(100);}}
  assert(admin,'owned PostgreSQL ready');
  await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');await admin.query('REVOKE CREATE ON DATABASE evaluator_effect_test FROM PUBLIC');
  await admin.query('CREATE ROLE effect_owner NOLOGIN NOSUPERUSER NOBYPASSRLS');
  const urls={};
  for(const role of ['effect_lifetime','effect_worker']){const secret=crypto.randomBytes(24).toString('hex');await admin.query('CREATE ROLE '+q(role)+" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '"+secret+"'");const url=new URL(uri);url.username=role;url.password=secret;urls[role]=url.toString();}
  for(const [namespace,catalogue]of [[control,require('../lib/tenant-lifecycle/postgres-candidate.json')],[outbox,require('../lib/tenant-notifications/postgres-candidate.json')]]){
   await admin.query('CREATE SCHEMA '+q(namespace));await run('up',{direct:true,connectionString:uri,namespace,catalogue});
   for(const row of(await admin.query('SELECT tablename FROM pg_tables WHERE schemaname=$1',[namespace])).rows)await admin.query('ALTER TABLE '+q(namespace)+'.'+q(row.tablename)+' OWNER TO effect_owner');
   for(const row of(await admin.query('SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1',[namespace])).rows)await admin.query('ALTER FUNCTION '+row.signature+' OWNER TO effect_owner');
   await admin.query('ALTER SCHEMA '+q(namespace)+' OWNER TO effect_owner');
  }
  for(const role of ['effect_lifetime','effect_worker']){
   await admin.query('GRANT USAGE ON SCHEMA '+q(control)+' TO '+q(role));
   for(const table of ['schema_migrations','tenant_lifecycle_windows','tenant_lifecycle_operations'])await admin.query('GRANT SELECT ON '+q(control)+'.'+q(table)+' TO '+q(role));
  }
  await admin.query('GRANT INSERT(tenant_id,operation_id,generation),UPDATE(finished) ON '+q(control)+'.tenant_lifecycle_operations TO effect_lifetime');
  await admin.query('GRANT EXECUTE ON FUNCTION '+q(control)+'.tenant_lifecycle_backend_birth() TO effect_lifetime');
  await admin.query('INSERT INTO '+q(control)+".tenant_lifecycle_windows(tenant_id,lock_key,phase,generation) VALUES ($1,17,'active',1),($2,19,'active',1)",[A,B]);
  await admin.query('GRANT USAGE ON SCHEMA '+q(outbox)+' TO effect_worker');await admin.query('GRANT SELECT ON '+q(outbox)+'.schema_migrations TO effect_worker');
  await admin.query('GRANT SELECT,INSERT,UPDATE(request_id,blocked_until) ON '+q(outbox)+'.tenant_notification_heads TO effect_worker');
  await admin.query('GRANT SELECT,INSERT,UPDATE(state,next_at,attempt,attempt_token,attempt_until,accepted_at,receipt,cleared_at) ON '+q(outbox)+'.tenant_notification_requests TO effect_worker');
  await admin.query('GRANT SELECT,INSERT,UPDATE(revision,config_identity,producer) ON '+q(outbox)+'.tenant_notification_state TO effect_worker');
  oldMode=scope.getTenancyMode();scope.setTenancyMode('multi');
  pool=new Pool({connectionString:urls.effect_lifetime,max:2,connectionTimeoutMillis:1000});
  window=require('../lib/tenant-lifecycle/operation-window').create({namespace:control,locks:[{tenant:A,key:'17'},{tenant:B,key:'19'}],pool});
  await window.ready();release=connect.installOperationWindow(window);
  connection=await connect({connectionString:urls.effect_worker,max:1,statement_timeout:2000});
  store=require('../lib/tenant-notifications/postgres')({connection,namespace:outbox,maxRows:10,maxBytes:65536});
  clinical=clinicalOutput();
 });
 after(async function(){
  const errors=[];
  for(const close of [()=>closeWorkers(),()=>connection?.end(),()=>release?.(),()=>window?.close(),()=>pool?.end(),()=>admin?.end()]){
   try{await close();}catch(error){errors.push(error);}
  }
  clinicalJobs?.close();deliveryJobs?.close();if(oldMode)scope.setTenancyMode(oldMode);
  if(owned)try{execFileSync('docker',['rm','-f','-v',container],{stdio:'pipe'});assert.equal(spawnSync('docker',['inspect',container],{stdio:'pipe'}).status,1,'OWNED_NATIVE_CONTAINER_REMOVED');for(const volume of volumes)assert.equal(spawnSync('docker',['volume','inspect',volume],{stdio:'pipe'}).status,1,'OWNED_NATIVE_VOLUME_REMOVED');console.log('NATIVE_EFFECT_CLEANUP '+JSON.stringify({containerRemoved:true,anonymousVolumesRemoved:true,image:IMAGE}));}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(errors,'Native scheduler fixture cleanup failed');
 });
 async function closeWorkers(){
  const owned=workers.splice(0);for(const worker of owned)worker.release?.();
  await Promise.all(owned.map(async worker=>{await worker.consumer?.close();await worker.runtime?.close();worker.clinicalJobs.close();worker.deliveryJobs.close();}));
 }
 beforeEach(async function(){clock=at;effects.length=0;await admin.query('TRUNCATE '+q(outbox)+'.tenant_notification_requests,'+q(outbox)+'.tenant_notification_heads,'+q(outbox)+'.tenant_notification_state');});
 afterEach(closeWorkers);
 function latch(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
 function clinicalOutput(){
 const environment=require('../lib/server/tenant-app/environment')({settings:{enable:['bgnow','delta','direction','simplealarms']}});
 const view=require('../lib/data/views')(environment,{language:require('../lib/language')(),levels:require('../lib/levels'),moment:require('moment-timezone')});
 const ddata=require('../lib/data/ddata')();ddata.lastUpdated=at;ddata.sgvs=[{_id:'synthetic',mgdl:400,mills:at-1000,type:'sgv',direction:'Flat'}];
 return Object.freeze({checkpoint:7,progress:'current-snapshot',signature:{stamp:7,deleted:0},...view.evaluateCycle({now:at,ddata}),due:{dueAt:Infinity,reason:'none',slow:[]}});
 }
 async function worker({barrier}={}){
  const w={clinicalJobs:contexts.create('clinical'),deliveryJobs:contexts.create('delivery'),release:()=>barrier?.resolve()};workers.push(w);
  const current=async tenant=>({tenant,identity,env:{settings:{heartbeat:60}}});
  w.runtime=await start({tenants:[A],operationWindow:window,jobContext:w.clinicalJobs,readCurrent:current,
   create:async()=>{if(barrier)await barrier.promise;return{evaluate:async()=>({...clinical,now:clock}),evaluateTime:async()=>({...clinical,now:clock}),close(){}};},
   recoveryIntervalMs:1000000,timeIntervalMs:1000000,schedule:()=>({}),cancel(){},now:()=>clock,
   ...(barrier?{boot:'serve',bootConcurrency:1}:{}),onRevision:tenant=>w.consumer?.revised(tenant)});
  w.consumer=coordinate({tenants:[A],operationWindow:window,jobContext:w.deliveryJobs,current:w.runtime.last,currentConfig:current,isCurrent:w.runtime.isCurrent,store,
   reader:{read:async()=>[],allows:async()=>true},adapter:{id:'native-effect',send(request,callback){effects.push(request);callback(null,{accepted:true,receipt:null,clearedRequestIds:[]});}},
   now:()=>clock,maxRows:10,maxBytes:65536,maxPayloadBytes:10000,maxInflight:1,attemptTimeoutMs:1000,retryDelayMs:1,pollIntervalMs:1000000,retryIntervalMs:1000000,schedule:()=>({}),cancel(){}});
  return w;
 }
 async function snapshot(){return{requests:(await admin.query('SELECT request_id,state,payload,origin,created_at,accepted_at FROM '+q(outbox)+'.tenant_notification_requests ORDER BY created_at,request_id')).rows,
  producer:(await admin.query('SELECT producer FROM '+q(outbox)+'.tenant_notification_state WHERE tenant_id=$1',[A])).rows[0]?.producer};}
 const contract=require('../lib/tenant-notifications/contract');
 function trace(label,s){console.log('NATIVE_EFFECT_CAUSE '+JSON.stringify({label,clock,repeatAt:s.producer?.repeatAt??null,hasOutput:!!s.producer?.output,requests:s.requests.map(r=>({request:r.request_id,state:r.state,origin:r.origin,created:Number(r.created_at),accepted:r.accepted_at===null?null:Number(r.accepted_at),effectDigest:contract.effectIdentity(r.payload),clear:!!r.payload.clear}))}));}
 async function initial(){const first=await worker();first.consumer.start();await first.consumer.flush(A);const saved=await snapshot();assert.equal(saved.requests.length,1);assert.equal(saved.requests[0].state,'accepted');await first.consumer.close();await first.runtime.close();return saved;}
 it('retains one accepted logical effect when identical fresh-owner recovery has no unavailable-model observation',async function(){
  const before=await initial();clock+=4438;const next=await worker();next.consumer.start();await next.consumer.flush(A);const after=await snapshot();trace('no-gap',after);
  assert.equal(after.requests.length,before.requests.length);assert.equal(after.producer.repeatAt,before.producer.repeatAt);
 });
 it('refuses an early repeat after real producer observes a held fresh-owner model unavailable',async function(){
  const before=await initial(),barrier=latch();clock+=1000;const next=await worker({barrier});assert.equal(next.runtime.health([A]).tenants[0].ready,false);
  next.consumer.start();await next.consumer.flush(A);const unavailable=await snapshot();trace('unavailable-model',unavailable);assert.deepEqual(unavailable.producer.output,before.producer.output);
  clock=at+4438;barrier.resolve();await until(()=>next.runtime.health([A]).tenants[0].ready);await next.consumer.flush(A);const after=await snapshot();trace('identical-recovery-before-deadline',after);
  assert.deepEqual(after.producer.output,before.producer.output,'IDENTICAL_COMMITTED_CLINICAL_OUTPUT');
  const missingClockOrigin=contract.digest(JSON.stringify(['producer-transition-v2',['repeat',after.producer.output,null],0]));
  console.log('NATIVE_EFFECT_ORIGIN_MATCH '+JSON.stringify({missingClockOrigin,matched:after.requests.filter(row=>row.origin===missingClockOrigin).length,lifetimeClients:pool.totalCount}));
  assert(after.requests.every(r=>r.state==='accepted'&&!r.payload.clear));assert(after.requests.every(r=>contract.sameEffect(r.payload,before.requests[0].payload)));
  assert.equal(after.requests.length,before.requests.length,'NATIVE_IDENTICAL_RECOVERY_MUST_NOT_CREATE_EARLY_REPEAT');assert.equal(after.producer.repeatAt,before.producer.repeatAt);
 });
 it('still accepts exactly one genuine due repeat after the unavailable-model gap',async function(){
  const before=await initial(),barrier=latch();clock+=1000;const next=await worker({barrier});next.consumer.start();await next.consumer.flush(A);
  clock=before.producer.repeatAt;barrier.resolve();await until(()=>next.runtime.health([A]).tenants[0].ready);await next.consumer.flush(A);const after=await snapshot();trace('genuine-due-recovery',after);
  assert.equal(after.requests.length,2);assert(after.requests.every(r=>r.state==='accepted'));assert.equal(after.producer.repeatAt,clock+60000);
 });
});
