'use strict';
const assert=require('node:assert/strict');
const fixture=require('./fixtures/operation-window-runtime-protocol');
const lab=require('./fixtures/evaluator-verification-suspension');
const windows=require('../lib/tenant-lifecycle/operation-window');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const row=f=>f.runtime.health([A]).tenants[0];
async function setup(options={},enabled=true){const p=fixture({trustedWorker:true,...options});const f=await lab.create({window:p.window,tenants:[A,B],enabled});return {p,f};}
async function cleanup(p,f){await f.close();await p.window.close();}

describe('opt-in verification suspension branch prototype',function(){
 it('releases cycle and scope, stays unavailable through downstream schema work, then freshly acquires without failed credit',async()=>{
  const {p,f}=await setup();
  try{
   await f.runtime.acquire(A);const before=row(f).progress;
   f.sourceReady=false;f.behavior=tenant=>p.window.currentGeneration(tenant);
   await f.begin(A);await f.verify();await f.releaseCycle();await turn();
   const pending=row(f);assert.equal(pending.jobs.running,false,'SUSPENSION_RELEASES_RUNNING');
   assert.equal(pending.ready,false);assert.equal(f.runtime.peek(A),null);
   assert.equal(pending.progress.failedCompletions,before.failedCompletions,'VALID_PENDING_IS_NOT_FAILED_WORK');
   assert.equal(pending.progress.completedAcquisitions,before.completedAcquisitions);
   assert.equal(pending.progress.verificationSuspensions,1);assert.equal(pending.progress.verificationPending,true);
   // Actual onSchema ordering: window verification, then runtime invalidation.
   await f.finishVerification();await f.runtime.invalidateTenant(A);
   assert.equal(await f.runtime.resumeVerification(A),false,'WINDOW_SUCCESS_IS_NOT_SOURCE_READINESS');
   assert.equal(row(f).progress.completedAcquisitions,before.completedAcquisitions);
   f.sourceReady=true;assert.equal(await f.runtime.resumeVerification(A),true);
   const after=row(f);assert.equal(after.ready,true);assert.equal(after.progress.failedCompletions,before.failedCompletions);
   assert.equal(after.progress.completedAcquisitions,before.completedAcquisitions+1);assert.equal(after.progress.verificationPending,false);
   assert.equal(f.creations,2,'RESUME_CREATES_FRESH_COMPONENT');
  }finally{await cleanup(p,f);}
 });
 it('keeps the clinical pending timestamp and 120-second refusal while verification is held',async()=>{
  const {p,f}=await setup();try{
   f.runtime.markPending(A,100);f.behavior=tenant=>p.window.currentGeneration(tenant);
   await f.begin(A);await f.verify();await f.releaseCycle();f.now=120100;
   assert.equal(row(f).code,'EVALUATOR_CLINICAL_PROGRESS_STALLED');assert.equal(row(f).ready,false);
   assert.equal(f.runtime.pendingWitness([A])[0].memory.pendingSince,100);
   assert.equal(row(f).progress.lastCompletedAgeMs,null);
   await f.finishVerification();f.sourceReady=true;await f.runtime.resumeVerification(A);
   assert.equal(row(f).ready,true);assert.equal(row(f).progress.failedCompletions,0);
  }finally{await cleanup(p,f);}
 });
 for(const [name,behavior]of [
  ['foreign tenant',(p,f)=>()=>p.window.currentGeneration(B)],
  ['missing scope',(p,f)=>()=>f.job.run(()=>p.window.currentGeneration(A))],
  ['invalidated scope',(p,f)=>()=>{p.window.invalidateTenant(A);return p.window.currentGeneration(A);}],
  ['unrelated feed error',(p,f)=>()=>{throw new Error('EVALUATOR_FEED_UNAVAILABLE');}]
 ])it('retains a hard failure for '+name+' during the same pending check',async()=>{
  const {p,f}=await setup();try{
   f.behavior=behavior(p,f);await f.begin(A);await f.verify();await f.releaseCycle();
   assert.equal(row(f).progress.failedCompletions,1);assert.equal(row(f).progress.verificationSuspensions,0);assert.equal(row(f).progress.completedAcquisitions,0);
   await f.finishVerification();assert.equal(await f.runtime.resumeVerification(A),false);
  }finally{await cleanup(p,f);}
 });
 it('does not suppress inactive or closing scope errors rethrown into another admission',async()=>{
  for(const closing of [false,true]){const {p,f}=await setup();let original,later,lease;try{
   await p.window.run(A,async()=>{
    if(closing)lease=await p.window.acquireClient(p.client,A);
    later=new Promise(resolve=>setImmediate(()=>{try{p.window.assertCurrent(A);}catch(error){original=error;}lease?.close();resolve();}));
   });await later;
   assert.equal(windows.failureGuard(p.window,original),closing?'scope-closing':'scope-inactive');
   f.behavior=()=>{throw original;};await f.begin(A);await f.verify();await f.releaseCycle();
   assert.equal(row(f).progress.failedCompletions,1);assert.equal(row(f).progress.verificationSuspensions,0);
  }finally{lease?.close();await cleanup(p,f);}}
 });
 it('rejects a genuine pending error replayed from a different admitted scope',async()=>{
  const {p,f}=await setup();let captured,release,captureCheck,receipt;try{
   const entered=lab.hold(),body=lab.hold(),checked=lab.hold();captureCheck=lab.hold();
   const running=p.window.run(A,async()=>{entered.resolve();await body.promise;try{p.window.currentGeneration(A);}catch(error){captured=error;}},{onScope:value=>{receipt=value;}}).catch(()=>{});
   await entered.promise;release=p.window.verifyOperational(async()=>{checked.resolve();await captureCheck.promise;});await checked.promise;body.resolve();await running;captureCheck.resolve();await release;
   assert.equal(windows.failureGuard(p.window,captured),'verification-pending');
   assert(windows.verificationSuspension(p.window,A,captured,receipt),'ORIGINAL_SCOPE_HAS_REAL_SUSPENSION_PROVENANCE');
   f.behavior=()=>{throw captured;};await f.begin(A);await f.verify();await f.releaseCycle();
   assert.equal(row(f).progress.failedCompletions,1);assert.equal(row(f).progress.verificationSuspensions,0);
  }finally{captureCheck?.resolve();await release?.catch(()=>{});await cleanup(p,f);}
 });
 it('does not rebrand an old body after authority failed and a new check began',async()=>{
  const {p,f}=await setup();try{
   f.behavior=tenant=>p.window.currentGeneration(tenant);await f.begin(A);
   await assert.rejects(p.window.verifyOperational(()=>{throw Error('synthetic actual authority refusal');}));
   await f.verify();await f.releaseCycle();
   assert.equal(row(f).progress.failedCompletions,1);assert.equal(row(f).progress.verificationSuspensions,0);
  }finally{await cleanup(p,f);}
 });
 it('counts a subsequently failed concurrent verification exactly once',async()=>{
  const {p,f}=await setup();try{
   f.behavior=tenant=>p.window.currentGeneration(tenant);await f.begin(A);await f.verify();await f.releaseCycle();
   assert.equal(row(f).progress.failedCompletions,0);
   for(let i=0;i<2;i++)await assert.rejects(p.window.verifyOperational(()=>{throw Error('synthetic authority refusal');}));
   await f.finishVerification();await turn();
   assert.equal(row(f).progress.failedCompletions,1);assert.equal(row(f).progress.verificationSuspensions,1);
   assert.equal(await f.runtime.resumeVerification(A),false);assert.equal(row(f).progress.failedCompletions,1);
  }finally{await cleanup(p,f);}
 });
 for(const kind of ['session','probe'])it('counts '+kind+' loss after suspension as a hard failure',async()=>{
  const options={},p=fixture({trustedWorker:true,...options}),f=await lab.create({window:p.window,tenants:[A]});try{
   f.behavior=tenant=>p.window.currentGeneration(tenant);await f.begin(A);await f.verify();await f.releaseCycle();
   if(kind==='session')p.client.emit('error',Error('synthetic session loss'));
   else {p.pool.connect=async()=>{throw Error('synthetic probe loss');}; // cached control remains; change its measured database instead
    const query=p.client.query;p.client.query=async(...args)=>{if(String(args[0]).includes('pg_backend_pid()'))throw Error('synthetic probe loss');return query(...args);};
    await assert.rejects(p.window.probe());}
   await f.finishVerification();assert.equal(row(f).progress.failedCompletions,1);assert.equal(await f.runtime.resumeVerification(A),false);
  }finally{await cleanup(p,f);}
 });
 it('requires a new check to finish if it starts after the original batch succeeded',async()=>{
  const {p,f}=await setup();try{
   f.behavior=tenant=>p.window.currentGeneration(tenant);await f.begin(A);await f.verify();await f.releaseCycle();await f.finishVerification();
   await f.verify();assert.equal(await f.runtime.resumeVerification(A),false);assert.equal(row(f).progress.failedCompletions,0);
   await f.finishVerification();assert.equal(await f.runtime.resumeVerification(A),true);assert.equal(row(f).progress.failedCompletions,0);
  }finally{await cleanup(p,f);}
 });
 it('does not wait for held verification on removal or close and never revives a replacement',async()=>{
  const {p,f}=await setup();try{
   f.behavior=tenant=>p.window.currentGeneration(tenant);await f.begin(A);await f.verify();await f.releaseCycle();
   await f.runtime.removeTenant(A);f.runtime.addTenant(A);await f.finishVerification();
   assert.equal(await f.runtime.resumeVerification(A),false);assert.equal(row(f).progress.verificationSuspensions,0);assert.equal(row(f).progress.completedAcquisitions,0);
   await f.begin(A);await f.verify();await f.releaseCycle();
   await f.runtime.close();assert.equal(row(f).jobs.running,false);await f.finishVerification();
   assert.equal(await f.runtime.resumeVerification(A),false);assert.equal(row(f).progress.completedAcquisitions,0);
  }finally{await cleanup(p,f);}
 });
 it('can suspend a clean final release but never credits that interrupted cycle',async()=>{
  const {p,f}=await setup();try{
   await f.begin(A);await f.verify();await f.releaseCycle();
   assert.equal(row(f).progress.verificationSuspensions,1);assert.equal(row(f).progress.failedCompletions,0);
   assert.equal(row(f).progress.completedAcquisitions,0);assert.equal(f.runtime.peek(A),null);
   await f.finishVerification();await f.runtime.resumeVerification(A);assert.equal(row(f).progress.completedAcquisitions,1);
  }finally{await cleanup(p,f);}
 });
 it('keeps borrowed work with its parent and provides no independent retry',async()=>{
  const {p,f}=await setup();let outer;try{
   f.behavior=tenant=>p.window.currentGeneration(tenant);f.hold={entered:lab.hold(),release:lab.hold()};
   outer=p.window.run(A,()=>f.runtime.acquire(A));const ended=outer.catch(error=>error);
   await f.hold.entered.promise;await f.verify();f.hold.release.resolve();
   assert.equal((await ended).code,'LIFECYCLE_WINDOW_SCHEMA_UNSAFE');
   assert.equal(row(f).progress.verificationSuspensions,0);assert.equal(row(f).progress.completedAcquisitions,0);
   await f.finishVerification();assert.equal(await f.runtime.resumeVerification(A),false);
  }finally{f.hold?.release.resolve();await outer?.catch(()=>{});await cleanup(p,f);}
 });
 it('does not trust old success after a later authority failure before explicit resume',async()=>{
  const {p,f}=await setup();try{
   f.behavior=tenant=>p.window.currentGeneration(tenant);await f.begin(A);await f.verify();await f.releaseCycle();await f.finishVerification();
   await assert.rejects(p.window.verifyOperational(()=>{throw Error('synthetic new authority failure');}));
   assert.equal(await f.runtime.resumeVerification(A),false);assert.equal(row(f).progress.failedCompletions,1);
   assert.equal(await f.runtime.resumeVerification(A),false);assert.equal(row(f).progress.failedCompletions,1);
  }finally{await cleanup(p,f);}
 });
 it('detaches subscriptions on dynamic removal and close while checks remain hung',async()=>{
  const original=windows.verificationSuspension;let active=0;
  windows.verificationSuspension=(...args)=>{const outcome=original(...args);if(!outcome)return outcome;return {status:outcome.status,subscribe(fn){
   active++;let attached=true;const cancel=outcome.subscribe(value=>{if(attached){attached=false;active--;}fn(value);});
   return ()=>{if(attached){attached=false;active--;}cancel();};
  }};};
  let p,f;try{
   ({p,f}=await setup());f.behavior=tenant=>p.window.currentGeneration(tenant);
   await f.begin(A);await f.verify();await f.releaseCycle();assert.equal(active,1);
   await f.runtime.removeTenant(A);assert.equal(active,0,'REMOVAL_DETACHES_PENDING_SUBSCRIPTION');
   f.runtime.addTenant(A);await f.finishVerification();
   await f.begin(A);await f.verify();await f.releaseCycle();assert.equal(active,1);
   await f.runtime.close();assert.equal(active,0,'CLOSE_DETACHES_PENDING_SUBSCRIPTION');
  }finally{windows.verificationSuspension=original;if(f)await cleanup(p,f);}
 });
 it('requires live tenant admission again after successful verification',async()=>{
  const options={trustedWorker:true},p=fixture(options),f=await lab.create({window:p.window,tenants:[A]});try{
   f.behavior=tenant=>p.window.currentGeneration(tenant);await f.begin(A);await f.verify();await f.releaseCycle();await f.finishVerification();
   options.phase='suspended';await f.runtime.resumeVerification(A);
   assert.equal(row(f).progress.completedAcquisitions,0);assert.equal(row(f).progress.failedCompletions,1);assert.equal(row(f).ready,false);
  }finally{await cleanup(p,f);}
 });
 it('settles queued acquisition and time callers after failed verification without another wake',async()=>{
  const {p,f}=await setup();try{
   f.behavior=tenant=>p.window.currentGeneration(tenant);await f.begin(A);await f.verify();await f.releaseCycle();
   let acquisitions=0,times=0;
   const queued=f.runtime.acquire(A).then(()=>{acquisitions++;});const time=f.runtime.tick(A).then(()=>{times++;});await turn();
   assert.equal(acquisitions,0);assert.equal(times,0);
   await assert.rejects(p.window.verifyOperational(()=>{throw Error('synthetic verification failure');}));await f.finishVerification();
   await Promise.all([queued,time]);assert.equal(acquisitions,1);assert.equal(times,1);
   assert.equal(row(f).progress.failedCompletions,1);assert.equal(row(f).progress.completedAcquisitions,0);
   assert.equal(row(f).jobs.acquire,false);assert.equal(row(f).jobs.time,false);
  }finally{await cleanup(p,f);}
 });
 it('preserves pending debt when durable completion precedes a suspended final release',async()=>{
  const {p,f}=await setup();try{
   f.runtime.markPending(A,100);f.sourceReady=false;
   await f.begin(A);await f.verify();await f.releaseCycle();f.now=120100;
   assert.equal(f.runtime.pendingWitness([A])[0].memory.pendingSince,100,'FINAL_RELEASE_MUST_KEEP_UNCREDITED_PENDING_DEBT');
   assert.equal(row(f).code,'EVALUATOR_CLINICAL_PROGRESS_STALLED');assert.equal(row(f).progress.lastCompletedAgeMs,null);
   assert.equal(row(f).progress.completedAcquisitions,0);assert.equal(row(f).progress.failedCompletions,0);
   await f.finishVerification();await f.runtime.invalidateTenant(A);f.sourceReady=true;await f.runtime.resumeVerification(A);
   assert.equal(row(f).ready,true);assert.equal(f.runtime.pendingWitness([A])[0].memory.pendingSince,null);
  }finally{await cleanup(p,f);}
 });
 it('keeps restored and newly marked clinical debt bounded while retaining the oldest instant',async()=>{
  const {p,f}=await setup();try{
   for(let i=0;i<80;i++)f.runtime.markPending(A,100+i);
   await f.begin(A);await f.verify();for(let i=0;i<100;i++)f.runtime.markPending(A,200+i);
   await f.releaseCycle();const witness=f.runtime.pendingWitness([A])[0].memory;
   assert.equal(witness.pendingSince,100);assert.equal(witness.pendingEpoch,180);assert(witness.marksDuringCycle<=64,'PENDING_MARKS_STAY_BOUNDED');
   await f.finishVerification();await f.runtime.resumeVerification(A);
   assert.equal(f.runtime.pendingWitness([A])[0].memory.pendingSince,null);
  }finally{await cleanup(p,f);}
 });
 it('retains clinical input marked during asynchronous admission before cycle entry',async()=>{
  const entered=lab.hold(),release=lab.hold();let checks=0;
  const p=fixture({trustedWorker:true}),f=await lab.create({window:p.window,tenants:[A],options:{activity:{check:async()=>{
   if(!checks++){entered.resolve();await release.promise;}return {eligible:true,state:{paused:false,suspended:false}};
  }}}});try{
   f.hold={entered:lab.hold(),release:lab.hold()};f.cycle=f.runtime.acquire(A);await entered.promise;
   f.runtime.markPending(A,100);release.resolve();await f.hold.entered.promise;
   await f.verify();await f.releaseCycle();f.now=120100;
   assert.equal(f.runtime.pendingWitness([A])[0].memory.pendingSince,100,'ADMISSION_GAP_INPUT_MUST_REMAIN_PENDING');
   assert.equal(row(f).code,'EVALUATOR_CLINICAL_PROGRESS_STALLED');assert.equal(row(f).progress.failedCompletions,0);
  }finally{release.resolve();await cleanup(p,f);}
 });
 for(const kind of ['session','probe','failed-recovery'])it('retains repaired loss history for '+kind+' before explicit resume',async()=>{
  const options={trustedWorker:true},p=fixture(options),f=await lab.create({window:p.window,tenants:[A]});try{
   f.behavior=tenant=>p.window.currentGeneration(tenant);await f.begin(A);await f.verify();await f.releaseCycle();await f.finishVerification();
   if(kind==='session')p.client.emit('error',Error('synthetic lost session'));
   else if(kind==='probe'){
    options.datastore={server_port:6432};await assert.rejects(p.window.probe());delete options.datastore;
   }else{
    const original=p.client.query;
    p.client.query=async(...args)=>{if(String(args[0]).includes('operation-window-role'))throw Error('synthetic recovery refusal');return original(...args);};
    await assert.rejects(p.window.recover());p.client.query=original;
   }
   await p.window.recover();assert.equal(await f.runtime.resumeVerification(A),false,'REPAIRED_LOSS_MUST_NOT_ERASE_FAULT_HISTORY');
   assert.equal(row(f).progress.failedCompletions,1);assert.equal(row(f).progress.completedAcquisitions,0);
   await f.runtime.acquire(A);assert.equal(row(f).progress.failedCompletions,1);assert.equal(row(f).progress.completedAcquisitions,1);
  }finally{await cleanup(p,f);}
 });
 it('keeps actual runtime progress compatible with the closed private v3 inspection response',async()=>{
  const {p,f}=await setup();try{
   await f.runtime.acquire(A);assert.equal(row(f).progress.verificationSuspensions,0);
   const frame=await f.frame([A]);assert.equal(frame.view.tenants[0].progress.completedAcquisitions,1);
   assert.equal(Object.hasOwn(frame.view.tenants[0].progress,'verificationSuspensions'),false,'CLOSED_WIRE_MUST_PROJECT_INTERNAL_PROGRESS');
   const changed=structuredClone(frame.view);changed.tenants[0].progress.verificationPending=false;
   assert.throws(()=>require('../lib/server/internal-api/schema').validate(require('../lib/server/internal-api/contracts').evaluatorInspection.operations.inspectEvaluator.response,changed),{code:'INTERNAL_API_SCHEMA_REFUSED'});
  }finally{await cleanup(p,f);}
 });
 it('keeps original hard-failure accounting when the prototype is not selected',async()=>{
  const {p,f}=await setup({},false);try{
   f.behavior=tenant=>p.window.currentGeneration(tenant);await f.begin(A);await f.verify();await f.releaseCycle();
   assert.equal(row(f).progress.failedCompletions,1);assert.equal(Object.hasOwn(row(f).progress,'verificationSuspensions'),false);
  }finally{await cleanup(p,f);}
 });
});
