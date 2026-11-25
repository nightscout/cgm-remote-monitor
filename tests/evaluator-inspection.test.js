'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const inspection=require('../lib/server/serve/evaluator-inspection');
const transport=require('../lib/server/internal-api/transport'),service=require('../lib/server/internal-api/contracts').evaluatorInspection;
const A='11111111-1111-4111-8111-111111111111';
function createSocketDirectory () {
  // The listener binds a longer private name before publishing inspect.sock.
  return fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'ns-inspect-'));
}
function fixture(count=10000, due={dueAt:null,dueReason:null}, clinical, factory=inspection){
 const ids=Array.from({length:count},(_,i)=>String(i).padStart(8,'0')+'-1111-4111-8111-111111111111');
 let visited=0;const map=new Map(ids.map(id=>[id,true]));
 const tenants=new Proxy(map,{get(target,key){if(['keys','values','entries',Symbol.iterator].includes(key))return()=>{throw new Error('FULL_REGISTRY_ITERATION');};return typeof target[key]==='function'?target[key].bind(target):target[key];}});
 const row=tenant=>({tenant,jobs:{running:false,booting:false,acquire:false,time:false,parentAcquire:false,parentTime:false},...due,ready:true,code:null,cycles:5,outputRevision:1,inputCheckpoint:0,evaluatedAgeMs:1,alert:null,progress:{generation:1,completedAcquisitions:1,completedTimeCycles:4,lastCompletedAgeMs:1,failedCompletions:0}});
 const inspect=factory({tenants,gate:{inspect:async()=>({configured:{mode:'standalone',ordinal:0,rule:null,leaseMs:null,configuredTenants:ids.length},observed:null,
  gate:{eligible:true,reason:null,members:null,reads:0,refusals:0,changes:0,checkedAgeMs:null,heartbeats:null},owner:()=>null,admits:()=>true})},
 runtime:{clinicalResults(selected){assert(clinical,'CLINICAL_OBSERVATION_NOT_REQUESTED');return clinical(selected);},health(selected){assert(Array.isArray(selected),'BOUNDED_RUNTIME_SELECTOR_REQUIRED');visited+=selected.length;return{runtimeId:A,tenants:selected.map(row)};}},
 consumers:{health(selected){assert(Array.isArray(selected),'BOUNDED_DELIVERY_SELECTOR_REQUIRED');visited+=selected.length;return{tenants:selected.map(tenant=>({tenant,state:'idle',code:null,passes:1,repeatAt:null}))};}},
 registry:{stats(){throw new Error('FULL_REGISTRY_STATS');}},startup:{health(){throw new Error('FULL_STARTUP_STATS');}}});
 return{inspect,ids,visited:()=>visited};
}
function fractionalDue(){
 const at=1700000000000,env=require('../lib/server/tenant-app/environment')({settings:{enable:['pump']},extendedSettings:{pump:{warnClock:1/7}}});
 assert.equal(env.extendedSettings.pump.warnClock,1/7);
 const due=require('../lib/data/evaluator-due').nextDue({env,ddata:{devicestatus:[{mills:at,pump:{clock:new Date(at).toISOString()}}]},result:{requested:[]},at});
 assert(Number.isFinite(due.dueAt)&&!Number.isInteger(due.dueAt));return{dueAt:due.dueAt,dueReason:due.reason};
}
describe('bounded evaluator inspection v3',function(){
 it('keeps internal startup policy fields out of the closed private v3 response and detects an unprojected body',async()=>{
  const startup=require('../lib/server/serve/tenant-startup').create([],undefined,async()=>{}, {readiness:'serve',coldAlertMs:null});
  const control=require('./lib/clinical-working-set/control');
  async function criterion(factory){
   const f=fixture(0,undefined,undefined,options=>factory({...options,tenants:new Map(),registry:undefined,consumers:undefined,
    startup:{health:()=>({...startup.health(),warmOnStart:false})},runtime:{health:()=>({runtimeId:A,tenants:[]})}}));
   const dir=createSocketDirectory(),endpoint={socketPath:path.join(dir,'inspect.sock'),maxBytes:1048576,timeoutMs:1000};let listener;
   try{
    listener=await transport.compose(endpoint,[{service,create:()=>({inspectEvaluator:async(ctx,body)=>f.inspect(body)})}]);
    const dto=await transport.client(endpoint,service).inspectEvaluator({});
    assert.equal(dto.startup.readiness,'serve');assert.equal(dto.startup.ready,true);
    assert.equal(Object.hasOwn(dto.startup,'warmOnStart'),false,'INTERNAL_POLICY_MUST_NOT_CHANGE_CLOSED_WIRE');
   }finally{await listener?.close();fs.rmSync(dir,{recursive:true,force:true});}
  }
  try{
   await criterion(inspection);
   const broken=control('../lib/server/serve/evaluator-inspection','startup: startupWire(startup.health())','startup: startup.health()');
   await assert.rejects(criterion(broken),error=>error.message==='SOCKET_IPC_UNAVAILABLE');
   await criterion(inspection);
  }finally{await startup.close();}
 });

 it('selects at most 128 without whole-roster summaries, including empty summary, and refuses unknown/duplicate selectors',async function(){
  const f=fixture();assert.deepEqual((await f.inspect({tenants:[]})).tenants,[]);assert.equal(f.visited(),0);
  const dto=await f.inspect({tenants:f.ids.slice(0,128)});assert.equal(dto.tenants.length,128);assert.equal(f.visited(),256);
  assert.equal(dto.startup,undefined);assert.equal(dto.registry,undefined);
  const bytes=Buffer.byteLength(JSON.stringify(dto));assert(bytes<1024*1024);console.log('EVALUATOR_SELECTED_DTO_BYTES '+bytes);
  await assert.rejects(f.inspect({tenants:[A]}),/selector refused/);
  await assert.rejects(f.inspect({tenants:[f.ids[0],f.ids[0]]}),/selector refused/);
  await assert.rejects(f.inspect({tenants:f.ids.slice(0,129)}),/selector refused/);
  await assert.rejects(f.inspect({}),/BOUNDED_RUNTIME_SELECTOR_REQUIRED|FULL_REGISTRY/,'CONTROL_UNSELECTED_VIEW_IS_DISTINCT');
 });
 it('exports actual source-access counters only on explicit private inspection',async function(){
  const counts={snapshotAttempts:2,snapshotCompleted:1,catalogueAttempts:1,catalogueCompleted:1,dataAttempts:4,dataCompleted:4,residentTenants:1,residentEncodedBytes:123,evictions:0};let reads=0;
  const f=fixture(1,undefined,undefined,options=>inspection({...options,sourceAccess:()=>{reads++;return {...counts};}}));
  await f.inspect({tenants:[]});assert.equal(reads,0);
  const dir=createSocketDirectory(),endpoint={socketPath:path.join(dir,'inspect.sock'),maxBytes:1024*1024,timeoutMs:1000};let listener;
  try{listener=await transport.compose(endpoint,[{service,create:()=>({inspectEvaluator:async(ctx,body)=>f.inspect(body)})}]);
   const observed=await transport.client(endpoint,service).inspectEvaluator({tenants:[],diagnostics:'source-access-v1'});
   assert.deepEqual(observed.diagnostics.sourceAccess,counts);assert.equal(observed.runtimeId,A);assert.equal(reads,1);
  }finally{await listener?.close();fs.rmSync(dir,{recursive:true,force:true});}
 });
 it('refuses the retired feed selector before effects and detects an ablated selector guard',async function(){
  const Module=require('node:module'),filename=require.resolve('../lib/server/serve/evaluator-inspection');
  const original=fs.readFileSync(filename,'utf8'),guard="if (diagnostics !== undefined && !DIAGNOSTICS.includes(diagnostics)) throw new Error('Evaluator diagnostics selector refused');";
  assert.equal(original.split(guard).length,2,'CONTROL_GUARD_SOURCE_EXACT');
  const loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));loaded._compile(original.replace(guard,''),filename);
  const criterion=async factory=>{
   let effects=0;
   const inspect=factory({tenants:new Map(),gate:{inspect:async()=>{effects++;return {configured:{},gate:{}};}},runtime:{health:()=>{effects++;return {tenants:[]};}},startup:{health:()=>{effects++;return {};}}});
   await assert.rejects(inspect({tenants:[],diagnostics:'change-feed-v1'}),/diagnostics selector refused/,'RETIRED_FEED_DIAGNOSTICS_BEFORE_EFFECTS');
   assert.equal(effects,0,'RETIRED_SELECTOR_MUST_NOT_VISIT_GATE_OR_RUNTIME');
  };
  await criterion(inspection);await assert.rejects(criterion(loaded.exports),{code:'ERR_ASSERTION'});await criterion(inspection);
  const ordinary=fixture(1);assert.deepEqual((await ordinary.inspect({tenants:[]})).tenants,[]);
  for(const diagnostics of [false,true,'unknown'])await assert.rejects(ordinary.inspect({tenants:[],diagnostics}),/diagnostics selector refused/);
 });
 it('preserves ordinary paired clients and refuses retired requests and response shapes on the private wire',async function(){
  const f=fixture(1),dir=createSocketDirectory(),endpoint={socketPath:path.join(dir,'inspect.sock'),maxBytes:1024*1024,timeoutMs:1000};let listener,corrupt=false,invoked=0;
  try{
   listener=await transport.compose(endpoint,[{service,create:()=>({inspectEvaluator:async(ctx,body)=>{invoked++;const dto=await f.inspect(body);if(corrupt)dto.diagnostics={changeFeed:{status:'not-configured',health:null}};return dto;}})}]);
   const client=transport.client(endpoint,service),old=JSON.parse(JSON.stringify(service));delete old.operations.inspectEvaluator.request.properties.diagnostics;delete old.operations.inspectEvaluator.response.properties.diagnostics;
   await transport.client(endpoint,old).inspectEvaluator({tenants:[]});assert.equal(invoked,1);
   for(const body of [{tenants:[],diagnostics:'change-feed-v1'},{tenants:[],diagnostics:false},{tenants:[],diagnostics:'unknown'},{tenants:[],unknown:true}])await assert.rejects(client.inspectEvaluator(body));
   assert.equal(invoked,1,'RETIRED_FEED_REQUEST_REFUSED_BEFORE_DISPATCH');
   corrupt=true;await assert.rejects(client.inspectEvaluator({tenants:[]}),/SOCKET_IPC_UNAVAILABLE/,'RETIRED_FEED_RESPONSE_REFUSED');corrupt=false;
   const restored=await client.inspectEvaluator({tenants:[]});assert(!Object.hasOwn(restored,'diagnostics'));
  }finally{await listener?.close();fs.rmSync(dir,{recursive:true,force:true});}
 });
 it('reports in-memory and durable pending markers side by side only for an explicit bounded selection',async function(){
  const memory={pendingSince:1700000000000,pendingEpoch:7,marksDuringCycle:1,pendingAgeMs:2500,expired:false};
  const durable={pendingAt:1700000001000,nextDueAt:null,observed:{clock:'9'},completed:{clock:'8'},observedAt:{clock:'1700000001000'},outputRevision:'4'};
  let reads=0;
  const f=fixture(10000,undefined,undefined,options=>inspection({...options,runtime:{...options.runtime,pendingWitness:selected=>selected.map(tenant=>({tenant,memory:{...memory}}))},witness:async selected=>{reads++;return selected.map(tenant=>({tenant,durable:tenant===f.ids[1]?null:JSON.parse(JSON.stringify(durable))}));}}));
  const ordinary=await f.inspect({tenants:[f.ids[0]]});assert.equal(reads,0,'ORDINARY_INSPECTION_READS_NO_WITNESS');assert(!Object.hasOwn(ordinary,'diagnostics'));
  for(const tenants of [undefined,[],[f.ids[0],f.ids[0]],f.ids.slice(0,129)])await assert.rejects(f.inspect({tenants,diagnostics:'pending-witness-v1'}),/selector refused/);
  const dir=createSocketDirectory(),endpoint={socketPath:path.join(dir,'inspect.sock'),maxBytes:1024*1024,timeoutMs:1000};let listener,corrupt;
  try{
   listener=await transport.compose(endpoint,[{service,create:()=>({inspectEvaluator:async(ctx,body)=>{const dto=await f.inspect(body);if(corrupt)corrupt(dto);return dto;}})}]);
   const client=transport.client(endpoint,service),body={tenants:[f.ids[0],f.ids[1]],diagnostics:'pending-witness-v1'};
   const dto=await client.inspectEvaluator(body);
   assert.deepEqual(dto.diagnostics.pendingWitness.tenants,[{tenant:f.ids[0],memory,durable},{tenant:f.ids[1],memory,durable:null}]);
   assert.deepEqual(dto.tenants,(await f.inspect({tenants:body.tenants})).tenants,'ORDINARY_TENANT_ROWS_UNCHANGED');
   for(const change of [x=>{x.diagnostics.pendingWitness.tenants[0].durable.observed.unknown='1';},x=>{x.diagnostics.pendingWitness.tenants[0].memory.pendingSince=-1;},x=>{x.diagnostics.clinicalResults={authority:'cached-result-only',tenants:[]};}]){corrupt=change;await assert.rejects(client.inspectEvaluator(body),/SOCKET_IPC_UNAVAILABLE/);}
   corrupt=null;await client.inspectEvaluator(body);
  }finally{await listener?.close();fs.rmSync(dir,{recursive:true,force:true});}
 });
 it('exposes clinical results only for explicit bounded selection through strict paired private transport',async function(){
  let reads=0;const observation=tenant=>({tenant,status:'eligible-model',generation:2,outputRevision:3,inputCheckpoint:4,lastCompletedAgeMs:5,retainedModelAt:1700000000000,bgNow:{meanPresent:true,meanFinite:true,mills:1699999990000}});
  const f=fixture(10000,undefined,selected=>{reads++;return selected.map(observation);});
  const ordinary=await f.inspect({tenants:[f.ids[0]]});assert.equal(reads,0);assert(!Object.hasOwn(ordinary,'diagnostics'));
  for(const tenants of [undefined,[],[f.ids[0],f.ids[0]],f.ids.slice(0,129)])await assert.rejects(f.inspect({tenants,diagnostics:'clinical-result-v1'}),/selector refused/);
  const dir=createSocketDirectory(),endpoint={socketPath:path.join(dir,'inspect.sock'),maxBytes:1024*1024,timeoutMs:1000};let listener,corrupt;
  try{
   listener=await transport.compose(endpoint,[{service,create:()=>({inspectEvaluator:async(ctx,body)=>{const dto=await f.inspect(body);if(corrupt)corrupt(dto);return dto;}})}]);
   const client=transport.client(endpoint,service),body={tenants:[f.ids[9999]],diagnostics:'clinical-result-v1'};
   const dto=await client.inspectEvaluator(body);assert.deepEqual(dto.diagnostics.clinicalResults,{authority:'cached-result-only',tenants:[observation(f.ids[9999])]});
   assert.deepEqual(dto.tenants,(await f.inspect({tenants:body.tenants})).tenants,'ORDINARY_TENANT_ROWS_UNCHANGED');
   for(const body of [{diagnostics:'clinical-result-v1'},{tenants:[],diagnostics:'clinical-result-v1'},{tenants:[f.ids[0]],diagnostics:'clinical-result-v1',unknown:true}])await assert.rejects(client.inspectEvaluator(body));
   for(const change of [x=>{x.diagnostics.clinicalResults.tenants[0].bgNow.meanFinite=1;},x=>{x.diagnostics.clinicalResults.tenants[0].bgNow.mean=123;},x=>{x.diagnostics.clinicalResults.authority='current';},x=>{x.diagnostics.clinicalResults.tenants[0].retainedModelAt=-1;}]){corrupt=change;await assert.rejects(client.inspectEvaluator(body),/SOCKET_IPC_UNAVAILABLE/);}
   corrupt=null;await client.inspectEvaluator(body);
   let invoked=0,status;const handler=transport.handler({service,token:Symbol('private'),operations:{inspectEvaluator:async()=>{invoked++;}},admitted:()=>false});
   const request={method:'POST',url:'/evaluator/inspect',headers:{'x-nightscout-internal-service':service.id,'x-nightscout-internal-version':String(service.version),'content-type':'application/json'},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(body));},destroy(){}};
   await handler(request,{writeHead(code){status=code;},end(){}});assert.equal(status,503);assert.equal(invoked,0,'AUTHORITY_REFUSED_BEFORE_CLINICAL_READ');
  }finally{await listener?.close();fs.rmSync(dir,{recursive:true,force:true});}
 });
 it('preserves future, overdue and absent due observations without scheduling or inventing a cadence',async function(){
  for(const due of [{dueAt:Date.now()+60000,dueReason:'slow:alarm-message'},{dueAt:1,dueReason:'sgv-recent-10'},{dueAt:null,dueReason:null},{dueAt:0,dueReason:null},{dueAt:1.5,dueReason:null},{dueAt:Number.MAX_VALUE,dueReason:null}]){
   const f=fixture(1,due),dto=await f.inspect({tenants:f.ids});assert.equal(dto.tenants[0].dueAt,due.dueAt);assert.equal(dto.tenants[0].dueReason,due.dueReason);
  }
 });
 it('preserves fractional due returned by accepted source pump settings without rounding',async function(){
  const due=fractionalDue(),f=fixture(1,due),dto=await f.inspect({tenants:f.ids});assert.equal(dto.tenants[0].dueAt,due.dueAt);assert.equal(dto.tenants[0].dueReason,due.dueReason);
 });
 it('refuses missing or malformed due values, free text and oversized source reasons',async function(){
  const absent=fixture(1,{});await assert.rejects(absent.inspect({tenants:absent.ids}),/due inspection refused/);
  for(const due of [{dueAt:undefined},{dueReason:undefined},{dueAt:-1},{dueAt:NaN},{dueAt:Infinity},{dueAt:false},{dueAt:'1'},{dueAt:1,dueReason:'private free text'},{dueAt:1,dueReason:'a'.repeat(129)},{dueAt:null,dueReason:'stale-reason'}]){
   const f=fixture(1,{dueAt:null,dueReason:null,...due});await assert.rejects(f.inspect({tenants:f.ids}),/due inspection refused/);
  }
 });
 it('refuses missing or malformed clinical job observations without coercing unknown to quiet',async function(){
  for(const jobs of [undefined,null,{}, {running:false,booting:false,acquire:false,time:false,parentAcquire:false,parentTime:0}]){
   const f=fixture(1,{dueAt:null,dueReason:null,jobs});await assert.rejects(f.inspect({tenants:f.ids}),/job inspection refused/);
  }
 });
 it('carries selected v3 bodies over the actual private UDS client and refuses the prior module version',async function(){
  const due={dueAt:Date.now()+60000,dueReason:'slow:alarm-message'},f=fixture(10000,due),dir=createSocketDirectory();let listener;
  const endpoint={socketPath:path.join(dir,'inspect.sock'),maxBytes:1024*1024,timeoutMs:1000};let corrupt=false,jobCorruption=false;
  try{
   listener=await transport.compose(endpoint,[{service,create:()=>({inspectEvaluator:async(context,body)=>{const dto=await f.inspect(body);if(corrupt&&dto.tenants.length)dto.tenants[0].dueReason=corrupt;if(jobCorruption&&dto.tenants.length)dto.tenants[0].jobs.running=0;return dto;}})}]);
   const client=transport.client(endpoint,service);
   assert.deepEqual((await client.inspectEvaluator({tenants:[]})).tenants,[]);
   const dto=await client.inspectEvaluator({tenants:[f.ids[9999]]});assert.equal(dto.tenants[0].tenant,f.ids[9999]);assert.equal(dto.tenants[0].dueAt,due.dueAt);assert.equal(dto.tenants[0].dueReason,due.dueReason);
   for(const next of [fractionalDue(),{dueAt:1,dueReason:'sgv-recent-10'},{dueAt:null,dueReason:null}]){Object.assign(due,next);const observed=await client.inspectEvaluator({tenants:[f.ids[0]]});assert.equal(observed.tenants[0].dueAt,next.dueAt);assert.equal(observed.tenants[0].dueReason,next.dueReason);}
   for(const invalid of ['a'.repeat(129),'stale-reason']){due.dueAt=invalid==='stale-reason'?null:1;corrupt=invalid;await assert.rejects(client.inspectEvaluator({tenants:[f.ids[0]]}),/SOCKET_IPC_UNAVAILABLE/,'SCHEMA_REFUSES_INVALID_REASON');}corrupt=false;await client.inspectEvaluator({tenants:[f.ids[0]]});
   jobCorruption=true;await assert.rejects(client.inspectEvaluator({tenants:[f.ids[0]]}),/SOCKET_IPC_UNAVAILABLE/,'SCHEMA_REFUSES_NONBOOLEAN_JOB_STATE');jobCorruption=false;
   const oldStrict=JSON.parse(JSON.stringify(service));const oldRows=oldStrict.operations.inspectEvaluator.response.properties.tenants.items;delete oldRows.properties.dueAt;delete oldRows.properties.dueReason;delete oldRows.anyOf;oldRows.required=oldRows.required.filter(key=>!['dueAt','dueReason'].includes(key));
   await assert.rejects(transport.client(endpoint,oldStrict).inspectEvaluator({tenants:[f.ids[0]]}),/SOCKET_IPC_UNAVAILABLE/,'OLD_STRICT_RESPONSE_MUST_NOT_SILENTLY_ACCEPT_NEW_FIELDS');
   const empty=fixture(0),emptyDir=path.join(dir,'empty.sock');
   const emptyEndpoint={...endpoint,socketPath:emptyDir};
   const emptyListener=await transport.compose(emptyEndpoint,[{service,create:()=>({inspectEvaluator:(context,body)=>empty.inspect(body)})}]);
   try { const dto=await transport.client(emptyEndpoint,service).inspectEvaluator({tenants:[]});assert.equal(dto.configured.configuredTenants,0);assert.deepEqual(dto.tenants,[]); } finally { await emptyListener.close(); }
   for(const version of [1,2])await assert.rejects(transport.client(endpoint,{...service,version}).inspectEvaluator({tenants:[]}),/SOCKET_IPC_UNAVAILABLE/,'PRIOR_INSPECTION_VERSION_MUST_REFUSE');
  }finally{await listener?.close();fs.rmSync(dir,{recursive:true,force:true});}
 });
 it('actual runtime/window inspection over private UDS does not schedule work or acquire tenant authority',async function(){
  const runtimeFactory=require('../lib/server/serve/evaluator-runtime'),jobs=require('../lib/server/serve/evaluator-job-context');
  const f=require('./fixtures/operation-window-runtime-protocol')();await f.window.ready();
  const context=jobs.create('clinical');let calls=0,timers=0;const due=Date.now()+60000;
  const result=()=>({checkpoint:1,signature:{stamp:1,deleted:0},emitted:[],requested:[],properties:{},due:{dueAt:due,reason:'synthetic-future',slow:[]}});
  const runtime=await runtimeFactory({tenants:[A],operationWindow:f.window,jobContext:context,readCurrent:async()=>({tenant:A,identity:'a'.repeat(64)}),create:async()=>({evaluate:async()=>{calls++;return result();},evaluateTime:async()=>{calls++;return result();},close(){}}),recoveryIntervalMs:10000,timeIntervalMs:10000,schedule:()=>({}),cancel(){},setTimer:()=>{timers++;return {};},clearTimer(){}});
  const inspect=inspection({tenants:new Map([[A,true]]),runtime,gate:{inspect:async()=>({configured:{mode:'standalone',ordinal:0,rule:null,leaseMs:null,configuredTenants:1},observed:null,gate:{eligible:true,reason:null,members:null,reads:0,refusals:0,changes:0,checkedAgeMs:null,heartbeats:null},owner:()=>null,admits:()=>true})}});
  const dir=createSocketDirectory(),endpoint={socketPath:path.join(dir,'inspect.sock'),maxBytes:1024*1024,timeoutMs:1000};let listener;
  try{
   listener=await transport.compose(endpoint,[{service,create:()=>({inspectEvaluator:(ctx,body)=>inspect(body)})}]);const client=transport.client(endpoint,service);
   const before={calls,timers,sql:f.log.length,pending:f.pending.size,health:runtime.health([A]).tenants[0].cycles};
   for(let i=0;i<10;i++){const dto=await client.inspectEvaluator({tenants:[A],diagnostics:'clinical-result-v1'});assert.equal(dto.tenants[0].dueAt,due);assert.equal(dto.tenants[0].dueReason,'synthetic-future');const observed=dto.diagnostics.clinicalResults.tenants[0];assert.equal(observed.status,'eligible-model');assert.equal(observed.lastCompletedAgeMs!==null,true);assert.equal(observed.bgNow.meanFinite,false);assert.equal(runtime.last(A),null,'OBSERVATION_DOES_NOT_ACQUIRE_CONSUMER_AUTHORITY');}
   assert.deepEqual({calls,timers,sql:f.log.length,pending:f.pending.size,health:runtime.health([A]).tenants[0].cycles},before,'DUE_INSPECTION_MUST_NOT_CAUSE_WORK_OR_OWNERSHIP');
  }finally{await listener?.close();await runtime.close();await f.window.close();fs.rmSync(dir,{recursive:true,force:true});}
 });

});

