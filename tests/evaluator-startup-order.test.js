'use strict';
// Actual preview and clinical scheduler with recording dependency ports only.
// No native PostgreSQL, child process, listener or external effect proof.
const assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module');
const scope=require('../lib/storage/tenant-scope');
const A='11111111-1111-4111-8111-111111111111',identity='a'.repeat(64);
const deferred=()=>{let resolve,reject;const promise=new Promise((ok,no)=>{resolve=ok;reject=no;});return {promise,resolve,reject};};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({assignedTenants,startupError,platformVerification=false,futureDue=false,holdAdmission=false,pgstreamEnabled=true,partitioned=false,sourceTransform=text=>text,pendingRace=false,notificationStartup=false,consumerTransform=text=>text,runtimeFactory=require('../lib/server/serve/evaluator-runtime')}={}){
 const producerEntered=deferred(),producerRelease=deferred(),consumerTimers=[],notificationFiles=notificationStartup?require('./fixtures/tenant-notifications')():null;
 const prepare=deferred(),admission=deferred(),evaluating=deferred(),finishCycle=deferred(),trace=[],current={tenant:A,identity,env:{settings:{language:'en'}},settingsVersion:1,policyGeneration:1,sourceIdentity:'source'};
 const completions=[];let selectedAssignment,registryFollowed=false;let commitWake,receive,notificationConsumer,schemaEvent;let peerClosed=0;let schemaAvailable=true;let runtime,output,evaluatingEntered=false,cycle=0,revision=0,closed=false,started=false,delivered=0,componentClosed=false,checks=0;
 const connection={async end(){closed=true;}};
 const metadata=new Map([[A,{settings:1,policy:1,activity:{state:'active'},signature:{stamp:1,deleted:0}}]]);
 const scan=async()=>metadata;scan.state=()=>({available:true,generation:1});
 const reader={scan,current:t=>metadata.get(t),state:scan.state,async close(){},health:()=>({available:true})};
 const startup={async warm(){},isReady:()=>true,async ensure(){trace.push('tenant-admitted');},async close(){},health:()=>({})};
 const readiness=async()=>{checks++;if(holdAdmission)await admission.promise;};readiness.provisionTenant=async()=>{};
 let store={begin:async()=>({clock:'1'}),complete:async(tenant,value)=>{assert(checks>0);revision++;output={tenant,identity,inputCheckpoint:value.result.checkpoint,contentDigest:notificationStartup?require('../lib/server/serve/evaluator-runtime').contentDigest(value.result):'digest'+revision,outputRevision:revision,result:value.result};trace.push('completed');commitWake?.({tenant,kind:'complete'});return {output,changed:true};},work:async()=>[],nextDue:async()=>null,deliveries:async()=>[]};
 if(pendingRace){
  // Actual receipt/completion modules; the SQL/backend port alone is synthetic.
  const work=require('../lib/pgstream/work-state');
  const row={tenant:A,work_version:2,work_observed:[null,'1',null,null,null,null],work_completed:[null,null,null,null,null,null],work_observed_at:[null,Date.now(),null,null,null,null],work_pending_at:Date.now(),work_due_at:null,work_enabled:true,work_activity_enabled:true,work_lifecycle_enabled:true,delivery_revision:'0',delivery_ack_revision:'0',output_identity:null,output_digest:null,output_revision:'0',output_restore_generation:null};
  if(futureDue){row.work_completed=[...row.work_observed];row.work_pending_at=null;row.work_due_at=Date.now()+50;}
  const snapshot=()=>structuredClone(row);
  const sql={async query(text,args){
   if(text.startsWith('SELECT projection'))return {rows:[{output:row.projection?.[0]?.output}]};
   if(text.includes('min(work_due_at)'))return {rows:[{due:row.work_due_at}]};
   if(text.includes('delivery_revision>delivery_ack_revision'))return {rows:[]};
   if(text.startsWith('SELECT'))return {rows:text.includes('work_due_at<=$2')&&row.work_pending_at===null&&(row.work_due_at===null||Number(row.work_due_at)>args[1])?[]:[snapshot()]};
   if(text.startsWith('WITH input')){const patch=JSON.parse(args[1])[0];Object.assign(row,{work_observed:patch.observed,work_observed_at:patch.observed_at,work_pending_at:patch.pending_at});return {rowCount:1};}
   if(text.startsWith('UPDATE')){Object.assign(row,{work_completed:args[3],work_due_at:args[4],work_pending_at:args[5],work_completed_at:args[6],output_identity:args[7],output_digest:args[8],output_revision:String(args[9]),output_restore_generation:args[10]});if(args[12])row.projection=JSON.parse(args[12]);completions.push(snapshot());return {rowCount:1};}
   throw Error('UNEXPECTED_SYNTHETIC_SQL '+text);
  }};
  const backend={...connection,query:sql.query,readOnly:sql.query,holdAdvisoryLock:async()=>({available:true,withTenant:async(tenant,fn)=>fn(),close:async()=>{}}),observeEvaluatorTyped:options=>work.observeInTransaction({client:sql,...options})};
  store=require('../lib/pgstream/typed-checkpoint').create({connection:backend,namespace:'synthetic_checkpoint',consumer:'evaluator-test',maxBytes:100000,timeIntervalMs:60000});row.contract_digest=store.digest;
  const owned=store.own(()=>{}),begin=store.begin;store={...store,begin:async tenant=>{await owned;return begin(tenant);},snapshot};
 }
 const filename=require.resolve('../lib/server/serve/evaluator-preview'),loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=module.paths;
 const fakeEvaluator=()=>({async evaluate({at}){assert(trace.includes('tenant-admitted'));if(pendingRace&&cycle===0){evaluatingEntered=true;evaluating.resolve();await finishCycle.promise;}return {now:at,checkpoint:1,signature:{stamp:1,deleted:0},properties:{syntheticCycle:++cycle},emitted:notificationStartup?[require('./fixtures/tenant-notifications').notification()]:[],requested:notificationStartup?[{...require('./fixtures/tenant-notifications').notification(),kind:'notify'}]:[],due:{dueAt:pendingRace?Date.now()+3600000:null,slow:[]}};},close(){componentClosed=true;}});fakeEvaluator.domains=['entries'];
 const mocks={
  'pg':{Client:class {async connect(){} async end(){} async query(){return {rows:[{systemid:'123',timeline:1,dbname:'synthetic'}]};}}},
  '../../pgstream/snapshot-recovery':{lockKey:()=> '123',create:()=>({close:async()=>{}})},
  './evaluator-runtime':async options=>{runtime=await runtimeFactory(options);return runtime;},
  '../../storage/postgres-connection':Object.assign(async()=>connection,{readopt:async()=>{}}),
  '../../storage/postgres-durable-replay':()=>({configureStream(){},invalidateStream:async()=>{},acceptClinical:async()=>{throw Error('CLINICAL_INPUT_OUTSIDE_STARTUP_FIXTURE');}}), '../../data/tenant-projection-evaluator':fakeEvaluator,
  './evaluator-readiness':readiness,
  './platform-verification':{operationProfileDigest:require('../lib/server/serve/platform-verification').operationProfileDigest,guard:async()=>({ready:()=>true,verify:async()=>{},health:()=>({ready:true}),close:async()=>{}})},
  '../../pool-membership':{member:async()=>({configured:{mode:'standalone'},async register(){trace.push('member-registered');},async close(){}})},
  './evaluator-pool':{create:()=>({partitioned:false,start(){},async refresh(){},admits:()=>true,close(){}})},
  '../../trusted-worker/postgres':{create:()=>reader},
  '../../trusted-worker/lifecycle':async()=>({version:()=>1,activateRefresh(){},async close(){}}),
  '../internal-api/clients':{completedOutput:()=>({hintCompletedOutput:async()=>{}})},
  '../../pgstream/evaluator':{open:async({onCommit,onInput,schemaStartup,assignment})=>{if(startupError)throw startupError;selectedAssignment=assignment;schemaEvent=held=>schemaStartup.schema(async()=>{schemaAvailable=false;trace.push('schema-event');await held;schemaAvailable=true;});commitWake=onCommit;receive=require('../lib/pgstream/receiver').create({routes:[{schema:'synthetic_settings',table:'tenant_settings',kind:'settings'}],store,onInput,onSchema:async()=>{},clinical:{maxTransactionRows:10,maxTransactionBytes:10000,acceptTransaction:async(envelope,{observations})=>(await store.observeMany(observations)).map((row,index)=>({...row,tenant:observations[index].tenant}))}});return {store,ready:async()=>{},assertAvailable(){if(!schemaAvailable)throw Error('EVALUATOR_FEED_UNAVAILABLE');},health:()=>({}),close:async()=>{}};}},
  './registry-tenant-set':{open:async()=>{trace.push('registry-open');return {tenants:new Map([[A,current]]),isActive:()=>true,follow:async()=>{registryFollowed=true;},close:async()=>{},revision:()=>1,stats:()=>({})};}},
  './tenant-startup':{create:()=>startup,limited:require('../lib/server/serve/tenant-startup').limited},
  './evaluator-consumers':{async prepare({current:read,operationWindow,jobContext,assertOperational}){trace.push('delivery-prepare');await prepare.promise;assertOperational();return {async wake(){},revised(){if(read(A))delivered++;},start(){started=true;this.dispatch=jobContext.run(()=>operationWindow.run(A,()=>{if(read(A))delivered++;}));},async close(){await this.dispatch;},health:()=>({})};}},
  './evaluator-inspection':()=>()=>({}), '../../language':()=>({set(){}})
 };
 if(notificationStartup){
  const file=require.resolve('../lib/server/serve/evaluator-consumers'),consumerModule=new Module(file,module);consumerModule.filename=file;consumerModule.paths=module.paths;
  let firstSelection=true;
  const notificationStore={...notificationFiles.store,
   own:async()=>{trace.push('notification-owner-initializing');await prepare.promise;trace.push('notification-owner-ready');},
   consume:async input=>{if(firstSelection){firstSelection=false;producerEntered.resolve();await producerRelease.promise;}return notificationFiles.store.consume(input);}
  };
  const overrides={
   '../../storage/postgres-connection':async()=>({end:async()=>{}}),
   '../../tenant-notifications/postgres':()=>notificationStore,
   '../../tenant-alarms/postgres':{createReader:()=>require('./fixtures/tenant-alarm-protocol')().reader},
   './evaluator-consumer-readiness':{sameDatastore:async()=>{},suppression:async()=>{},operational:async()=>{}},
   '../realtime/alarm-transport':{createSliceAdapter:()=>({send:(request,callback)=>{assert(trace.includes('notification-owner-ready'),'NOTIFICATION_OWNER_MUST_BE_READY_BEFORE_SEND');notificationFiles.hooks.adapter.send(request,callback);}})}
  };
  consumerModule.require=name=>Object.hasOwn(overrides,name)?overrides[name]:Module.prototype.require.call(consumerModule,name);
  // Existing cadences may be installed; none is fired by this startup witness.
  const interval=(fn,ms)=>{const timer={fn,ms};consumerTimers.push(timer);return timer;};
  const source=consumerTransform(fs.readFileSync(file,'utf8'));
  require('node:vm').runInThisContext('(function(require,module,exports,setInterval,clearInterval){'+source+'\n})',{filename:file})(consumerModule.require.bind(consumerModule),consumerModule,consumerModule.exports,interval,()=>{});
  mocks['./evaluator-consumers']={prepare:async options=>{trace.push('delivery-prepare');notificationConsumer=await consumerModule.exports.prepare(options);return notificationConsumer;}};
 }
 loaded.require=name=>Object.hasOwn(mocks,name)?mocks[name]:Module.prototype.require.call(loaded,name);
 loaded._compile(sourceTransform(fs.readFileSync(filename,'utf8')),filename);
 const window=require('./fixtures/operation-window-runtime-protocol')({trustedWorker:true}).window;
 const config={...(platformVerification?{platformVerification:{namespace:'synthetic_verification',role:'evaluator'}}:{}),partition:{kind:'evaluator',partitioned},registry:{namespace:'synthetic_registry'},pgstream:pgstreamEnabled?{generation:'a'.repeat(32),transactionRows:10000,recovery:{connectionString:'synthetic',timeoutMs:1000,maxQueued:1},receiver:{maxBytes:10000},outputPeer:{},bounds:{recoveryMs:1000,pendingMs:1000}}:undefined,trustedWorker:{activity:'synthetic_activity'},consumers:{realtime:notificationStartup?{outbox:{connectionString:'synthetic',namespace:'notification_test',maxRows:10,maxBytes:65536,maxConnections:2},suppression:{connectionString:'synthetic',namespace:'alarm_protocol',maxRows:10,maxBytes:65536,maxConnections:2},route:{id:'synthetic'},maxPayloadBytes:10000,maxInflight:2,attemptTimeoutMs:1000,retryDelayMs:100,pollIntervalMs:100,retryIntervalMs:200}:{slicePeers:{close(){peerClosed++;}}}},tenants:new Map([[A,current]]),connectionString:'synthetic',
  namespaces:{entries:'synthetic_entries',checkpoint:'synthetic_checkpoint'},consumer:'evaluator-test',maxTenants:1,maxRows:10,maxBytes:10000,pageSize:10,
  timeIntervalMs:60000,readCurrent:async()=>current};
 return {schema:held=>schemaEvent(held),prepare,admission,trace,window,evaluating,finishCycle,completions,producerEntered,producerRelease,consumerTimers,notificationFiles,consumer:()=>notificationConsumer,acquire:()=>runtime.acquire(A),snapshot:()=>store.snapshot?.(),async hint(version='1'){await receive(require('./lib/clinical-stream-native').envelope([{action:'U',xid:42,lsn:'0/20',schema:'synthetic_settings',table:'tenant_settings',columns:[{name:'tenant_id',value:A},{name:'version',value:version}]}]));},async boot(){await window.ready();return loaded.exports.boot(config,{operationWindow:window,assignedTenants});},state:()=>({selectedAssignment,registryFollowed,output,evaluatingEntered,clinical:runtime?.health([A]).tenants[0],closed,started,delivered,componentClosed,checks,peerClosed})};
}
function delayScheduler(source){const a=source.indexOf('    {\n      workScheduler=require('),b=source.indexOf("    await schemaStartup.prepare(",a),c=source.indexOf('    if (consumers) {',b);assert(a>=0&&b>a&&c>b);return source.slice(0,a)+source.slice(b,c)+source.slice(a,b)+source.slice(c);}
const pgstreamEnabled=true;describe('maintained clinical startup independent of delivery roster preparation',function(){
 let prior;beforeEach(()=>{prior=scope.getTenancyMode();});afterEach(()=>scope.setTenancyMode(prior));
 it('binds the fixed assigned roster to the same clinical runtime and refuses an unprovisioned neighbor',async()=>{
  const f=fixture({assignedTenants:[A]});f.prepare.resolve();let service;
  try{service=await f.boot();assert.deepEqual(f.state().selectedAssignment.tenants,[A]);assert.equal(f.state().registryFollowed,false,'FIXED_ASSIGNMENT_REQUIRES_RESTART_TO_CHANGE_ROSTER');for(let n=0;n<60&&!f.state().clinical.ready;n++)await settle();assert.equal(f.state().clinical.ready,true);}finally{await service?.close();await f.window.close();}
  const bad=fixture({assignedTenants:['22222222-2222-4222-8222-222222222222']});bad.prepare.resolve();
  try{await assert.rejects(bad.boot(),error=>error.cause?.message==='EVALUATOR_ASSIGNMENT_NOT_PROVISIONED');assert.equal(bad.state().selectedAssignment,undefined);}finally{await bad.window.close();}
 });
 it('selected lazy startup recovers accepted pending and future due work without a fresh input, with a lost-recovery control',async function(){
  this.timeout(10000);
  async function criterion({sourceTransform=text=>text,futureDue=false}={}){
   const f=fixture({platformVerification:true,pendingRace:true,futureDue,sourceTransform});f.prepare.resolve();let service;
   try{
    service=await f.boot();
    for(let n=0;n<80&&!f.state().evaluatingEntered;n++){await new Promise(resolve=>setTimeout(resolve,2));}
    assert(f.state().evaluatingEntered,futureDue?'FUTURE_DUE_MUST_RECOVER_WITHOUT_FRESH_INPUT':'ACCEPTED_PENDING_MUST_RECOVER_WITHOUT_FRESH_INPUT');
    f.finishCycle.resolve();
    for(let n=0;n<80&&!f.completions.length;n++)await settle();
    assert(f.completions.length>0,'RECOVERED_WORK_MUST_COMMIT_COMPLETED_OUTPUT');
    assert.equal(f.completions[0].work_pending_at,null);assert.equal(f.completions[0].output_revision,'1');
    assert.equal(f.completions[0].work_completed[1],'1');
    assert.equal(f.snapshot().work_pending_at,null);
    assert.equal(f.state().clinical.progress.failedCompletions,0);
   }finally{f.finishCycle.resolve();await service?.close();await f.window.close();}
  }
  const removeRecovery=text=>{const needle='      workScheduler.recover().catch(()=>{});';assert.equal(text.split(needle).length,2);return text.replace(needle,'');};
  await assert.rejects(criterion({sourceTransform:removeRecovery}),/ACCEPTED_PENDING_MUST_RECOVER_WITHOUT_FRESH_INPUT/);
  await criterion();
  await assert.rejects(criterion({sourceTransform:removeRecovery,futureDue:true}),/FUTURE_DUE_MUST_RECOVER_WITHOUT_FRESH_INPUT/);
  await criterion({futureDue:true});
 });
 it('refuses evaluator pool max one before constructing a zero-slot scheduler',async()=>{
  const prior=process.env.NS_POOL_EVALUATOR_MAX;process.env.NS_POOL_EVALUATOR_MAX='1';const f=fixture();
  try{await assert.rejects(f.boot(),error=>error.cause?.message==='PGSTREAM_EVALUATOR_POOL_BOUND');assert.equal(f.state().clinical,undefined);}
  finally{if(prior===undefined)delete process.env.NS_POOL_EVALUATOR_MAX;else process.env.NS_POOL_EVALUATOR_MAX=prior;await f.window.close();}
 });
 it('completes clinical work while delivery prepares and start sweep recovers the early revision',async()=>{
  const f=fixture({pgstreamEnabled});let service;const boot=f.boot();boot.catch(()=>{});
  try{for(let n=0;n<30&&!f.trace.includes('delivery-prepare');n++)await settle();for(let n=0;n<30&&!f.state().clinical?.ready;n++)await settle();
   assert(f.state().clinical?.ready,'CLINICAL_PROGRESS_MUST_NOT_WAIT_FOR_DELIVERY_PREPARE');assert.equal(f.state().started,false);assert.equal(f.state().delivered,0);
   f.prepare.resolve();service=await boot;for(let n=0;n<30&&!f.state().delivered;n++)await settle();assert(f.state().delivered>0,'START_SWEEP_MUST_RECOVER_EARLY_REVISION');
   const sent=f.state().delivered;await service.acquire(A);assert(f.state().delivered>sent,'LATER_REVISIONS_MUST_REACH_CURRENT_CONSUMERS');
  }finally{f.prepare.resolve();service=service||await boot.catch(()=>null);await service?.close();await f.window.close();}
 });
 it('reconciles alarming revisions before and during producer startup exactly once without firing a cadence',async function(){
  this.timeout(5000);
  async function criterion(consumerTransform=text=>text){
   const f=fixture({notificationStartup:true,consumerTransform}),boot=f.boot();boot.catch(()=>{});let service;
   try{
    for(let n=0;n<60&&!f.state().clinical?.ready;n++)await settle();
    assert(f.trace.includes('notification-owner-initializing'));assert(f.state().clinical?.ready);
    await f.acquire(); // A revised alarming output commits while ownership initializes.
    assert.equal(f.notificationFiles.effects.length,0);
    f.prepare.resolve();service=await boot;
    // Mutation lacks the startup sweep, so it never enters a producer selection.
    for(let n=0;n<60&&!f.consumer().health().tenants[0].passes;n++)await settle();
    assert(f.consumer().health().tenants[0].passes>0,'STARTUP_MUST_RECONCILE_UNOBSERVED_ALARM_REVISION');
    await f.producerEntered.promise;
    const captured=f.state().output.contentDigest;
    await f.acquire(); // Revision changes after producer captures its initial source.
    assert.notEqual(f.state().output.contentDigest,captured,'STARTUP_CONTROL_MUST_CHANGE_CLINICAL_CONTENT');
    f.producerRelease.resolve();await f.consumer().flush(A);
    assert.equal(f.notificationFiles.effects.length,1,'STARTUP_ALARM_MUST_DELIVER_EXACTLY_ONCE');
    const requests=f.notificationFiles.snapshot().requests;assert.equal(requests.length,1);assert.equal(requests[0].state,'accepted');
    const persisted=f.notificationFiles.producerStates()[0];
    assert.deepEqual(persisted.producer.output,[identity,f.state().output.contentDigest,1],'PRODUCER_MUST_RECONCILE_CURRENT_CONTENT');
    assert.deepEqual(f.consumerTimers.map(timer=>timer.ms),[100,200],'NO_NEW_BACKSTOP_OR_STARTUP_TIMER');
    await f.consumer().recover();await f.consumer().flush(A);assert.equal(f.notificationFiles.effects.length,1,'RECONCILED_ALARM_MUST_NOT_DUPLICATE');
   }finally{f.producerRelease.resolve();f.prepare.resolve();service=service||await boot.catch(()=>null);await service?.close();await f.window.close();}
  }
  await assert.rejects(criterion(source=>{const needle="      sweep('start', 'run', tenants);";assert.equal(source.split(needle).length,2);return source.replace(needle,'');}),/STARTUP_MUST_RECONCILE_UNOBSERVED_ALARM_REVISION/);
  await criterion();
 });
 it('keeps input arriving during computation pending, with a completion-time recapture control',async()=>{
  const control=require('./lib/clinical-working-set/control');
  const late=control('../lib/server/serve/evaluator-runtime',
   'await durable.complete(state.tenant, { observed,','await durable.complete(state.tenant, { observed:await durable.begin(state.tenant),');
  const verify=async runtimeFactory=>{
   const f=fixture({pendingRace:true,runtimeFactory}),boot=f.boot().catch(error=>({error}));let service;
   try{
    await f.evaluating.promise;await f.hint('2');f.finishCycle.resolve();
    for(let n=0;n<60&&!f.completions.length;n++)await settle();
    const saved=f.completions[0];
    assert.equal(saved?.work_observed[1],'2');
    assert.equal(saved.work_completed[1],'1','EVALUATOR_CERTIFIED_UNREAD_INPUT');
    assert.notEqual(saved.work_pending_at,null);
   } finally {
    f.finishCycle.resolve();f.prepare.resolve();service=await boot;
    await service?.close?.();await f.window.close();
   }
  };
  await verify();
  await assert.rejects(verify(late),/EVALUATOR_CERTIFIED_UNREAD_INPUT/);
  await verify();
 });
 it('reconciles a genuine pending hint during boot; delayed-scheduler control is red and restored source passes',async function(){
  this.timeout(10000);
  async function criterion(sourceTransform=text=>text,version='1'){
  const f=fixture({pendingRace:true,sourceTransform}),boot=f.boot();boot.catch(()=>{});let service;
  try{
   for(let turn=0;turn<60&&!f.state().evaluatingEntered;turn++)await settle();
   assert(f.state().evaluatingEntered,'CLINICAL_STARTUP_SCHEDULER_MUST_PRECEDE_DELIVERY');
   for(let n=0;n<30&&!f.trace.includes('delivery-prepare');n++)await settle();
   assert(f.trace.includes('delivery-prepare'));
   await f.hint(version); // Genuine pending replay or a newer target; neither is completed.
   f.finishCycle.resolve();
   for(let n=0;n<60&&!f.completions.length;n++)await settle();
   assert(f.completions.length);assert.equal(f.completions[0].work_completed[1],'1');
   if(version==='1')assert.equal(f.completions[0].work_pending_at,null);
   else {assert.equal(f.completions[0].work_observed[1],'2');assert.notEqual(f.completions[0].work_pending_at,null,'NEWER_DURABLE_TARGET_MUST_REMAIN_PENDING');}
   f.prepare.resolve();service=await boot;
   await new Promise(resolve=>setTimeout(resolve,1100));
   assert.equal(f.state().clinical.code,null,'COMPLETED_STARTUP_HINT_MUST_NOT_LEAVE_STALE_RAM_PENDING');
   assert.equal(f.state().clinical.ready,true,'COMPLETED_STARTUP_HINT_MUST_NOT_LEAVE_STALE_RAM_PENDING');
   assert.equal(f.state().clinical.code,null);assert.equal(f.snapshot().work_pending_at,null);
   const completed=f.state().clinical.cycles;await f.hint(version);await settle();assert.equal(f.state().clinical.cycles,completed,'COMPLETED_REPLAY_MUST_NOT_SCHEDULE_WORK');
  }finally{f.finishCycle.resolve();f.prepare.resolve();service=service||await boot.catch(()=>null);await service?.close();await f.window.close();}
  }
  await assert.rejects(criterion(delayScheduler),/CLINICAL_STARTUP_SCHEDULER_MUST_PRECEDE_DELIVERY/);
  await criterion();
  // Newer durable input remains owed on the one current startup scheduler;
  // the deliberately delayed obsolete composition is never a valid baseline.
  await criterion(text=>text,'2');
 });
 it('retains only allowlisted actual source-admission codes in the boot refusal; removed propagation is red',async()=>{
  const generic='evaluator preview readiness or initialization refused';
  async function criterion(code,sourceTransform=text=>text){
   const original=Object.assign(new Error('DO_NOT_EMIT_PRIVATE_BOOT_DETAIL'),{code}),f=fixture({startupError:original,sourceTransform});
   try{
    await assert.rejects(f.boot(),error=>{
     const known=['PGSTREAM_REBOOTSTRAP_REQUIRED','PGSTREAM_SOURCE_REFUSED'].includes(code);
     assert.equal(error.message,generic+(known?' ('+code+')':''),'ALLOWLISTED_EVALUATOR_BOOT_CAUSE_REQUIRED');
     assert.equal(error.cause,original,'ORIGINAL_CAUSE_REMAINS_PRIVATE');
     assert(!error.message.includes('DO_NOT_EMIT_PRIVATE_BOOT_DETAIL'));
     return true;
    });
    assert.equal(f.state().closed,true,'REFUSED_BOOT_STILL_CLOSES_CONNECTION');
    assert.equal(f.state().started,false);assert.equal(f.state().output,undefined);
   }finally{await f.window.close();}
  }
  const remove=text=>{const needle="    const startupCause = ['PGSTREAM_REBOOTSTRAP_REQUIRED', 'PGSTREAM_SOURCE_REFUSED'].includes(error?.code) ? error.code : null;";assert.equal(text.split(needle).length,2);return text.replace(needle,'    const startupCause = null;');};
  await criterion('PGSTREAM_REBOOTSTRAP_REQUIRED');
  await assert.rejects(criterion('PGSTREAM_REBOOTSTRAP_REQUIRED',remove),/ALLOWLISTED_EVALUATOR_BOOT_CAUSE_REQUIRED/);
  for(const code of ['PGSTREAM_REBOOTSTRAP_REQUIRED','PGSTREAM_SOURCE_REFUSED','UNKNOWN_PRIVATE_CODE','PGSTREAM_SOURCE_REFUSED PRIVATE_BOOT_DETAIL',undefined])await criterion(code);
 });
 it('closes the partial clinical runtime when delivery preparation refuses and never starts effects',async()=>{
  const f=fixture({pgstreamEnabled}),boot=f.boot();boot.catch(()=>{});
  try{for(let n=0;n<60&&!f.state().clinical?.ready;n++)await settle();assert(f.state().clinical?.ready,'PARTIAL_RUNTIME_MUST_EXIST_FOR_FAILURE_CONTROL');f.prepare.reject(Error('DELIVERY_PREPARE_REFUSED'));await assert.rejects(boot,/readiness or initialization refused/);
   assert.equal(f.state().closed,true);assert.equal(f.state().componentClosed,true);assert.equal(f.state().started,false);assert.equal(f.state().delivered,0);
  }finally{f.prepare.resolve();const service=await boot.catch(()=>null);await service?.close();await f.window.close();}
 });
 it('does not start clinical work before unconditional admission succeeds',async()=>{
  const f=fixture({holdAdmission:true,pgstreamEnabled}),boot=f.boot();boot.catch(()=>{});
  try{await settle();await settle();assert.equal(f.state().output,undefined);assert(!f.trace.includes('tenant-admitted'));f.admission.reject(Error('CATALOGUE_REFUSED'));await assert.rejects(boot,/readiness or initialization refused/);assert.equal(f.state().started,false);}
  finally{f.prepare.resolve();const service=await boot.catch(()=>null);await service?.close();await f.window.close();}
 });
 it('refuses a missing maintained transport instead of starting a legacy discovery stack',async()=>{const f=fixture({pgstreamEnabled:false});try{await assert.rejects(f.boot(),/maintained pgstream evaluator configuration required/);assert.equal(f.state().output,undefined);}finally{await f.window.close();}});

 it('refuses direct unsupported boot before registry, readiness, or member registration effects; removing the guard goes red',async()=>{const needle="  if(config.partition?.partitioned)require('./evaluator-config').assertSupportedPartition(config.partition);";async function criterion(sourceTransform){const f=fixture({partitioned:true,sourceTransform});let service;try{f.prepare.resolve();try{service=await f.boot();assert.fail('unsupported boot must refuse');}catch(error){assert.equal(error.code,'PGSTREAM_EVALUATOR_PARTITION_UNQUALIFIED');}assert.deepEqual(f.trace,[],'UNSUPPORTED_PARTITION_MUST_NOT_OPEN_RESOURCES');assert.equal(f.state().checks,0);}finally{await service?.close();await f.window.close();}}await assert.rejects(criterion(text=>{assert(text.includes(needle));return text.replace(needle,'');}));await criterion(text=>text);});

});

