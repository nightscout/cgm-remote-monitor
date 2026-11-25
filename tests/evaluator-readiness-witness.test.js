'use strict';
const assert=require('node:assert/strict');
const {create}=require('../lib/server/serve/evaluator-readiness-witness');
const {validate}=require('../lib/server/internal-api/schema');
const response=require('../lib/server/internal-api/contracts').evaluatorReadinessWitness.operations.inspectReadinessWitness.response;
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',R='33333333-3333-4333-8333-333333333333';
const identity='a'.repeat(64),sourceIdentity='b'.repeat(64);
function fixture(){
 const row={tenant:A,generation:3,acquired:true,code:null,inactive:false,withdrawn:false,booting:false,running:false,metadataPaused:false,verificationPending:false,
  identity,sourceIdentity,settingsVersion:'1',policyGeneration:'2',pendingSince:100,pendingBoundMs:120000,
  proof:{tenant:A,runtimeId:R,generation:3,workerGeneration:7,identity,sourceIdentity,settingsVersion:'1',policyGeneration:'2',windowCurrent:true}};
 const facts={runtime:{runtimeId:R,observedAt:120100,closed:false,tenants:[row]},worker:{available:true,generation:7},
  metadata:{registryActive:true,assigned:true,sourceIdentity,settingsVersion:'1',policyGeneration:'2',paused:false,suspended:false},
  window:{closed:false,operational:true,verifying:false,verificationFailed:false,sessionLost:false,probeFailed:false},
  platform:{ready:true,code:null},source:{healthy:true,schemaBlocked:false,schemaInFlight:0,ownerAvailable:true,acceptedCutReady:true}};
 const reads={};const options={runtimeId:R,hasTenant:tenant=>tenant===A||tenant===B};
 for(const key of ['runtime','worker','metadata','window','platform','source'])options[key+'Facts']=()=>{reads[key]=(reads[key]||0)+1;return facts[key];};
 const request={runtimeId:R,tenants:[A]};
 return {facts,row,reads,options,request,inspect:()=>{const value=create(options)(request);validate(response,value);return value.tenants[0];}};
}
describe('private selected evaluator readiness witness',function(){
 it('separates clinical expiry from positive current release and all independent cached facts',()=>{
  const f=fixture(),row=f.inspect();assert.equal(row.clinical.status,'expired');assert.equal(row.clinical.pendingAgeMs,120000);
  assert.equal(row.independentStatus,'current');assert.equal(row.classification,'clinical-expiry-only');assert.equal(row.acquisition.status,'current');assert.deepEqual(row.faults,[]);
  f.facts.runtime.observedAt=120099;assert.equal(f.inspect().classification,'ready');f.row.pendingSince=null;assert.equal(f.inspect().clinical.status,'none');
 });
 for(const expired of [false,true])for(const kind of ['unavailable','generation'])it('retains '+kind+' worker fault with clinical expiry '+expired,()=>{
  const f=fixture();if(!expired)f.facts.runtime.observedAt=100;
  if(kind==='unavailable')f.facts.worker.available=false;else f.facts.worker.generation++;
  const row=f.inspect();assert.equal(row.classification,'source-refused');assert.equal(row.independentStatus,'refused');
  assert(row.faults.includes(kind==='unavailable'?'WORKER_UNAVAILABLE':'WORKER_EPOCH_MISMATCH'));
 });
 it('does not replace a complete accepted source cut with healthy/schema-verified or unrelated receiver activity',()=>{
  const f=fixture();f.facts.source.acceptedCutReady=false;assert.equal(f.inspect().source.status,'refused');assert(f.inspect().faults.includes('SOURCE_ACCEPTANCE_PENDING'));
  f.facts.source.acceptedCutReady=true;f.facts.source.receiverInFlight=9;assert.equal(f.inspect().independentStatus,'current');
 });
 for(const key of ['runtime','worker','metadata','window','platform','source'])for(const missing of [true,false])it('keeps '+key+' '+(missing?'absence':'provider throw')+' unknown',()=>{
  const f=fixture();f.options[key+'Facts']=missing?undefined:()=>{throw new Error('private provider detail');};const row=f.inspect();
  assert.equal(row.independentStatus,'unknown');assert.equal(row.classification,'unknown');assert(!JSON.stringify(row).includes('private provider detail'));
 });
 it('rejects malformed, asynchronous, accessor and oversized cached provider values without executing accessors',async()=>{
  const f=fixture();for(const value of [{available:'true',generation:7},{available:true,generation:-1},{available:true,generation:NaN},Promise.reject(Error('private async detail'))]){
   f.options.workerFacts=()=>value;assert.equal(f.inspect().worker.status,'unknown');
  }
  let invoked=0;f.options.workerFacts=()=>({get available(){invoked++;throw Error('forbidden accessor');},generation:7});
  assert.equal(f.inspect().worker.status,'unknown');assert.equal(invoked,0);
  f.options.workerFacts=()=>({available:true,generation:7,unexpected:'x'.repeat(257)});assert.equal(f.inspect().worker.status,'unknown');
  await new Promise(resolve=>setImmediate(resolve));
 });
 for(const [key,value]of [['tenant',B],['runtimeId',B],['generation',4],['identity','c'.repeat(64)],['sourceIdentity','c'.repeat(64)],['settingsVersion','9'],['policyGeneration','9']])it('rejects released proof crossing '+key,()=>{
  const f=fixture();f.row.proof[key]=value;const row=f.inspect();assert.equal(row.acquisition.status,'refused');assert(row.faults.includes('ACQUISITION_SCOPE_MISMATCH'));
 });
 it('does not use counters, idle flags or retained acquisition state as proof',()=>{
  const f=fixture();f.row.proof=null;f.row.completedAcquisitions=100;f.row.failedCompletions=0;f.row.running=false;f.row.acquired=true;
  assert.equal(f.inspect().acquisition.status,'unknown');assert.equal(f.inspect().classification,'unknown');
 });
 it('keeps missing or retired private window history out of current acquisition proof',()=>{
  const f=fixture();f.row.proof.windowCurrent=null;assert.equal(f.inspect().acquisition.status,'unknown');
  f.row.proof.windowCurrent=false;assert.equal(f.inspect().acquisition.status,'refused');assert(f.inspect().faults.includes('ACQUISITION_WINDOW_CHANGED'));
 });
 it('retains the complete refusal and unknown vector beside expired clinical debt',()=>{
  const f=fixture();f.row.code='EVALUATOR_TIME_REFUSED';f.facts.worker.available=false;f.facts.worker.generation++;
  Object.assign(f.facts.window,{operational:false,verifying:true,verificationFailed:true,sessionLost:true,probeFailed:true});
  f.facts.platform.ready=false;f.facts.platform.code='PLATFORM_VERIFICATION_REQUIRED';
  Object.assign(f.facts.source,{healthy:false,schemaBlocked:true,schemaInFlight:1,ownerAvailable:false,acceptedCutReady:false});
  Object.assign(f.facts.metadata,{registryActive:false,assigned:false,policyGeneration:'4'});
  const row=f.inspect();assert.equal(row.clinical.status,'expired');assert.equal(row.runtime.underlyingCode,'EVALUATOR_TIME_REFUSED');
  for(const code of ['RUNTIME_REFUSED','WORKER_UNAVAILABLE','WORKER_EPOCH_MISMATCH','WINDOW_VERIFYING','WINDOW_VERIFICATION_FAILED','WINDOW_SESSION_LOST','WINDOW_PROBE_FAILED','PLATFORM_REFUSED','SOURCE_OWNER_UNAVAILABLE','SOURCE_ACCEPTANCE_PENDING','SCHEMA_VERIFYING','REGISTRY_INACTIVE','ASSIGNMENT_REFUSED','METADATA_CHANGED'])assert(row.faults.includes(code),code);
  f.options.workerFacts=undefined;const unknown=f.inspect();assert.equal(unknown.independentStatus,'refused');assert(unknown.faults.includes('WORKER_UNKNOWN'));assert(unknown.faults.includes('WINDOW_SESSION_LOST'));
 });
 it('preserves each known runtime refusal even when an unrelated required runtime fact is unknown',()=>{
  const f=fixture();delete f.row.generation;delete f.row.booting;f.facts.runtime.closed=true;
  Object.assign(f.row,{code:'EVALUATOR_WINDOW_REFUSED',inactive:true,withdrawn:true,metadataPaused:true,verificationPending:true});
  const row=f.inspect();assert.equal(row.independentStatus,'refused');assert.equal(row.runtime.underlyingCode,'EVALUATOR_WINDOW_REFUSED');
  for(const code of ['RUNTIME_UNKNOWN','RUNTIME_CLOSED','RUNTIME_REFUSED','TENANT_INACTIVE','TENANT_WITHDRAWN','METADATA_PAUSED','VERIFICATION_PENDING'])assert(row.faults.includes(code),code);
 });
 it('requires current worker and metadata observations for the acquisition subgroup as well',()=>{
  const f=fixture();f.options.workerFacts=undefined;assert.equal(f.inspect().acquisition.status,'unknown');
  f.options.workerFacts=()=>f.facts.worker;f.facts.worker.available=false;assert.equal(f.inspect().acquisition.status,'refused');
  f.facts.worker.available=true;f.options.metadataFacts=undefined;assert.equal(f.inspect().acquisition.status,'unknown');
 });
 it('reports a cached activity refusal before runtime eligibility has caught up',()=>{
  const f=fixture();f.facts.metadata.paused=true;f.facts.metadata.suspended=true;
  const row=f.inspect();assert.equal(row.runtime.inactive,false);assert.equal(row.runtime.underlyingCode,null);
  assert.equal(row.metadata.paused,true);assert.equal(row.metadata.suspended,true);assert.equal(row.independentStatus,'refused');
  assert(row.faults.includes('ACTIVITY_PAUSED'));assert(row.faults.includes('ACTIVITY_SUSPENDED'));assert.equal(row.acquisition.status,'refused');
 });
 it('validates selection and runtime before reading any fact provider',()=>{
  const f=fixture(),inspect=create(f.options);for(const request of [{},{runtimeId:R,tenants:[]},{runtimeId:R,tenants:[A,A]},{runtimeId:B,tenants:[A]},
   {runtimeId:R,tenants:[R]},{runtimeId:R,tenants:[A],unexpected:true},{runtimeId:R,tenants:[{}]},{runtimeId:R,tenants:Array(129).fill(A)}]){
   assert.throws(()=>inspect(request),{code:'EVALUATOR_READINESS_SELECTION_REFUSED'});assert.deepEqual(f.reads,{});
  }
 });
 it('requires positive cached tenant selection rather than truthy, asynchronous or throwing selectors',async()=>{
  for(const value of [undefined,null,false,'true',{},Promise.resolve(true),Promise.reject(Error('private selector failure'))]){
   const f=fixture();f.options.hasTenant=()=>value;assert.throws(()=>create(f.options)(f.request),{code:'EVALUATOR_READINESS_SELECTION_REFUSED'});assert.deepEqual(f.reads,{});
  }
  const f=fixture();f.options.hasTenant=()=>{throw Error('private selector detail');};assert.throws(()=>create(f.options)(f.request),{code:'EVALUATOR_READINESS_SELECTION_REFUSED'});assert.deepEqual(f.reads,{});
  await new Promise(resolve=>setImmediate(resolve));
 });
 it('copies selected cached facts without mutating provider state or using any work/output/verification method',()=>{
  const f=fixture(),before=JSON.stringify(f.facts);let forbidden=0;
  for(const name of ['query','scan','read','verify','probe','acquire','wake','repair','output','warm','admit'])f.options[name]=()=>{forbidden++;throw Error('forbidden effect');};
  const inspect=create(f.options),one=inspect(f.request);one.tenants[0].clinical.pendingSince=1;one.tenants[0].faults.push('invented');
  const two=inspect(f.request);assert.equal(two.tenants[0].clinical.pendingSince,100);assert.deepEqual(two.tenants[0].faults,[]);
  assert.equal(JSON.stringify(f.facts),before);assert.equal(forbidden,0);assert.deepEqual(Object.values(f.reads),[2,2,2,2,2,2]);
 });
});
module.exports={fixture};