// Static configuration is carried explicitly; this is not a peer census.
describe('static evaluator private ownership inspection',function(){
 const B='22222222-2222-4222-8222-222222222222',slice=require('../lib/pool-membership/slice');
 it('reports ordinal1 at K2 over the paired private v3 wire without scanning a roster or doing membership work',async()=>{
  let available=true,scans=0;const ids=new Map([[B,true]]),tenants=new Proxy(ids,{get(target,key){if(['keys','values','entries',Symbol.iterator].includes(key))return()=>{scans++;throw Error('STATIC_INSPECTION_ROSTER_SCAN');};return typeof target[key]==='function'?target[key].bind(target):target[key];}});
  const gate=require('../lib/pgstream/static-gate').create({shape:{count:2,ordinal:1},tenants:[B],available:()=>available});
  const row={tenant:B,jobs:{running:false,booting:false,acquire:false,time:false,parentAcquire:false,parentTime:false},dueAt:null,dueReason:null,ready:true,code:null,cycles:1,outputRevision:1,inputCheckpoint:1,evaluatedAgeMs:1,alert:null,progress:{generation:1,completedAcquisitions:1,completedTimeCycles:0,lastCompletedAgeMs:1,failedCompletions:0}};
  const inspect=inspection({tenants,gate,runtime:{health(selected){assert.deepEqual(selected,[B]);return{runtimeId:A,tenants:[row]};}},registry:{stats(){throw Error('STATIC_REGISTRY_STATS');}},startup:{health(){throw Error('STATIC_STARTUP_STATS');}}});
  const dir=createSocketDirectory(),endpoint={socketPath:path.join(dir,'inspect.sock'),maxBytes:1048576,timeoutMs:1000};let listener;
  try{listener=await transport.compose(endpoint,[{service,create:()=>({inspectEvaluator:(ctx,body)=>inspect(body)})}]);const client=transport.client(endpoint,service);
   for(let n=0;n<5;n++){const dto=await client.inspectEvaluator({tenants:[B]});assert.deepEqual(dto.configured,{mode:'static',count:2,ordinal:1,rule:slice.RULE,leaseMs:null,configuredTenants:1});assert.equal(dto.observed,null,'CONFIGURED_K_IS_NOT_A_LIVE_PEER_CENSUS');assert.equal(dto.gate.members,2);assert.equal(dto.gate.eligible,true);assert.equal(dto.gate.reads,0);assert.equal(dto.gate.heartbeats,null);assert.equal(dto.tenants[0].assignedOrdinal,1,'STATIC_INSPECTION_MUST_USE_CONFIGURED_K');assert.equal(dto.tenants[0].admitted,true);}
   assert.equal(scans,0);assert.equal(gate.admits(A),false,'WRONG_STATIC_OWNER_REFUSES');available=false;const lost=await client.inspectEvaluator({tenants:[B]});assert.equal(lost.gate.eligible,false);assert.equal(lost.tenants[0].admitted,false);assert.equal(lost.gate.reason,'EVALUATOR_OWNER_UNAVAILABLE');available=true;gate.close();assert.equal(gate.admits(B),false);assert.equal((await gate.inspect()).gate.reason,'EVALUATOR_STATIC_GATE_CLOSED');
   await assert.rejects(transport.client(endpoint,{...service,version:2}).inspectEvaluator({tenants:[B]}),/SOCKET_IPC_UNAVAILABLE/,'COORDINATED_PRIVATE_V3_UPGRADE_REQUIRED');
  }finally{await listener?.close();gate.close();fs.rmSync(dir,{recursive:true,force:true});}
 });
 it('uses exact K3/K7 ownership and a mutated K1 report turns the configured-owner criterion red, then restores',async()=>{
  const actual=require('../lib/pgstream/static-gate'),control=require('./lib/clinical-working-set/control'),crypto=require('node:crypto');
  const ids=Array.from({length:100},(_,i)=>crypto.createHash('sha256').update(String(i)).digest('hex').slice(0,32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/,'$1-$2-$3-$4-$5'));
  for(const count of [3,7])for(let ordinal=0;ordinal<count;ordinal++){const owned=ids.filter(t=>slice.bucket(t,count)===ordinal),gate=actual.create({shape:{count,ordinal},tenants:owned,available:()=>true}),view=await gate.inspect();for(const tenant of ids){assert.equal(view.owner(tenant),slice.bucket(tenant,count));assert.equal(view.admits(tenant),slice.bucket(tenant,count)===ordinal);}assert.equal(view.observed,null);gate.close();}
  assert.throws(()=>actual.create({shape:{count:2,ordinal:1},tenants:[A],available:()=>true}),/ROSTER_REFUSED/);
  const criterion=async module=>{const gate=module.create({shape:{count:2,ordinal:1},tenants:[B],available:()=>true});try{assert.equal((await gate.inspect()).owner(B),1,'STATIC_INSPECTION_MUST_USE_CONFIGURED_K');}finally{gate.close();}};
  const interval=global.setInterval;global.setInterval=()=>{throw Error('STATIC_MEMBERSHIP_TIMER_FORBIDDEN');};try{const quiet=actual.create({shape:{count:2,ordinal:1},tenants:[B],available:()=>true});quiet.start(100);await quiet.refresh();await quiet.inspect();quiet.close();}finally{global.setInterval=interval;}
  await criterion(actual);const broken=control('../lib/pgstream/static-gate','const owner=tenant=>bucket(tenant,shape.count);','const owner=tenant=>bucket(tenant,1);');await assert.rejects(criterion(broken),e=>e.code==='ERR_ASSERTION'&&e.message.includes('STATIC_INSPECTION_MUST_USE_CONFIGURED_K'));await criterion(actual);
 });
});
