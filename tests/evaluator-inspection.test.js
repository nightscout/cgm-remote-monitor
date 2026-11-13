'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const inspection=require('../lib/server/serve/evaluator-inspection');
const transport=require('../lib/server/internal-api/transport'),service=require('../lib/server/internal-api/contracts').evaluatorInspection;
const A='11111111-1111-4111-8111-111111111111';
function fixture(count=10000, due={dueAt:null,dueReason:null}, changeFeed, clinical){
 const ids=Array.from({length:count},(_,i)=>String(i).padStart(8,'0')+'-1111-4111-8111-111111111111');
 let visited=0;const map=new Map(ids.map(id=>[id,true]));
 const tenants=new Proxy(map,{get(target,key){if(['keys','values','entries',Symbol.iterator].includes(key))return()=>{throw new Error('FULL_REGISTRY_ITERATION');};return typeof target[key]==='function'?target[key].bind(target):target[key];}});
 const row=tenant=>({tenant,jobs:{running:false,booting:false,acquire:false,time:false,parentAcquire:false,parentTime:false},...due,ready:true,code:null,cycles:5,outputRevision:1,inputCheckpoint:0,evaluatedAgeMs:1,alert:null,progress:{generation:1,completedAcquisitions:1,completedTimeCycles:4,lastCompletedAgeMs:1,failedCompletions:0}});
 const inspect=inspection({tenants,changeFeed,gate:{inspect:async()=>({configured:{mode:'standalone',ordinal:0,rule:null,leaseMs:null,configuredTenants:ids.length},observed:null,
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
describe('bounded evaluator inspection v2',function(){
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
 it('reads real O(1) consumer health only on explicit diagnostics and retains unavailable as unknown',async function(){
  const {EventEmitter}=require('node:events');let queries=0,checks=0,reads=0;
  const client=new EventEmitter();client.query=async()=>{queries++;};client.end=async()=>{};
  const f=fixture(10000),consumer=require('../lib/change-feed/consumer').create({config:{channel:'synthetic',pageSize:2,degradedPages:2,intervalMs:1000,heartbeatTimeoutMs:5000},tenants:f.ids,connect:async()=>client,check:async()=>{checks++;},alert(){}});
  const observer=fixture(10000,undefined,()=>{reads++;return{...consumer.health(),privateValue:'MUST_NOT_ESCAPE'};});
  await consumer.tick();const before={queries,checks};
  try{
   const ordinary=await observer.inspect({tenants:[]});assert(!Object.hasOwn(ordinary,'diagnostics'));assert.equal(reads,0);
   const dto=await observer.inspect({tenants:[],diagnostics:'change-feed-v1'});assert.equal(reads,1);assert(dto.diagnostics,'EXPECTED_SELECTED_FEED_HEALTH');assert.equal(dto.diagnostics.changeFeed.status,'observed');assert.deepEqual(dto.diagnostics.changeFeed.health,consumer.health());assert(!JSON.stringify(dto).includes('MUST_NOT_ESCAPE'));assert.deepEqual({queries,checks},before);assert.equal(observer.visited(),0);
   for(const [read,status] of [[undefined,'not-configured'],[()=>null,'not-configured'],[()=>{throw Error('PRIVATE_FAILURE');},'unavailable']]){
    const x=fixture(1,undefined,read),v=await x.inspect({tenants:[],diagnostics:'change-feed-v1'});assert.deepEqual(v.diagnostics.changeFeed,{status,health:null});
   }
   for(const next of [{},{...consumer.health(),checks:null},{...consumer.health(),pages:-1},{...consumer.health(),rotated:Infinity},{...consumer.health(),heartbeatAgeMs:undefined},{...consumer.health(),refusal:'PRIVATE_FAILURE'}]){
    const x=fixture(1,undefined,()=>next);await assert.rejects(x.inspect({tenants:[],diagnostics:'change-feed-v1'}),/feed inspection refused/);
   }
   for(const diagnostics of [false,true,'unknown'])await assert.rejects(observer.inspect({tenants:[],diagnostics}),/diagnostics selector refused/);
  }finally{await consumer.close();}
 });
 it('keeps default v2 wire compatibility, strict diagnostic schema and existing transport authority',async function(){
  let reads=0;const health={live:true,connected:false,degraded:true,recoveryRemaining:0,heartbeatAgeMs:null,refusal:'FEED_LISTENER_UNAVAILABLE',pages:0,checks:0,hints:0,refused:0,reconnects:0,sweeps:0,rotated:0};
  const f=fixture(1,undefined,()=>{reads++;return health;});const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evaluator-feed-inspection-')),endpoint={socketPath:path.join(dir,'inspect.sock'),maxBytes:1024*1024,timeoutMs:1000};let listener,corrupt=false;
  try{
   listener=await transport.compose(endpoint,[{service,create:()=>({inspectEvaluator:async(ctx,body)=>{const v=await f.inspect(body);if(corrupt)v.diagnostics.changeFeed.health.checks=null;return v;}})}]);
   const client=transport.client(endpoint,service),old=JSON.parse(JSON.stringify(service));delete old.operations.inspectEvaluator.request.properties.diagnostics;delete old.operations.inspectEvaluator.response.properties.diagnostics;
   await transport.client(endpoint,old).inspectEvaluator({tenants:[]});assert.equal(reads,0);
   const dto=await client.inspectEvaluator({tenants:[],diagnostics:'change-feed-v1'});assert.deepEqual(dto.diagnostics.changeFeed,{status:'observed',health});assert.equal(reads,1);
   for(const body of [{tenants:[],diagnostics:false},{tenants:[],diagnostics:'unknown'},{tenants:[],diagnostics:'change-feed-v1',unknown:true}])await assert.rejects(client.inspectEvaluator(body));assert.equal(reads,1);
   corrupt=true;await assert.rejects(client.inspectEvaluator({tenants:[],diagnostics:'change-feed-v1'}),/SOCKET_IPC_UNAVAILABLE/);corrupt=false;
   await client.inspectEvaluator({tenants:[],diagnostics:'change-feed-v1'});
   let invoked=0,status;const handler=transport.handler({service,token:Symbol('private'),operations:{inspectEvaluator:async(ctx,body)=>{invoked++;return f.inspect(body);}},admitted:()=>false});
   const request={method:'POST',url:'/evaluator/inspect',headers:{'x-nightscout-internal-service':service.id,'x-nightscout-internal-version':String(service.version),'content-type':'application/json'},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({tenants:[],diagnostics:'change-feed-v1'}));},destroy(){}};
   const before=reads;await handler(request,{writeHead(code){status=code;},end(){}});assert.equal(invoked,0,'AUTHORITY_REFUSAL_BEFORE_DIAGNOSTIC_DISPATCH');assert.equal(reads,before);assert.equal(status,503);
  }finally{await listener?.close();fs.rmSync(dir,{recursive:true,force:true});}
 });
 it('exposes clinical results only for explicit bounded selection through strict paired private transport',async function(){
  let reads=0;const observation=tenant=>({tenant,status:'eligible-model',generation:2,outputRevision:3,inputCheckpoint:4,lastCompletedAgeMs:5,retainedModelAt:1700000000000,bgNow:{meanPresent:true,meanFinite:true,mills:1699999990000}});
  const f=fixture(10000,undefined,undefined,selected=>{reads++;return selected.map(observation);});
  const ordinary=await f.inspect({tenants:[f.ids[0]]});assert.equal(reads,0);assert(!Object.hasOwn(ordinary,'diagnostics'));
  for(const tenants of [undefined,[],[f.ids[0],f.ids[0]],f.ids.slice(0,129)])await assert.rejects(f.inspect({tenants,diagnostics:'clinical-result-v1'}),/selector refused/);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evaluator-clinical-inspection-')),endpoint={socketPath:path.join(dir,'inspect.sock'),maxBytes:1024*1024,timeoutMs:1000};let listener,corrupt;
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
 it('actual evaluator role boot supplies its owned feed observer to the existing inspection module',async function(){
  const Module=require('node:module'),scope=require('../lib/storage/tenant-scope'),previous=scope.getTenancyMode();let observed,reads=0,closed=0;
  const feed={health(){reads++;return{synthetic:'owned-health'};},close:async()=>{closed++;},resync(){}};
  const filename=require.resolve('../lib/server/serve/evaluator-preview'),loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));const original=loaded.require.bind(loaded);
  const ports={
   '../../storage/postgres-connection':async()=>({end:async()=>{}}),
   './evaluator-readiness':Object.assign(async()=>{},{provisionTenant:async()=>{}}),
   './evaluator-consumers':{prepare:async()=>null},
   './evaluator-runtime':async()=>({close:async()=>{},health:()=>({}),last(){},isCurrent(){}}),
   '../../change-feed/consumer':{start:async()=>feed},
   './evaluator-inspection':options=>{observed=options;return()=>options.changeFeed();}
  };
  loaded.require=name=>Object.hasOwn(ports,name)?ports[name]:original(name);loaded._compile(fs.readFileSync(filename,'utf8'),filename);
  let role;try{
   role=await loaded.exports.boot({tenants:new Map([[A,{}]]),maxTenants:1,changeFeed:{},namespaces:{},consumer:'synthetic'});
   assert.equal(typeof observed.changeFeed,'function','BOOT_MUST_WIRE_OWNED_FEED_HEALTH');assert.equal(reads,0);assert.deepEqual(role.inspect(),{synthetic:'owned-health'});assert.equal(reads,1);
  }finally{await role?.close();scope.setTenancyMode(previous);}assert.equal(closed,1);
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
 it('carries selected v2 bodies over the actual private UDS client and refuses the prior module version',async function(){
  const due={dueAt:Date.now()+60000,dueReason:'slow:alarm-message'},f=fixture(10000,due),dir=fs.mkdtempSync(path.join(os.tmpdir(),'evaluator-inspection-'));let listener;
  const endpoint={socketPath:path.join(dir,'inspect.sock'),maxBytes:1024*1024,timeoutMs:1000};let corrupt=false,jobCorruption=false;
  try{
   listener=await transport.compose(endpoint,[{service,create:()=>({inspectEvaluator:async(context,body)=>{const dto=await f.inspect(body);if(corrupt&&dto.tenants.length)dto.tenants[0].dueReason=corrupt;if(jobCorruption&&dto.tenants.length)dto.tenants[0].jobs.running=0;return dto;}})}]);
   const client=transport.client(endpoint,service);
   assert.deepEqual((await client.inspectEvaluator({tenants:[]})).tenants,[]);
   const dto=await client.inspectEvaluator({tenants:[f.ids[9999]]});assert.equal(dto.tenants[0].tenant,f.ids[9999]);assert.equal(dto.tenants[0].dueAt,due.dueAt);assert.equal(dto.tenants[0].dueReason,due.dueReason);
   for(const next of [fractionalDue(),{dueAt:1,dueReason:'sgv-recent-10'},{dueAt:null,dueReason:null}]){Object.assign(due,next);const observed=await client.inspectEvaluator({tenants:[f.ids[0]]});assert.equal(observed.tenants[0].dueAt,next.dueAt);assert.equal(observed.tenants[0].dueReason,next.dueReason);}
   for(const invalid of ['a'.repeat(129),'stale-reason']){due.dueAt=invalid==='stale-reason'?null:1;corrupt=invalid;await assert.rejects(client.inspectEvaluator({tenants:[f.ids[0]]}),/SOCKET_IPC_UNAVAILABLE/,'SCHEMA_REFUSES_INVALID_REASON');}corrupt=false;await client.inspectEvaluator({tenants:[f.ids[0]]});
   jobCorruption=true;await assert.rejects(client.inspectEvaluator({tenants:[f.ids[0]]}),/SOCKET_IPC_UNAVAILABLE/,'SCHEMA_REFUSES_NONBOOLEAN_JOB_STATE');jobCorruption=false;
   const oldV2=JSON.parse(JSON.stringify(service));const oldRows=oldV2.operations.inspectEvaluator.response.properties.tenants.items;delete oldRows.properties.dueAt;delete oldRows.properties.dueReason;delete oldRows.anyOf;oldRows.required=oldRows.required.filter(key=>!['dueAt','dueReason'].includes(key));
   await assert.rejects(transport.client(endpoint,oldV2).inspectEvaluator({tenants:[f.ids[0]]}),/SOCKET_IPC_UNAVAILABLE/,'OLD_STRICT_V2_CLIENT_MUST_NOT_SILENTLY_ACCEPT_NEW_FIELDS');
   const empty=fixture(0),emptyDir=path.join(dir,'empty.sock');
   const emptyEndpoint={...endpoint,socketPath:emptyDir};
   const emptyListener=await transport.compose(emptyEndpoint,[{service,create:()=>({inspectEvaluator:(context,body)=>empty.inspect(body)})}]);
   try { const dto=await transport.client(emptyEndpoint,service).inspectEvaluator({tenants:[]});assert.equal(dto.configured.configuredTenants,0);assert.deepEqual(dto.tenants,[]); } finally { await emptyListener.close(); }
   const old=transport.client(endpoint,{...service,version:1});await assert.rejects(old.inspectEvaluator({tenants:[]}),/SOCKET_IPC_UNAVAILABLE/);
  }finally{await listener?.close();fs.rmSync(dir,{recursive:true,force:true});}
 });
 it('actual runtime/window inspection over private UDS does not schedule work or acquire tenant authority',async function(){
  const runtimeFactory=require('../lib/server/serve/evaluator-runtime'),jobs=require('../lib/server/serve/evaluator-job-context');
  const f=require('./fixtures/operation-window-runtime-protocol')();await f.window.ready();
  const context=jobs.create('clinical');let calls=0,timers=0;const due=Date.now()+60000;
  const result=()=>({checkpoint:1,signature:{stamp:1,deleted:0},emitted:[],requested:[],properties:{},due:{dueAt:due,reason:'synthetic-future',slow:[]}});
  const runtime=await runtimeFactory({tenants:[A],operationWindow:f.window,jobContext:context,readCurrent:async()=>({tenant:A,identity:'a'.repeat(64)}),create:async()=>({evaluate:async()=>{calls++;return result();},evaluateTime:async()=>{calls++;return result();},close(){}}),recoveryIntervalMs:10000,timeIntervalMs:10000,schedule:()=>({}),cancel(){},setTimer:()=>{timers++;return {};},clearTimer(){}});
  const inspect=inspection({tenants:new Map([[A,true]]),runtime,gate:{inspect:async()=>({configured:{mode:'standalone',ordinal:0,rule:null,leaseMs:null,configuredTenants:1},observed:null,gate:{eligible:true,reason:null,members:null,reads:0,refusals:0,changes:0,checkedAgeMs:null,heartbeats:null},owner:()=>null,admits:()=>true})}});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evaluator-due-native-')),endpoint={socketPath:path.join(dir,'inspect.sock'),maxBytes:1024*1024,timeoutMs:1000};let listener;
  try{
   listener=await transport.compose(endpoint,[{service,create:()=>({inspectEvaluator:(ctx,body)=>inspect(body)})}]);const client=transport.client(endpoint,service);
   const before={calls,timers,sql:f.log.length,pending:f.pending.size,health:runtime.health([A]).tenants[0].cycles};
   for(let i=0;i<10;i++){const dto=await client.inspectEvaluator({tenants:[A],diagnostics:'clinical-result-v1'});assert.equal(dto.tenants[0].dueAt,due);assert.equal(dto.tenants[0].dueReason,'synthetic-future');const observed=dto.diagnostics.clinicalResults.tenants[0];assert.equal(observed.status,'eligible-model');assert.equal(observed.lastCompletedAgeMs!==null,true);assert.equal(observed.bgNow.meanFinite,false);assert.equal(runtime.last(A),null,'OBSERVATION_DOES_NOT_ACQUIRE_CONSUMER_AUTHORITY');}
   assert.deepEqual({calls,timers,sql:f.log.length,pending:f.pending.size,health:runtime.health([A]).tenants[0].cycles},before,'DUE_INSPECTION_MUST_NOT_CAUSE_WORK_OR_OWNERSHIP');
  }finally{await listener?.close();await runtime.close();await f.window.close();fs.rmSync(dir,{recursive:true,force:true});}
 });

});