async function previewSchemaCriterion(sourceTransform=text=>text){
 const f=fixture({sourceTransform}),verification=deferred();let service,event;const boot=f.boot();boot.catch(()=>{});
 try{
  for(let n=0;n<60&&!f.trace.includes('delivery-prepare');n++)await settle();assert(f.trace.includes('delivery-prepare'));
  event=f.schema(verification.promise);await settle();assert(f.trace.includes('schema-event'));
  f.prepare.resolve();await settle();verification.resolve();
  try{service=await boot;}catch{assert.fail('PREVIEW_MUST_RECOVER_SCHEMA_INTERRUPTED_PREPARATION');}
  await event;assert.equal(f.trace.filter(row=>row==='delivery-prepare').length,2);
 }finally{f.prepare.resolve();verification.resolve();service=service||await boot.catch(()=>null);await event;await service?.close();await f.window.close();}
}
describe('actual preview startup schema boundary',()=>{
 let prior;beforeEach(()=>{prior=scope.getTenancyMode();});afterEach(()=>scope.setTenancyMode(prior));
 it('reconciles consumer construction interrupted by the receiver schema gate',()=>previewSchemaCriterion());
 it('control: omitted preview preparation gate goes red and restored source passes',async()=>{
  await assert.rejects(previewSchemaCriterion(text=>text.replace('await schemaStartup.prepare(async () => {','await (async () => {').replace('    });\n    if (consumers)', '    })();\n    if (consumers)')),/PREVIEW_MUST_RECOVER_SCHEMA_INTERRUPTED_PREPARATION/);
  await previewSchemaCriterion();
 });
});

async function previewPeerOwnerCriterion(sourceTransform=text=>text){
 const f=fixture({sourceTransform});let service;try{f.prepare.resolve();service=await f.boot();await service.close();await service.close();assert.equal(f.state().peerClosed,1,'PREVIEW_MUST_CLOSE_CONFIGURATION_PEER_ONCE');}finally{await service?.close();await f.window.close();}
}
describe('preview configuration transport ownership',()=>{
 let prior;beforeEach(()=>{prior=scope.getTenancyMode();});afterEach(()=>scope.setTenancyMode(prior));
 it('closes an optional shared private peer resource exactly once after consumer drain',()=>previewPeerOwnerCriterion());
 it('control: omitted final private peer close goes red; restored source passes',async()=>{await assert.rejects(previewPeerOwnerCriterion(text=>text.replace('config.consumers?.realtime?.slicePeers?.close?.();','')),/PREVIEW_MUST_CLOSE_CONFIGURATION_PEER_ONCE/);await previewPeerOwnerCriterion();});
});
