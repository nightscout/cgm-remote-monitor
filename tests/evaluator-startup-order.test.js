'use strict';
// Actual preview and clinical scheduler with recording dependency ports only.
// No native PostgreSQL, child process, listener or external effect proof.
const assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module');
const scope=require('../lib/storage/tenant-scope');
const A='11111111-1111-4111-8111-111111111111',identity='a'.repeat(64);
const deferred=()=>{let resolve,reject;const promise=new Promise((ok,no)=>{resolve=ok;reject=no;});return {promise,resolve,reject};};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({registryRace,clinicalTenants=0,assignedTenants,sourceBlocked=false,startupError,streamErrors={},registryError,cleanupError,platformVerification=false,futureDue=false,holdAdmission=false,pgstreamEnabled=true,partitioned=false,sourceTransform=text=>text,pendingRace=false,notificationStartup=false,consumerTransform=text=>text,runtimeFactory=require('../lib/server/serve/evaluator-runtime')}={}){
 const producerEntered=deferred(),producerRelease=deferred(),consumerTimers=[],notificationFiles=notificationStartup?require('./fixtures/tenant-notifications')():null;
 const prepare=deferred(),admission=deferred(),evaluating=deferred(),finishCycle=deferred(),trace=[],current={tenant:A,identity,env:{settings:{language:'en'}},settingsVersion:1,policyGeneration:1,sourceIdentity:'source'};
 const completions=[];let selectedAssignment,registryFollowed=false;let commitWake,receive,notificationConsumer,blockSource;let peerClosed=0;let schemaAvailable=true;let runtime,output,evaluatingEntered=false,cycle=0,revision=0,closed=false,started=false,delivered=0,componentClosed=false,checks=0;
 const streamTrace=[];
 function streamStep (step) {
  streamTrace.push(step);
  if (Object.hasOwn(streamErrors, step)) throw streamErrors[step];
 }
 const connection={async end(){closed=true;if(cleanupError)throw cleanupError;}};
 const metadata=new Map([[A,{settings:1,policy:1,activity:{state:'active',version:'1',paused:false,suspended:false},signature:{stamp:1,deleted:0}}]]);
 const scan=async()=>metadata;scan.state=()=>({available:true,generation:1});
 const reader={scan,current:t=>metadata.get(t),state:scan.state,async close(){},health:()=>({available:true})};
 const startup={addTenant(tenant){trace.push('startup-add:'+tenant);},async warm(){},isReady:()=>true,async ensure(){trace.push('tenant-admitted');},async close(){},health:()=>({})};
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
  const backend={...connection,query:sql.query,readOnly:sql.query,admitEvaluatorTyped:async({tenants})=>{trace.push(['admit',...tenants]);},holdAdvisoryLock:async()=>({available:true,withTenant:async(tenant,fn)=>fn(),close:async()=>{}}),observeEvaluatorTyped:options=>work.observeInTransaction({client:sql,...options})};
  store=require('../lib/pgstream/typed-checkpoint').create({connection:backend,namespace:'synthetic_checkpoint',consumer:'evaluator-test',maxBytes:100000,timeIntervalMs:60000});row.contract_digest=store.digest;
  const owned=store.own(()=>{}),begin=store.begin;store={...store,begin:async tenant=>{await owned;return begin(tenant);},snapshot};
 }
 const filename=require.resolve('../lib/server/serve/evaluator-preview'),loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=module.paths;
 const fakeEvaluator=()=>({async evaluate({at}){assert(trace.includes('tenant-admitted'));if(pendingRace&&cycle===0){evaluatingEntered=true;evaluating.resolve();await finishCycle.promise;}return {now:at,checkpoint:1,signature:{stamp:1,deleted:0},properties:{syntheticCycle:++cycle},emitted:notificationStartup?[require('./fixtures/tenant-notifications').notification()]:[],requested:notificationStartup?[{...require('./fixtures/tenant-notifications').notification(),kind:'notify'}]:[],due:{dueAt:pendingRace?Date.now()+3600000:null,slow:[]}};},close(){componentClosed=true;}});fakeEvaluator.domains=['entries'];
 const mocks={
  'pg':{Client:class {
   async connect(){streamStep('connect');}
   async query(sql){assert.equal(sql,'IDENTIFY_SYSTEM');streamStep('identify');return {rows:[{systemid:'123',timeline:1,dbname:'synthetic'}]};}
   async end(){streamStep('close');}
  }},
  '../../pgstream/snapshot-recovery':{create:()=>{streamStep('recovery');return {lockKey:()=>'123',close:async()=>{}};}},
  './evaluator-runtime':async options=>{runtime=await runtimeFactory(options);return runtime;},
  '../../storage/postgres-connection':Object.assign(async()=>connection,{readopt:async()=>{}}),
  '../../storage/postgres-durable-replay':()=>({configureStream(){},invalidateStream:async()=>{},acceptClinical:async()=>{throw Error('CLINICAL_INPUT_OUTSIDE_STARTUP_FIXTURE');}}), '../../data/tenant-projection-evaluator':fakeEvaluator,
  './evaluator-readiness':readiness,
  // The role's one platform check is its unconditional startup admission.
  './platform-verification':require('./fixtures/platform-proof')(undefined,()=>readiness()),
  '../../pool-membership':{member:async()=>({configured:{mode:'standalone'},async register(){trace.push('member-registered');},async close(){}})},
  './evaluator-pool':{create:()=>({partitioned:false,start(){},async refresh(){},admits:()=>true,addTenant(){},close(){}})},
  '../../trusted-worker/postgres':{create:()=>reader},
  '../../trusted-worker/lifecycle':async()=>({version:()=>1,activateRefresh(){},async close(){}}),
  '../internal-api/clients':{completedOutput:()=>({hintCompletedOutput:async()=>{}})},
  '../../pgstream/evaluator':{open:async({onCommit,onInput,assignment,schemaStartup})=>{streamStep('open');if(startupError)throw startupError;if(schemaStartup!==undefined)throw Error('RETIRED_SCHEMA_STARTUP_OPTION');selectedAssignment=assignment;blockSource=()=>{schemaAvailable=false;trace.push('source-blocked');};commitWake=onCommit;receive=require('../lib/pgstream/receiver').create({routes:[{schema:'synthetic_settings',table:'tenant_settings',kind:'settings'}],store,onInput,onSchema:async()=>{},clinical:{maxTransactionRows:10,maxTransactionBytes:10000,acceptTransaction:async(envelope,{observations})=>(await store.observeMany(observations)).map((row,index)=>({...row,tenant:observations[index].tenant}))}});
    if (sourceBlocked) blockSource();
    return {store,async ready(){streamStep('ready');if(!schemaAvailable)throw Error('PGSTREAM_NOT_READY');},assertAvailable(){if(!schemaAvailable)throw Error('EVALUATOR_FEED_UNAVAILABLE');},health:()=>({}),close:async()=>{}};}},
  './registry-tenant-set':{openDemand:async()=>{
    const tenants=new Map(), provisioned=new Set([A,...Array.from({length:clinicalTenants-1},(_,i)=>'22222222-2222-4222-8222-'+String(i).padStart(12,'0'))]);
    return {tenants,async lookup(tenant){trace.push(['lookup',tenant]);if(!provisioned.has(tenant))return null;tenants.set(tenant,current);return current;},isActive:tenant=>tenants.has(tenant),onRemove(){},stats:()=>({}),revision:()=>1,async close(){}};
  },open:async()=>{trace.push('registry-open');if(registryError)throw registryError;return {tenants:new Map([[A,current]]),isActive:()=>true,follow:async()=>{registryFollowed=true;},close:async()=>{},revision:()=>1,stats:()=>({})};}},
  './tenant-startup':{create:()=>startup,limited:require('../lib/server/serve/tenant-startup').limited},
  './evaluator-consumers':{async prepare({current:read,operationWindow,jobContext,assertOperational}){streamTrace.push('delivery-prepare');trace.push('delivery-prepare');await prepare.promise;assertOperational();return {async wake(){},revised(){if(read(A))delivered++;},start(){started=true;this.dispatch=jobContext.run(()=>operationWindow.run(A,()=>{if(read(A))delivered++;}));},async close(){await this.dispatch;},health:()=>({})};}},
  './evaluator-inspection':()=>()=>({}), '../../language':()=>({set(){}})
 };
 if(clinicalTenants) mocks['./evaluator-consumers']={prepare:async()=>null};
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
 if (registryRace) {
  mocks['./registry-tenant-set'] = { openDemand: registryRace.open };
  mocks['./evaluator-consumers'] = { prepare: async () => null };
  reader.read = registryRace.settings;
  registryRace.activity = metadata.get(A).activity;
  // Addressed withdrawal drains through these role ports.
  const replay = mocks['../../storage/postgres-durable-replay']();
  mocks['../../storage/postgres-durable-replay'] = () => ({ ...replay, forgetTenant () {} });
  reader.remove = startup.removeTenant = () => {};
  const gate = mocks['./evaluator-pool'].create();
  mocks['./evaluator-pool'] = { create: () => ({ ...gate, removeTenant () {} }) };
 }
 loaded.require=name=>Object.hasOwn(mocks,name)?mocks[name]:Module.prototype.require.call(loaded,name);
 loaded._compile(sourceTransform(fs.readFileSync(filename,'utf8')),filename);
 const window=require('./fixtures/operation-window-runtime-protocol')({trustedWorker:true}).window;
 const config={...(platformVerification?{platformVerification:{namespace:'synthetic_verification',role:'evaluator'}}:{}),partition:{kind:'evaluator',partitioned},registry:{namespace:'synthetic_registry'},pgstream:pgstreamEnabled?{generation:'a'.repeat(32),transactionRows:10000,recovery:{connectionString:'synthetic',timeoutMs:1000,maxQueued:1},receiver:{maxBytes:10000},outputPeer:{},bounds:{recoveryMs:1000,pendingMs:1000}}:undefined,trustedWorker:{activity:'synthetic_activity'},consumers:{realtime:notificationStartup?{outbox:{connectionString:'synthetic',namespace:'notification_test',maxRows:10,maxBytes:65536,maxConnections:2},suppression:{connectionString:'synthetic',namespace:'alarm_protocol',maxRows:10,maxBytes:65536,maxConnections:2},route:{id:'synthetic'},maxPayloadBytes:10000,maxInflight:2,attemptTimeoutMs:1000,retryDelayMs:100,pollIntervalMs:100,retryIntervalMs:200}:{slicePeers:{close(){peerClosed++;}}}},tenants:new Map([[A,current]]),connectionString:'synthetic',
  namespaces:{entries:'synthetic_entries',checkpoint:'synthetic_checkpoint'},consumer:'evaluator-test',maxTenants:1,maxRows:10,maxBytes:10000,pageSize:10,
  timeIntervalMs:60000,readCurrent:async()=>current};
 if (registryRace) { config.tenantSettings = {}; delete config.consumers; }
 if(clinicalTenants)delete config.consumers;
 return {blockSource:()=>blockSource(),prepare,admission,trace,streamTrace,window,evaluating,finishCycle,completions,producerEntered,producerRelease,consumerTimers,notificationFiles,consumer:()=>notificationConsumer,acquire:()=>runtime.acquire(A),snapshot:()=>store.snapshot?.(),async hint(version='1'){await receive(require('./lib/clinical-stream-native').envelope([{action:'U',xid:42,lsn:'0/20',schema:'synthetic_settings',table:'tenant_settings',columns:[{name:'tenant_id',value:A},{name:'version',value:version}]}]));},async boot(){await window.ready();const booting=loaded.exports.boot(config,{operationWindow:window,assignedTenants});if(!platformVerification)(async()=>{for(let n=0;n<200&&!runtime;n++)await new Promise(resolve=>setImmediate(resolve));runtime?.acquire(A).catch(()=>{});})();return booting;},state:()=>({selectedAssignment,registryFollowed,output,evaluatingEntered,clinical:runtime?.health().tenants.find(row=>row.tenant===A),closed,started,delivered,componentClosed,checks,peerClosed})};
}
function delayScheduler(source){const a=source.indexOf('    {\n      workScheduler=require('),b=source.indexOf("    startupPhase = 'DELIVERY_STARTUP';\n    {\n      consumers = await",a),c=source.indexOf('    if (consumers) {',b);assert(a>=0&&b>a&&c>b);return source.slice(0,a)+source.slice(b,c)+source.slice(a,b)+source.slice(c);}
// Every evaluator is platform-verified and starts lazily (decision
// platform-application-boundary). Fixtures without the explicit verified flag
// model tenant A's addressed work arriving at startup: one clinical acquire.
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
 for (const transition of ['unrelated add', 'add during settings read', 'removal', 'removal during settings read', 'membership read refusal', 'registry poll refusal', 'policy override', 'paused', 'suspended']) {
  it('revalidates addressed completion authority across ' + transition, async () => {
   const neighbor = '22222222-2222-4222-8222-222222222222';
   const members = new Set([A]);
   let version = 1, pages = 0, registry, beforeSettings, override = false, refuseMembership = false, refusePoll = false;
   const registryRace = {
    async open (options) {
     const store = {
      async revision () { if (refusePoll) throw new Error('synthetic registry unavailable'); return String(version); },
      async page (cursor, limit) {
       if (refuseMembership) throw new Error('synthetic lookup unavailable');
       pages++;
       assert.equal(limit, 1);
       return { revision: String(version), tenants: [...members].sort().filter(id => id > cursor).slice(0, limit) };
      },
      async lookup () {}, async entry () {}
     };
     registry = await require('../lib/server/serve/registry-demand')({ ...options, store,
      settings: { maxTenants: 8, refreshMs: 2000 }, schedule: () => null, now: () => 1 });
     return registry;
    },
    async settings () {
     if (beforeSettings) { const apply = beforeSettings; beforeSettings = null; await apply(); }
     const generation = override ? 2 : 1;
     const overrides = override ? { DISPLAY_UNITS: { mode: 'pinned', pin: 'mmol' } } : {};
     return { ...require('../lib/tenant-settings/component').resolveEffectiveSettings({ version: 1, values: {} },
      { generation, deployment: {}, overrides }), policyGeneration: generation, readAt: 1 };
    }
   };
   const f = fixture({ registryRace, platformVerification: true, pendingRace: true });
   let service;
   async function updateRegistry () {
    if (transition.startsWith('removal')) members.delete(A);
    else members.add(neighbor);
    version++;
    await registry.poll();
    assert.equal(registry.isActive(A), false);
   }
   try {
    service = await f.boot();
    await f.evaluating.promise;
    assert.equal(pages, 1, 'initial admitted tenant only');
    if (transition.endsWith('during settings read')) beforeSettings = updateRegistry;
    else if (transition === 'policy override') override = true;
    else if (transition === 'paused' || transition === 'suspended') registryRace.activity[transition] = true;
    else {
     refuseMembership = transition === 'membership read refusal';
     refusePoll = transition === 'registry poll refusal';
     await updateRegistry();
    }
    f.finishCycle.resolve();
    for (let turn = 0; turn < 100 && f.state().clinical?.jobs.running; turn++) await settle();
    if (transition === 'unrelated add' || transition === 'add during settings read') {
     assert.equal(f.completions.length, 1, 'unchanged active tenant must commit the original acquisition');
     assert.equal(f.state().clinical.progress.completedAcquisitions, 1);
     assert.equal(f.state().clinical.progress.failedCompletions, 0);
     assert.equal(pages, 2, 'one extra addressed membership read for one unrelated registry change');
     assert.equal(registry.tenants.has(neighbor), false);
    } else {
     if (transition.startsWith('removal')) {
      assert.equal(registry.tenants.has(A), false, 'addressed removal must reach the registry');
     } else {
      assert.equal(f.state().clinical.progress.failedCompletions, 1, 'the refused attempt stays visible');
     }
     assert.equal(f.completions.length, 0, 'stale or ineligible evaluation must never commit');
     assert.equal(f.snapshot().output_revision, '0');
     assert.notEqual(f.snapshot().work_pending_at, null);
    }
    assert.equal(registry.stats().failure, refusePoll ? 'TENANT_REGISTRY_UNAVAILABLE' : null);
   } finally { f.finishCycle.resolve(); await service?.close(); await f.window.close(); }
  });
 }
 it('materializes the single due tenant after a clinical-only restart at 1000 provisioned without new input', async()=>{
  const f=fixture({clinicalTenants:1000,platformVerification:true,pendingRace:true,futureDue:true});
  let service;
  try {
   service=await f.boot();
   await Promise.race([f.evaluating.promise,new Promise((_,reject)=>{const timeout=setTimeout(()=>reject(new Error('COLD_DUE_STARVED')),1500);timeout.unref();})]);
   f.finishCycle.resolve();
   for(let n=0;n<80&&!f.completions.length;n++)await settle();
   assert(f.completions.length,'COLD_DUE_MUST_COMPLETE');
   assert.deepEqual(f.trace.filter(Array.isArray),[['lookup',A],['admit',A]],'ONLY_DUE_TENANT_MATERIALIZED');
  } finally { f.finishCycle.resolve();await service?.close();await f.window.close(); }
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
  const f=fixture({platformVerification:true,pendingRace:true,sourceTransform}),boot=f.boot();boot.catch(()=>{});let service;
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
  const remove=text=>{const needle="    const startupCause = ['PGSTREAM_REBOOTSTRAP_REQUIRED', 'PGSTREAM_SOURCE_REFUSED', ...platform.TERMINAL].includes(error?.code) ? error.code : null;";assert.equal(text.split(needle).length,2);return text.replace(needle,'    const startupCause = null;');};
  await criterion('PGSTREAM_REBOOTSTRAP_REQUIRED');
  await assert.rejects(criterion('PGSTREAM_REBOOTSTRAP_REQUIRED',remove),/ALLOWLISTED_EVALUATOR_BOOT_CAUSE_REQUIRED/);
  for(const code of ['PGSTREAM_REBOOTSTRAP_REQUIRED','PGSTREAM_SOURCE_REFUSED','UNKNOWN_PRIVATE_CODE','PGSTREAM_SOURCE_REFUSED PRIVATE_BOOT_DETAIL',undefined])await criterion(code);
 });
 async function startupDiagnosticCriterion({startupError,streamErrors={},registryError,deliveryError,cleanupError,loggerFails=false,sourceTransform=text=>text,phase,causeCode,expectedStreamTrace,refusalCause}){
  const original=refusalCause||Object.values(streamErrors)[0]||startupError||registryError||deliveryError;
  const f=fixture({startupError,streamErrors,registryError,cleanupError,sourceTransform}),lines=[],previous=console.error;
  console.error=(...args)=>{
   assert.equal(f.state().closed,false,'DIAGNOSTIC_MUST_PRECEDE_CLEANUP');
   lines.push(args);
   if(loggerFails)throw Error('PRIVATE_LOGGER_FAILURE');
  };
  try{
   const pending=f.boot();pending.catch(()=>{});
   if(deliveryError){
    for(let n=0;n<60&&!f.trace.includes('delivery-prepare');n++)await settle();
    assert(f.trace.includes('delivery-prepare'),'DELIVERY_STARTUP_MUST_BE_ENTERED');
    for(let n=0;n<60&&!f.state().clinical?.ready;n++)await settle();
    f.prepare.reject(deliveryError);
   }
   await assert.rejects(pending,error=>{
    assert.equal(error.cause,original,'PRIMARY_STARTUP_CAUSE_MUST_REMAIN_PRIVATE');
    const known=['PGSTREAM_REBOOTSTRAP_REQUIRED','PGSTREAM_SOURCE_REFUSED'].includes(original.code);
    assert.equal(error.message,'evaluator preview readiness or initialization refused'+(known?' ('+original.code+')':''));
    if(cleanupError){
     assert.equal(error.cleanupCause,cleanupError,'CLEANUP_FAILURE_MUST_REMAIN_PRIVATE');
     assert.equal(Object.getOwnPropertyDescriptor(error,'cleanupCause').enumerable,false);
    }
    assert(!JSON.stringify(error).includes('PRIVATE_'));
    return true;
   });
   const retained=lines.filter(args=>args[0]==='Evaluator startup refused');
   assert.equal(retained.length,1,'SAFE_EVALUATOR_STARTUP_DIAGNOSTIC_REQUIRED');
   assert.equal(retained[0].length,2);
   const record=JSON.parse(retained[0][1]),expected={targetRole:'evaluator',checkPhase:phase,causeCode};
   assert.deepEqual(record,expected);
   assert.deepEqual(require('../lib/server/serve/platform-verification-diagnostic').read({verificationDiagnostic:record}),expected);
   if(expectedStreamTrace)assert.deepEqual(f.streamTrace,expectedStreamTrace);
   assert(!JSON.stringify(retained).includes('PRIVATE_'));
   if(!registryError)assert.equal(f.state().closed,true,'FAILED_BOOT_MUST_ATTEMPT_CONNECTION_DRAIN');
   if(deliveryError)assert.equal(f.state().componentClosed,true,'FAILED_DELIVERY_PREPARATION_MUST_DRAIN_CLINICAL_RUNTIME');
   assert.equal(f.state().started,false,'STARTUP_FAILURE_MUST_NOT_START_DELIVERY_EFFECTS');
  }finally{console.error=previous;await f.window.close();}
 }
 const streamStartup=[
  ['connect','STREAM_REPLICATION_CONNECT',['connect','close']],
  ['identify','STREAM_IDENTIFY_SYSTEM',['connect','identify','close']],
  ['close','STREAM_REPLICATION_CLOSE',['connect','identify','close']],
  ['recovery','STREAM_RECOVERY_SETUP',['connect','identify','close','recovery']],
  ['open','STREAM_OPEN',['connect','identify','close','recovery','open']],
  ['ready','STREAM_READY',['connect','identify','close','recovery','open','ready']]
 ];
 for(const [step,phase,expectedStreamTrace] of streamStartup){
  it('attributes stream startup failure at '+step,async()=>{
   const error=Object.assign(Error('PRIVATE_STREAM_DETAIL'),{code:'ECONNRESET',detail:'PRIVATE_DRIVER_DETAIL'});
   await startupDiagnosticCriterion({streamErrors:{[step]:error},phase,causeCode:'CONNECTION_RESET',expectedStreamTrace});
  });
 }
 it('reports the connect failure if replication close also fails',async()=>{
  const connect=Object.assign(Error('PRIVATE_CONNECT_DETAIL'),{code:'ECONNREFUSED'});
  const close=Object.assign(Error('PRIVATE_CLOSE_DETAIL'),{code:'ETIMEDOUT'});
  await startupDiagnosticCriterion({streamErrors:{connect,close},phase:'STREAM_REPLICATION_CONNECT',
   causeCode:'CONNECTION_REFUSED',expectedStreamTrace:['connect','close'],refusalCause:close});
 });
 it('starts stream components in order before delivery preparation',async()=>{
  const f=fixture({platformVerification:true});
  f.prepare.resolve();
  let service;
  try{
   service=await f.boot();
   assert.deepEqual(f.streamTrace,['connect','identify','close','recovery','open','ready','delivery-prepare']);
   assert.equal(f.state().started,true);
  }finally{await service?.close();await f.window.close();}
 });
 // Existing open faults now expect STREAM_OPEN because the fixture fails inside pgstream.open.
 it('retains only source-owned startup phase and fixed cause codes before cleanup',async()=>{
  const privateError=code=>Object.assign(new Error('PRIVATE_URL_PASSWORD_TOKEN_QUERY_DETAIL'),{code,detail:'PRIVATE_DRIVER_DETAIL',config:'PRIVATE_CONFIG'});
  await startupDiagnosticCriterion({startupError:privateError('42501'),phase:'STREAM_OPEN',causeCode:'PG_PRIVILEGE_REFUSED'});
  await startupDiagnosticCriterion({registryError:privateError('UNREVIEWED_PRIVATE_CODE'),phase:'REGISTRY_DISCOVERY',causeCode:'UNCLASSIFIED'});
  await startupDiagnosticCriterion({startupError:privateError('PGSTREAM_SOURCE_REFUSED'),phase:'STREAM_OPEN',causeCode:'PGSTREAM_SOURCE_REFUSED'});
  await startupDiagnosticCriterion({startupError:privateError('PGSTREAM_SOURCE_REFUSED PRIVATE_CODE'),phase:'STREAM_OPEN',causeCode:'UNCLASSIFIED'});
  const injected=privateError('PRIVATE_UNKNOWN');injected.verificationDiagnostic={targetRole:'PRIVATE_ROLE',checkPhase:'PRIVATE_PHASE',causeCode:'PRIVATE_CODE'};
  await startupDiagnosticCriterion({startupError:injected,phase:'STREAM_OPEN',causeCode:'UNCLASSIFIED'});
 });
 it('preserves the original startup refusal when clinical drain or diagnostic output fails',async()=>{
  const deliveryError=Object.assign(new Error('PRIVATE_DELIVERY_DETAIL'),{code:'42P01'}),cleanupError=Error('PRIVATE_CLEANUP_DETAIL');
  await startupDiagnosticCriterion({deliveryError,cleanupError,phase:'DELIVERY_STARTUP',causeCode:'PG_RELATION_MISSING'});
  await startupDiagnosticCriterion({startupError:Error('PRIVATE_ORIGINAL'),cleanupError:Error('PRIVATE_CLOSE'),loggerFails:true,phase:'STREAM_OPEN',causeCode:'UNCLASSIFIED'});
 });
 it('detects a removed safe startup observation and restores the original refusal',async()=>{
  const input={startupError:Object.assign(Error('PRIVATE_ORIGINAL'),{code:'ECONNRESET'}),phase:'STREAM_OPEN',causeCode:'CONNECTION_RESET'};
  const remove=source=>{
   const needle="    try { console.error('Evaluator startup refused', JSON.stringify(startupDiagnostic || diagnostics.classify(error, 'evaluator', startupPhase))); } catch { /* observation cannot replace refusal */ }";
   assert.equal(source.split(needle).length,2);return source.replace(needle,'');
  };
  await startupDiagnosticCriterion(input);
  await assert.rejects(startupDiagnosticCriterion({...input,sourceTransform:remove}),/SAFE_EVALUATOR_STARTUP_DIAGNOSTIC_REQUIRED/);
  await startupDiagnosticCriterion(input);
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


});

