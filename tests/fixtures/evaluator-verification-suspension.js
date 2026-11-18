'use strict';
// Synthetic clinical and durable ports; the supplied lifecycle window can be
// either the recording protocol or the real disposable PostgreSQL window.
const start = require('../../lib/server/serve/evaluator-runtime');
const contexts = require('../../lib/server/serve/evaluator-job-context');
const hold = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise,resolve}; };
async function create ({window,tenants,enabled=true,options={}}) {
  const state = {now:100,sourceReady:true,hold:null,behavior:null,evaluations:0,creations:0,completions:0,verified:null};
  const job = contexts.create('clinical');
  const output = () => ({checkpoint:0,emitted:[],requested:[],properties:{}});
  state.runtime = await start({tenants,operationWindow:window,jobContext:job,externalRecovery:true,dynamic:true,
    recoveryIntervalMs:60000,timeIntervalMs:60000,evaluationAlertMs:120000,
    now:()=>state.now,schedule:()=>1,cancel(){},setTimer:()=>1,clearTimer(){},
    ...(enabled?{verificationSuspension:{ready:()=>state.sourceReady}}:{}),
    readCurrent:async tenant=>({tenant,identity:'a'.repeat(64)}),
    create:async current=>{state.creations++;return {async evaluate(){
      state.evaluations++;
      if(state.hold){state.hold.entered.resolve();await state.hold.release.promise;}
      if(state.behavior)await state.behavior(current.tenant);
      return output();
    },evaluateTime:output,close(){}};},
    durable:{pendingMs:120000,begin:async()=>({clock:1}),complete:async()=>{state.completions++;return {changed:true,pendingAt:null,output:{outputRevision:state.completions,contentDigest:'f'.repeat(64)}};}},...options});
  state.job=job;
  const inspect=require('../../lib/server/serve/evaluator-inspection')({tenants:new Map(tenants.map(tenant=>[tenant,true])),runtime:state.runtime,
    gate:{inspect:async()=>({configured:{mode:'standalone',ordinal:0,rule:null,leaseMs:null,configuredTenants:tenants.length},observed:null,
      gate:{eligible:true,reason:null,members:null,reads:0,refusals:0,changes:0,checkedAgeMs:null,heartbeats:null},owner:()=>null,admits:()=>true})}});
  state.frame=async selected=>{
    const view=await inspect({tenants:selected});
    require('../../lib/server/internal-api/schema').validate(require('../../lib/server/internal-api/contracts').evaluatorInspection.operations.inspectEvaluator.response,view);
    return {selected,selfOrdinal:0,selfMode:'standalone',view};
  };
  state.begin=async tenant=>{state.hold={entered:hold(),release:hold()};state.cycle=state.runtime.acquire(tenant);await state.hold.entered.promise;};
  state.verify=async callback=>{state.check={entered:hold(),release:hold()};state.verifying=window.verifyOperational(async()=>{state.check.entered.resolve();await state.check.release.promise;if(callback)await callback();});state.verifying.catch(()=>{});await state.check.entered.promise;};
  state.releaseCycle=async()=>{state.hold.release.resolve();await state.cycle;state.hold=null;};
  state.finishVerification=async()=>{state.check.release.resolve();await state.verifying;await new Promise(resolve=>setImmediate(resolve));};
  state.close=async()=>{state.hold?.release.resolve();state.check?.release.resolve();await state.cycle?.catch(()=>{});await state.verifying?.catch(()=>{});await state.runtime.close();job.close();};
  return state;
}
module.exports={create,hold};
