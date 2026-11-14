'use strict';
// Actual preview and clinical scheduler with recording dependency ports only.
// No native PostgreSQL, child process, listener or external effect proof.
const assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module');
const scope=require('../lib/storage/tenant-scope');
const A='11111111-1111-4111-8111-111111111111',identity='a'.repeat(64);
const deferred=()=>{let resolve,reject;const promise=new Promise((ok,no)=>{resolve=ok;reject=no;});return {promise,resolve,reject};};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({holdAdmission=false}={}){
 const prepare=deferred(),admission=deferred(),trace=[],current={tenant:A,identity,env:{settings:{language:'en'}},settingsVersion:1,policyGeneration:1,sourceIdentity:'source'};
 let runtime,output,revision=0,closed=false,started=false,delivered=0,componentClosed=false,checks=0;
 const connection={async end(){closed=true;}};
 const metadata=new Map([[A,{settings:1,policy:1,activity:{state:'active'},signature:{stamp:1,deleted:0}}]]);
 const scan=async()=>metadata;scan.state=()=>({available:true,generation:1});
 const reader={scan,current:t=>metadata.get(t),state:scan.state,async close(){},health:()=>({available:true})};
 const startup={async warm(){},isReady:()=>true,async ensure(){trace.push('tenant-admitted');},async close(){},health:()=>({})};
 const readiness=async()=>{checks++;if(holdAdmission)await admission.promise;};readiness.provisionTenant=async()=>{};
 const store={begin:async()=>({clock:'1'}),complete:async(tenant,value)=>{assert(checks>0);output={tenant,identity,contentDigest:'digest'+(++revision),outputRevision:revision,result:value.result};trace.push('completed');return {output,changed:true};},work:async()=>[]};
 const filename=require.resolve('../lib/server/serve/evaluator-preview'),loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=module.paths;
 const fakeEvaluator=()=>({async evaluate(){assert(trace.includes('tenant-admitted'));return {checkpoint:1,signature:{stamp:1,deleted:0},properties:{},emitted:[],requested:[],due:{dueAt:null,slow:[]}};},close(){componentClosed=true;}});fakeEvaluator.domains=['entries'];
 const mocks={
  './evaluator-runtime':async options=>{runtime=await require('../lib/server/serve/evaluator-runtime')(options);return runtime;},
  '../../storage/postgres-connection':Object.assign(async()=>connection,{readopt:async()=>{}}),
  '../../storage/postgres-durable-replay':()=>({}), '../../data/tenant-projection-evaluator':fakeEvaluator,
  './evaluator-readiness':readiness,
  '../../pool-membership':{member:async()=>({configured:{mode:'standalone'},async register(){},async close(){}})},
  './evaluator-pool':{create:()=>({partitioned:false,start(){},async refresh(){},admits:()=>true,close(){}})},
  '../../trusted-worker/postgres':{create:()=>reader},
  '../../trusted-worker/lifecycle':async()=>({version:()=>1,activateRefresh(){},async close(){}}),
  '../internal-api/clients':{completedOutput:()=>({hintCompletedOutput:async()=>{}})},
  '../../pgstream/evaluator':{open:async()=>({store,ready:async()=>{},assertAvailable(){},health:()=>({}),close:async()=>{}})},
  './tenant-startup':{create:()=>startup,limited:require('../lib/server/serve/tenant-startup').limited},
  './evaluator-consumers':{async prepare({current:read,operationWindow,jobContext}){trace.push('delivery-prepare');await prepare.promise;return {async wake(){},revised(){if(read(A))delivered++;},start(){started=true;this.dispatch=jobContext.run(()=>operationWindow.run(A,()=>{if(read(A))delivered++;}));},async close(){await this.dispatch;},health:()=>({})};}},
  './evaluator-inspection':()=>()=>({}), '../../language':()=>({set(){}})
 };
 loaded.require=name=>Object.hasOwn(mocks,name)?mocks[name]:Module.prototype.require.call(loaded,name);
 loaded._compile(fs.readFileSync(filename,'utf8'),filename);
 const window=require('./fixtures/operation-window-runtime-protocol')({trustedWorker:true}).window;
 const config={pgstream:{outputPeer:{},bounds:{heartbeatMs:1000}},trustedWorker:{},consumers:{realtime:true},tenants:new Map([[A,current]]),connectionString:'synthetic',
  namespaces:{entries:'synthetic_entries',checkpoint:'synthetic_checkpoint'},consumer:'evaluator-test',maxTenants:1,maxRows:10,maxBytes:10000,pageSize:10,
  recoveryIntervalMs:1000,timeIntervalMs:60000,readCurrent:async()=>current};
 return {prepare,admission,trace,window,async boot(){await window.ready();return loaded.exports.boot(config,{operationWindow:window});},state:()=>({output,clinical:runtime?.health([A]).tenants[0],closed,started,delivered,componentClosed})};
}
describe('clinical startup independent of delivery roster preparation',function(){
 let prior;beforeEach(()=>{prior=scope.getTenancyMode();});afterEach(()=>scope.setTenancyMode(prior));
 it('completes clinical work while delivery prepares and start sweep recovers the early revision',async()=>{
  const f=fixture();let service;const boot=f.boot();boot.catch(()=>{});
  try{for(let n=0;n<30&&!f.trace.includes('delivery-prepare');n++)await settle();for(let n=0;n<30&&!f.state().clinical?.ready;n++)await settle();
   assert(f.state().clinical?.ready,'CLINICAL_PROGRESS_MUST_NOT_WAIT_FOR_DELIVERY_PREPARE');assert.equal(f.state().started,false);assert.equal(f.state().delivered,0);
   f.prepare.resolve();service=await boot;for(let n=0;n<30&&!f.state().delivered;n++)await settle();assert(f.state().delivered>0,'START_SWEEP_MUST_RECOVER_EARLY_REVISION');
   const sent=f.state().delivered;await service.acquire(A);assert(f.state().delivered>sent,'LATER_REVISIONS_MUST_REACH_CURRENT_CONSUMERS');
  }finally{f.prepare.resolve();service=service||await boot.catch(()=>null);await service?.close();await f.window.close();}
 });
 it('closes the partial clinical runtime when delivery preparation refuses and never starts effects',async()=>{
  const f=fixture(),boot=f.boot();boot.catch(()=>{});
  try{for(let n=0;n<60&&!f.state().output;n++)await settle();assert(f.state().output,'PARTIAL_RUNTIME_MUST_EXIST_FOR_FAILURE_CONTROL');f.prepare.reject(Error('DELIVERY_PREPARE_REFUSED'));await assert.rejects(boot,/readiness or initialization refused/);
   assert.equal(f.state().closed,true);assert.equal(f.state().componentClosed,true);assert.equal(f.state().started,false);assert.equal(f.state().delivered,0);
  }finally{f.prepare.resolve();const service=await boot.catch(()=>null);await service?.close();await f.window.close();}
 });
 it('does not start clinical work before unconditional admission succeeds',async()=>{
  const f=fixture({holdAdmission:true}),boot=f.boot();boot.catch(()=>{});
  try{await settle();await settle();assert.equal(f.state().output,undefined);assert(!f.trace.includes('tenant-admitted'));f.admission.reject(Error('CATALOGUE_REFUSED'));await assert.rejects(boot,/readiness or initialization refused/);assert.equal(f.state().started,false);}
  finally{f.prepare.resolve();const service=await boot.catch(()=>null);await service?.close();await f.window.close();}
 });
});