// Decision stable-evaluator-runtime: the source blocks itself for relevant DDL
// after its startup baseline. Boot neither joins nor retries schema work.
describe('actual preview startup on a stable schema',()=>{
 let prior;beforeEach(()=>{prior=scope.getTenancyMode();});afterEach(()=>scope.setTenancyMode(prior));
 it('refuses startup when the source is blocked by DDL after its baseline',async()=>{
  const f=fixture({sourceBlocked:true});f.prepare.resolve();
  try{await assert.rejects(f.boot(),error=>/PGSTREAM_NOT_READY/.test(error.cause?.message));assert.equal(f.state().started,false);assert(f.trace.includes('source-blocked'));}
  finally{await f.window.close();}
 });
 it('refuses consumer construction once, without a schema retry, when the source blocks during it',async()=>{
  const f=fixture();const boot=f.boot();boot.catch(()=>{});
  try{
   for(let n=0;n<60&&!f.trace.includes('delivery-prepare');n++)await settle();assert(f.trace.includes('delivery-prepare'));
   f.blockSource();f.prepare.resolve();
   await assert.rejects(boot,error=>/EVALUATOR_FEED_UNAVAILABLE/.test(error.cause?.message));
   assert.equal(f.trace.filter(row=>row==='delivery-prepare').length,1,'NO_SCHEMA_RETRY_OF_CONSTRUCTION');assert.equal(f.state().started,false);
  }finally{f.prepare.resolve();await f.window.close();}
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
