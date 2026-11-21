'use strict';
const assert=require('node:assert/strict');
const fixture=require('./fixtures/operation-window-runtime-protocol');
const lab=require('./fixtures/evaluator-owned-acquisition');
const A='11111111-1111-4111-8111-111111111111';
const row=f=>f.runtime.health([A]).tenants[0];
async function setup(){const p=fixture({trustedWorker:true});const f=await lab.create({window:p.window,tenants:[A]});return {p,f};}
async function cleanup(p,f){await f.close();await p.window.close();}

describe('evaluator clinical input during acquisition',function(){
 it('retains the oldest unprocessed input with a bounded set of marks',async()=>{
  const {p,f}=await setup();try{
   await f.begin(A);
   for(let i=0;i<180;i++)f.runtime.markPending(A,100+i);
   await f.releaseCycle();f.now=120100;
   const witness=f.runtime.pendingWitness([A])[0].memory;
   assert.equal(witness.pendingSince,100);assert.equal(witness.pendingEpoch,180);assert(witness.marksDuringCycle<=64);
   assert.equal(row(f).code,'EVALUATOR_CLINICAL_PROGRESS_STALLED');
   await f.runtime.acquire(A);assert.equal(f.runtime.pendingWitness([A])[0].memory.pendingSince,null);
  }finally{await cleanup(p,f);}
 });
 it('retains clinical input marked during admission when evaluation fails',async()=>{
  const entered=lab.hold(),release=lab.hold();let checks=0;
  const p=fixture({trustedWorker:true}),f=await lab.create({window:p.window,tenants:[A],options:{activity:{check:async()=>{
   if(!checks++){entered.resolve();await release.promise;}return {eligible:true,state:{paused:false,suspended:false}};
  }}}});try{
   f.behavior=()=>{throw Error('synthetic evaluation failure');};
   f.cycle=f.runtime.acquire(A);await entered.promise;
   f.runtime.markPending(A,100);release.resolve();await f.cycle;f.now=120100;
   assert.equal(f.runtime.pendingWitness([A])[0].memory.pendingSince,100);
   assert.equal(row(f).progress.failedCompletions,1);
  }finally{release.resolve();await cleanup(p,f);}
 });
 it('keeps actual runtime progress compatible with the closed private v3 inspection response',async()=>{
  const {p,f}=await setup();try{
   await f.runtime.acquire(A);assert.equal(Object.hasOwn(row(f).progress,'verificationSuspensions'),false);
   const frame=await f.frame([A]);assert.equal(frame.view.tenants[0].progress.completedAcquisitions,1);
   assert.equal(Object.hasOwn(frame.view.tenants[0].progress,'verificationSuspensions'),false,'CLOSED_WIRE_MUST_PROJECT_INTERNAL_PROGRESS');
   const changed=structuredClone(frame.view);changed.tenants[0].progress.verificationPending=false;
   assert.throws(()=>require('../lib/server/internal-api/schema').validate(require('../lib/server/internal-api/contracts').evaluatorInspection.operations.inspectEvaluator.response,changed),{code:'INTERNAL_API_SCHEMA_REFUSED'});
  }finally{await cleanup(p,f);}
 });
});
