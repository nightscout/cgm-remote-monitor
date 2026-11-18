'use strict';
const assert=require('node:assert/strict');
const protocol=require('./fixtures/operation-window-runtime-protocol'),lab=require('./fixtures/evaluator-verification-suspension');
const {create}=require('../lib/server/serve/evaluator-readiness-witness');
const {validate}=require('../lib/server/internal-api/schema');
const schema=require('../lib/server/internal-api/contracts').evaluatorReadinessWitness.operations.inspectReadinessWitness.response;
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',identity='a'.repeat(64),sourceIdentity='b'.repeat(64);
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function wait(fn){const end=Date.now()+2000;while(Date.now()<end){if(fn())return;await turn();}throw Error('FOCUSED_RUNTIME_OBSERVATION_DEADLINE');}
async function fixture({workerProvider=true,recovery=true}={}){
 const p=protocol({trustedWorker:true}),worker={available:true,generation:7};
 const f=await lab.create({window:p.window,tenants:[A,B],enabled:recovery,options:{readinessObservation:true,...(workerProvider?{workerState:()=>({...worker})}:{}),
  readCurrent:async tenant=>({tenant,identity,sourceIdentity,settingsVersion:'1',policyGeneration:'2'})}});
 const metadata={registryActive:true,assigned:true,sourceIdentity,settingsVersion:'1',policyGeneration:'2',paused:false,suspended:false};
 const options={runtimeId:f.runtime.runtimeId,hasTenant:tenant=>tenant===A||tenant===B,runtimeFacts:selected=>f.runtime.readinessFacts(selected),workerFacts:workerProvider?()=>({...worker}):undefined,
  windowFacts:()=>p.window.readinessFacts(),platformFacts:()=>({ready:true,code:null}),sourceFacts:()=>({healthy:true,schemaBlocked:false,schemaInFlight:0,ownerAvailable:true,acceptedCutReady:true}),metadataFacts:()=>({...metadata})};
 const inspect=()=>{const result=create(options)({runtimeId:f.runtime.runtimeId,tenants:[A]});validate(schema,result);return result.tenants[0];};
 return {p,f,worker,metadata,options,inspect,idle:()=>wait(()=>!Object.values(f.runtime.health([A]).tenants[0].jobs).some(Boolean)),close:async()=>{await f.close();await p.window.close();}};
}
describe('actual evaluator released-acquisition witness facts',function(){
 it('captures genuine owned release proof with observation selected and verification suspension unselected',async()=>{
  const x=await fixture({recovery:false});try{await x.f.runtime.acquire(A);await x.idle();assert.equal(x.inspect().classification,'ready');
   assert.equal(x.f.runtime.readinessFacts([A]).tenants[0].proof.windowCurrent,true);
  }finally{await x.close();}
 });
 it('records proof after successful owned release, while stock expiry and cached-output decisions remain unchanged',async()=>{
  const x=await fixture();try{
   assert.equal(x.inspect().acquisition.status,'unknown');await x.f.runtime.acquire(A);await x.idle();
   const proof=x.f.runtime.readinessFacts([A]).tenants[0].proof;assert(proof);assert.equal(proof.runtimeId,x.f.runtime.runtimeId);
   assert.equal(x.inspect().classification,'ready',JSON.stringify(x.inspect()));x.f.runtime.markPending(A,100);x.f.now=120100;
   const before=x.f.runtime.health([A]),peek=x.f.runtime.peek(A),witness=x.inspect();
   assert.equal(witness.classification,'clinical-expiry-only');assert.equal(witness.clinical.pendingBoundMs,120000);
   assert.equal(before.tenants[0].code,'EVALUATOR_CLINICAL_PROGRESS_STALLED');assert.equal(peek.eligible,false);
   for(let i=0;i<3;i++)x.inspect();assert.deepEqual(x.f.runtime.health([A]),before);assert.deepEqual(x.f.runtime.peek(A),peek);
   x.worker.available=false;assert.equal(x.inspect().worker.status,'refused');x.worker.available=true;x.worker.generation++;
   assert(x.inspect().faults.includes('WORKER_EPOCH_MISMATCH'));x.worker.generation--;assert.equal(x.inspect().classification,'clinical-expiry-only');
   x.metadata.policyGeneration='3';assert(x.inspect().faults.includes('METADATA_CHANGED'));
  }finally{await x.close();}
 });
 it('does not create released proof from durable completion while the outer child still drains or its final release refuses',async()=>{
  const x=await fixture();let lease,first=true;try{
   x.f.behavior=async tenant=>{const value=await x.p.window.acquireClient(x.p.client,tenant);if(first){first=false;lease=value;}else value.close();};
   await x.f.begin(A);x.f.hold.release.resolve();await wait(()=>x.f.completions===1);
   assert.equal(x.f.runtime.readinessFacts([A]).tenants[0].proof,null,'DURABLE_IS_NOT_RELEASE_PROOF');
   assert.equal(x.inspect().classification,'unknown');assert.equal(x.inspect().runtime.running,true);
   await x.f.verify();lease.close();await x.f.cycle;await x.idle();
   assert.equal(x.f.runtime.readinessFacts([A]).tenants[0].proof,null,'REFUSED_RELEASE_IS_NOT_PROOF');
   assert.equal(x.inspect().classification,'source-refused');assert.equal(x.f.runtime.health([A]).tenants[0].progress.failedCompletions,0);
   await x.f.finishVerification();await x.f.runtime.resumeVerification(A);await x.idle();assert.equal(x.inspect().classification,'ready',JSON.stringify(x.inspect()));
  }finally{lease?.close();await x.close();}
 });
 it('does not manufacture owned proof from borrowed work or a missing worker provider',async()=>{
  for(const provider of [true,false]){const x=await fixture({workerProvider:provider});try{
   if(provider)await x.p.window.run(A,()=>x.f.runtime.acquire(A));else await x.f.runtime.acquire(A);
   await x.idle();assert.equal(x.f.runtime.readinessFacts([A]).tenants[0].proof,null);assert.equal(x.inspect().acquisition.status,'unknown');
   assert.notEqual(x.inspect().independentStatus,'current');
  }finally{await x.close();}}
 });
 it('retires proof after discard/replacement and snapshots never mutate its retained tuple',async()=>{
  const x=await fixture();try{
   await x.f.runtime.acquire(A);await x.idle();const snapshot=x.f.runtime.readinessFacts([A]);snapshot.tenants[0].proof.generation=999;
   assert.notEqual(x.f.runtime.readinessFacts([A]).tenants[0].proof.generation,999);
   await x.f.runtime.invalidateTenant(A);assert.equal(x.f.runtime.readinessFacts([A]).tenants[0].proof,null);
   await x.f.runtime.removeTenant(A);x.f.runtime.addTenant(A);assert.equal(x.f.runtime.readinessFacts([A]).tenants[0].proof,null);
   assert.throws(()=>x.f.runtime.readinessFacts([]),/SELECTION_REFUSED/);
  }finally{await x.close();}
 });
 for(const kind of ['session','probe'])it('reports actual cached '+kind+' failure beside expiry without another query',async()=>{
  const x=await fixture();try{
   await x.f.runtime.acquire(A);await x.idle();x.f.runtime.markPending(A,100);x.f.now=120100;
   if(kind==='session')x.p.client.emit('error',Error('synthetic session loss'));
   else {const original=x.p.client.query;x.p.client.query=async(...args)=>{if(String(args[0]).includes('pg_backend_pid()'))throw Error('synthetic probe loss');return original(...args);};await assert.rejects(x.p.window.probe());}
   const queries=x.p.log.length,result=x.inspect();assert.equal(result.clinical.status,'expired');
   assert.equal(result.independentStatus,'refused');assert.equal(result.window.sessionLost,true);
   assert(result.faults.includes(kind==='session'?'WINDOW_SESSION_LOST':'WINDOW_PROBE_FAILED'));
   x.inspect();assert.equal(x.p.log.length,queries);
  }finally{await x.close();}
 });
 it('does not treat a pre-loss release as current after authority recovery without a fresh owned acquisition',async()=>{
  const x=await fixture();try{
   await x.f.runtime.acquire(A);await x.idle();x.f.runtime.markPending(A,100);x.f.now=120100;
   const original=x.p.client.query;x.p.client.query=async(...args)=>{if(String(args[0]).includes('pg_backend_pid()'))throw Error('synthetic probe loss');return original(...args);};
   await assert.rejects(x.p.window.probe());x.p.client.query=original;await x.p.window.recover();
   assert.notEqual(x.inspect().independentStatus,'current','OLD_RELEASE_MUST_NOT_CROSS_AUTHORITY_RECOVERY');
   await x.f.runtime.acquire(A);await x.idle();assert.equal(x.inspect().classification,'ready');
  }finally{await x.close();}
 });
 it('observes an actual trusted metadata pause before the runtime inactive flag changes, with no query from inspection',async()=>{
  let paused=false,queries=0;const reader=require('../lib/trusted-worker/postgres').create({stream:true,
   namespaces:{activity:'witness_activity',clock:'witness_clock',settings:'witness_settings',operatorPolicy:'witness_policy'},
   connection:{async readOnly(sql,values){queries++;if(sql.includes('FROM pg_class'))return {rows:values[0].map(()=>({secured:true,owns:false,writes:false}))};
    if(sql.includes('WHERE false'))return {rows:[]};assert(sql.includes('activity_version'));
    return {rows:values[0].map(tenant=>({tenant,activity_version:'1',paused,suspended:false,settings:'1',policy:'2',stamp:null,deleted:null}))};}}});
  const x=await fixture();try{
   await reader.verify();await reader.scan([A]);x.worker.generation=reader.state().generation;x.options.workerFacts=reader.state;
   x.options.metadataFacts=()=>{const row=reader.current(A);return {registryActive:true,assigned:true,sourceIdentity,
    settingsVersion:row?.settings,policyGeneration:row?.policy,paused:row?.activity.paused,suspended:row?.activity.suspended};};
   await x.f.runtime.acquire(A);await x.idle();assert.equal(x.inspect().independentStatus,'current');
   paused=true;await reader.scan([A]);const count=queries,result=x.inspect();
   assert.equal(x.f.runtime.health([A]).tenants[0].ready,true);assert.equal(result.runtime.inactive,false);
   assert.equal(result.metadata.paused,true);assert(result.faults.includes('ACTIVITY_PAUSED'));assert.equal(result.independentStatus,'refused');
   x.inspect();assert.equal(queries,count,'OBSERVATION_MUST_NOT_REFRESH_METADATA');
  }finally{await x.close();await reader.close();}
 });
});
