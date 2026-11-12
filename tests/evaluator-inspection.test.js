'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const inspection=require('../lib/server/serve/evaluator-inspection');
const transport=require('../lib/server/internal-api/transport'),service=require('../lib/server/internal-api/contracts').evaluatorInspection;
const A='11111111-1111-4111-8111-111111111111';
function fixture(count=10000){
 const ids=Array.from({length:count},(_,i)=>String(i).padStart(8,'0')+'-1111-4111-8111-111111111111');
 let visited=0;const map=new Map(ids.map(id=>[id,true]));
 const tenants=new Proxy(map,{get(target,key){if(['keys','values','entries',Symbol.iterator].includes(key))return()=>{throw new Error('FULL_REGISTRY_ITERATION');};return typeof target[key]==='function'?target[key].bind(target):target[key];}});
 const row=tenant=>({tenant,ready:true,code:null,cycles:5,outputRevision:1,inputCheckpoint:0,evaluatedAgeMs:1,alert:null,progress:{generation:1,completedAcquisitions:1,completedTimeCycles:4,lastCompletedAgeMs:1,failedCompletions:0}});
 const inspect=inspection({tenants,gate:{inspect:async()=>({configured:{mode:'standalone',ordinal:0,rule:null,leaseMs:null,configuredTenants:ids.length},observed:null,
  gate:{eligible:true,reason:null,members:null,reads:0,refusals:0,changes:0,checkedAgeMs:null,heartbeats:null},owner:()=>null,admits:()=>true})},
 runtime:{health(selected){assert(Array.isArray(selected),'BOUNDED_RUNTIME_SELECTOR_REQUIRED');visited+=selected.length;return{runtimeId:A,tenants:selected.map(row)};}},
 consumers:{health(selected){assert(Array.isArray(selected),'BOUNDED_DELIVERY_SELECTOR_REQUIRED');visited+=selected.length;return{tenants:selected.map(tenant=>({tenant,state:'idle',code:null,passes:1,repeatAt:null}))};}},
 registry:{stats(){throw new Error('FULL_REGISTRY_STATS');}},startup:{health(){throw new Error('FULL_STARTUP_STATS');}}});
 return{inspect,ids,visited:()=>visited};
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
 it('carries selected v2 bodies over the actual private UDS client and refuses the prior module version',async function(){
  const f=fixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'evaluator-inspection-'));let listener;
  const endpoint={socketPath:path.join(dir,'inspect.sock'),maxBytes:1024*1024,timeoutMs:1000};
  try{
   listener=await transport.compose(endpoint,[{service,create:()=>({inspectEvaluator:(context,body)=>f.inspect(body)})}]);
   const client=transport.client(endpoint,service);
   assert.deepEqual((await client.inspectEvaluator({tenants:[]})).tenants,[]);
   const dto=await client.inspectEvaluator({tenants:[f.ids[9999]]});assert.equal(dto.tenants[0].tenant,f.ids[9999]);
   const empty=fixture(0),emptyDir=path.join(dir,'empty.sock');
   const emptyEndpoint={...endpoint,socketPath:emptyDir};
   const emptyListener=await transport.compose(emptyEndpoint,[{service,create:()=>({inspectEvaluator:(context,body)=>empty.inspect(body)})}]);
   try { const dto=await transport.client(emptyEndpoint,service).inspectEvaluator({tenants:[]});assert.equal(dto.configured.configuredTenants,0);assert.deepEqual(dto.tenants,[]); } finally { await emptyListener.close(); }
   const old=transport.client(endpoint,{...service,version:1});await assert.rejects(old.inspectEvaluator({tenants:[]}),/SOCKET_IPC_UNAVAILABLE/);
  }finally{await listener?.close();fs.rmSync(dir,{recursive:true,force:true});}
 });
});
