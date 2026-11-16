'use strict';
// Actual preview and clinical scheduler with recording dependency ports only.
// No native PostgreSQL, child process, listener or external effect proof.
const assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module');
const scope=require('../lib/storage/tenant-scope');
const A='11111111-1111-4111-8111-111111111111',identity='a'.repeat(64);
const deferred=()=>{let resolve,reject;const promise=new Promise((ok,no)=>{resolve=ok;reject=no;});return {promise,resolve,reject};};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({holdAdmission=false,pgstreamEnabled=true,partitioned=false,sourceTransform=text=>text}={}){
 const prepare=deferred(),admission=deferred(),trace=[],current={tenant:A,identity,env:{settings:{language:'en'}},settingsVersion:1,policyGeneration:1,sourceIdentity:'source'};
 let commitWake;let runtime,output,cycle=0,revision=0,closed=false,started=false,delivered=0,componentClosed=false,checks=0;
 const connection={async end(){closed=true;}};
 const metadata=new Map([[A,{settings:1,policy:1,activity:{state:'active'},signature:{stamp:1,deleted:0}}]]);
 const scan=async()=>metadata;scan.state=()=>({available:true,generation:1});
 const reader={scan,current:t=>metadata.get(t),state:scan.state,async close(){},health:()=>({available:true})};
 const startup={async warm(){},isReady:()=>true,async ensure(){trace.push('tenant-admitted');},async close(){},health:()=>({})};
 const readiness=async()=>{checks++;if(holdAdmission)await admission.promise;};readiness.provisionTenant=async()=>{};
 const store={begin:async()=>({clock:'1'}),complete:async(tenant,value)=>{assert(checks>0);output={tenant,identity,contentDigest:'digest'+(++revision),outputRevision:revision,result:value.result};trace.push('completed');commitWake?.({tenant,kind:'complete'});return {output,changed:true};},work:async()=>[],nextDue:async()=>null,deliveries:async()=>[]};
 const filename=require.resolve('../lib/server/serve/evaluator-preview'),loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=module.paths;
 const fakeEvaluator=()=>({async evaluate(){assert(trace.includes('tenant-admitted'));return {checkpoint:1,signature:{stamp:1,deleted:0},properties:{syntheticCycle:++cycle},emitted:[],requested:[],due:{dueAt:null,slow:[]}};},close(){componentClosed=true;}});fakeEvaluator.domains=['entries'];
 const mocks={
  './evaluator-runtime':async options=>{runtime=await require('../lib/server/serve/evaluator-runtime')(options);return runtime;},
  '../../storage/postgres-connection':Object.assign(async()=>connection,{readopt:async()=>{}}),
  '../../storage/postgres-durable-replay':()=>({}), '../../data/tenant-projection-evaluator':fakeEvaluator,
  './evaluator-readiness':readiness,
  '../../pool-membership':{member:async()=>({configured:{mode:'standalone'},async register(){trace.push('member-registered');},async close(){}})},
  './evaluator-pool':{create:()=>({partitioned:false,start(){},async refresh(){},admits:()=>true,close(){}})},
  '../../trusted-worker/postgres':{create:()=>reader},
  '../../trusted-worker/lifecycle':async()=>({version:()=>1,activateRefresh(){},async close(){}}),
  '../internal-api/clients':{completedOutput:()=>({hintCompletedOutput:async()=>{}})},
  '../../pgstream/evaluator':{open:async({onCommit})=>{commitWake=onCommit;return {store,ready:async()=>{},assertAvailable(){},health:()=>({}),close:async()=>{}};}},
  './registry-tenant-set':{open:async()=>{trace.push('registry-open');return {tenants:new Map([[A,current]]),isActive:()=>true,follow:async()=>{},close:async()=>{},revision:()=>1,stats:()=>({})};}},
  './tenant-startup':{create:()=>startup,limited:require('../lib/server/serve/tenant-startup').limited},
  './evaluator-consumers':{async prepare({current:read,operationWindow,jobContext}){trace.push('delivery-prepare');await prepare.promise;return {async wake(){},revised(){if(read(A))delivered++;},start(){started=true;this.dispatch=jobContext.run(()=>operationWindow.run(A,()=>{if(read(A))delivered++;}));},async close(){await this.dispatch;},health:()=>({})};}},
  './evaluator-inspection':()=>()=>({}), '../../language':()=>({set(){}})
 };
 loaded.require=name=>Object.hasOwn(mocks,name)?mocks[name]:Module.prototype.require.call(loaded,name);
 loaded._compile(sourceTransform(fs.readFileSync(filename,'utf8')),filename);
 const window=require('./fixtures/operation-window-runtime-protocol')({trustedWorker:true}).window;
 const config={partition:{kind:'evaluator',partitioned},registry:{namespace:'synthetic_registry'},pgstream:pgstreamEnabled?{outputPeer:{},bounds:{recoveryMs:1000,pendingMs:1000}}:undefined,trustedWorker:{},consumers:{realtime:true},tenants:new Map([[A,current]]),connectionString:'synthetic',
  namespaces:{entries:'synthetic_entries',checkpoint:'synthetic_checkpoint'},consumer:'evaluator-test',maxTenants:1,maxRows:10,maxBytes:10000,pageSize:10,
  timeIntervalMs:60000,readCurrent:async()=>current};
 return {prepare,admission,trace,window,async boot(){await window.ready();return loaded.exports.boot(config,{operationWindow:window});},state:()=>({output,clinical:runtime?.health([A]).tenants[0],closed,started,delivered,componentClosed,checks})};
}
const pgstreamEnabled=true;describe('maintained clinical startup independent of delivery roster preparation',function(){
 let prior;beforeEach(()=>{prior=scope.getTenancyMode();});afterEach(()=>scope.setTenancyMode(prior));
 it('completes clinical work while delivery prepares and start sweep recovers the early revision',async()=>{
  const f=fixture({pgstreamEnabled});let service;const boot=f.boot();boot.catch(()=>{});
  try{for(let n=0;n<30&&!f.trace.includes('delivery-prepare');n++)await settle();for(let n=0;n<30&&!f.state().clinical?.ready;n++)await settle();
   assert(f.state().clinical?.ready,'CLINICAL_PROGRESS_MUST_NOT_WAIT_FOR_DELIVERY_PREPARE');assert.equal(f.state().started,false);assert.equal(f.state().delivered,0);
   f.prepare.resolve();service=await boot;for(let n=0;n<30&&!f.state().delivered;n++)await settle();assert(f.state().delivered>0,'START_SWEEP_MUST_RECOVER_EARLY_REVISION');
   const sent=f.state().delivered;await service.acquire(A);assert(f.state().delivered>sent,'LATER_REVISIONS_MUST_REACH_CURRENT_CONSUMERS');
  }finally{f.prepare.resolve();service=service||await boot.catch(()=>null);await service?.close();await f.window.close();}
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
