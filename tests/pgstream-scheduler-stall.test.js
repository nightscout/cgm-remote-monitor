'use strict';
// A saturated evaluator must not set a tenant aside for longer than one retry
// interval. Three controls, each red before the change it names:
//  1. a tenant whose run fails while the dispatch pass stays busy is considered
//     again after NS_EVALUATOR_RETRY_MS, not when the queue next runs empty;
//  2. under NS_EVALUATOR_ORDER=oldest-first that retry keeps the instant the
//     work became owed, so it is not placed behind every newer write;
//  3. a recovery read that lists a tenant whose cycle is in flight does not mark
//     it pending in memory with the durable mark that cycle is about to cover:
//     the completed tenant is ready, not EVALUATOR_CLINICAL_PROGRESS_STALLED.
const assert=require('node:assert/strict');
const scheduler=require('../lib/pgstream/activity-scheduler');
const startRuntime=require('../lib/server/serve/evaluator-runtime');
const settle=async(turns=40)=>{for(let i=0;i<turns;i++)await new Promise(resolve=>setImmediate(resolve));};

// One slot, a queue that never runs empty: every run takes STEP ms of the
// injected clock and, while `feed` lasts, one new tenant is woken per run.
function saturated({oldestFirst,feed=60,retryMs=1000,STEP=200}){
 let clock=10000,fed=0,failed=false;const ran=[],timers=new Map();let id=0;
 const store={async work(){return [];},async nextDue(){return null;},async pending(){return [];}};
 const s=scheduler.start({store,oldestFirst,concurrency:1,retryMs,now:()=>clock,scan:async()=>{},
  setTimer(fn,delay){const key=++id;timers.set(key,{fn,at:clock+delay});return key;},clearTimer:key=>timers.delete(key),
  run:async tenant=>{
   ran.push(tenant);clock+=STEP;
   if(fed<feed)s.wake('n'+String(fed++).padStart(3,'0'));
   await new Promise(resolve=>setImmediate(resolve));
   if(tenant==='X'&&!failed){failed=true;throw new Error('EVALUATOR_ACQUISITION_REFUSED');}
  }});
 const pump=async()=>{for(let turn=0;turn<400;turn++){await settle(4);const due=[...timers].filter(([,t])=>t.at<=clock);if(!due.length){if(!timers.size)return;clock=Math.min(...[...timers.values()].map(t=>t.at));continue;}for(const [key,t]of due){timers.delete(key);t.fn();}}};
 return {s,ran,pump,advance:ms=>{clock+=ms;}};
}

describe('evaluator scheduler: a set-aside tenant under saturation',()=>{
 for(const oldestFirst of [true,false]){
  it((oldestFirst?'oldest-first':'arrival')+': a failed run is considered again after one retry interval while the pass stays busy',async()=>{
   const l=saturated({oldestFirst});
   try{
    l.s.wake('X');l.advance(1);for(const t of ['a','b','c','d'])l.s.wake(t);
    await l.pump();
    const first=l.ran.indexOf('X'),second=l.ran.indexOf('X',first+1);
    assert(first>=0&&second>first,'the failed tenant runs again');
    // 200 ms per run, 1000 ms retry: five runs pass before it is eligible. The
    // queue holds 60 more tenants; base serves all of them first (index 65).
    const waited=second-first-1;
    assert(waited<=(oldestFirst?6:12),'SET_ASIDE_OUTLIVES_RETRY_INTERVAL: '+waited+' other runs before the retry (retry interval is 5 runs)');
   }finally{await l.s.close();}
  });
 }
 it('oldest-first: the retry keeps the instant the work became owed',async()=>{
  const l=saturated({oldestFirst:true});
  try{
   l.s.wake('X');l.advance(1);for(const t of ['a','b','c','d'])l.s.wake(t);
   await l.pump();
   const first=l.ran.indexOf('X'),second=l.ran.indexOf('X',first+1);
   // Eligible after 5 runs; every tenant then waiting was woken after X became owed.
   assert.equal(second-first-1,5,'RETRY_LOST_ITS_PLACE: ran '+l.ran.slice(first,second+1).join(','));
  }finally{await l.s.close();}
 });
});

describe('evaluator scheduler and runtime: a recovery read during a cycle in flight',()=>{
 const A='11111111-1111-4111-8111-111111111111';
 it('a completion that covers the durable mark leaves the tenant ready, and the scheduler does not retry it',async()=>{
  let now=100000,entered,release,durablePendingAt=null;
  const inFlight=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
  let hold=false;
  const runtime=await startRuntime({tenants:[A],externalRecovery:true,recoveryIntervalMs:1000,timeIntervalMs:60000,
   readCurrent:async tenant=>({tenant,identity:'a'.repeat(64)}),
   create:async()=>({async evaluate(){if(hold){entered();await held;}return {checkpoint:1,properties:{},emitted:[],requested:[]};},close(){}}),
   schedule:()=>({}),cancel(){},now:()=>now,
   durable:{pendingMs:30000,async begin(){return {clock:'1'};},
    // The commit covers the writer's mark: nothing is left pending.
    async complete(tenant,{result,identity}){const coveredAt=durablePendingAt;durablePendingAt=null;return {changed:true,pendingAt:null,coveredAt,output:{tenant,identity,outputRevision:1,contentDigest:'b'.repeat(64),result}};}}});
  const store={async nextDue(){return null;},async pending(){return [];},
   // The durable row as a reader sees it before the cycle's commit.
   async work(){return durablePendingAt===null?[]:[{tenant:A,pendingAt:durablePendingAt,nextDueAt:null}];}};
  const s=scheduler.start({store,oldestFirst:true,concurrency:1,now:()=>now,scan:async()=>{},
   onPending:(tenant,at)=>runtime.markPending(tenant,at),
   // The serving evaluator's run step (lib/server/serve/evaluator-preview.js).
   async run(tenant,kind){await runtime[kind==='due'?'tick':'acquire'](tenant);const state=runtime.health([tenant]).tenants[0];if(!state.ready)throw new Error(state.code||'EVALUATOR_ACTIVITY_RETRY');}});
  try{
   await runtime.acquire(A);
   // A write 60 s ago, found by recovery; its cycle starts and is held.
   hold=true;durablePendingAt=now-60000;
   s.recover().catch(()=>{});await inFlight;
   // A second recovery read lists the same row while that cycle is in flight.
   s.recover().catch(()=>{});await settle();
   release();await settle();
   const row=runtime.health([A]).tenants[0];
   assert.equal(row.code,null,'COVERED_MARK_REPORTED_AS_STALL '+JSON.stringify(runtime.pendingWitness([A])[0].memory));
   assert.equal(row.ready,true);
   assert.equal(s.stats().retries,0,'the completed run is not counted as a failure');
  }finally{release();await s.close();await runtime.close();}
 });
});

// The periodic pending sweep is the guarantee for a write whose hint was lost.
// It must come round every sweep interval while the dispatch pass stays busy:
// a saturated pass does not end, so a sweep that waits for the pass before it
// re-arms runs once and leaves the lost hint to whatever else reads the row.
describe('evaluator scheduler: the periodic sweep under saturation',()=>{
 for(const oldestFirst of [true,false]){
  it((oldestFirst?'oldest-first':'arrival')+': a write whose hint was lost is found within one sweep interval while the pass stays busy',async()=>{
   const STEP=200,SWEEP=5000,LOST_AT=12000;
   let clock=10000,fed=0,id=0;const ran=[],timers=new Map(),done=new Set();
   // No hint, no recovery row and no due instant for L: only the sweep reads its mark.
   const store={async work(){return [];},async nextDue(){return null;},
    async pending(){return clock>=LOST_AT&&!done.has('L')?[{tenant:'L',pendingAt:LOST_AT}]:[];}};
   const s=scheduler.start({store,oldestFirst,concurrency:1,retryMs:1000,sweepMs:SWEEP,now:()=>clock,scan:async()=>{},
    setTimer(fn,delay){const key=++id;timers.set(key,{fn,at:clock+delay});return key;},clearTimer:key=>timers.delete(key),
    run:async tenant=>{ran.push([tenant,clock]);done.add(tenant);clock+=STEP;if(fed<300)s.wake('n'+String(fed++).padStart(3,'0'));await new Promise(resolve=>setImmediate(resolve));}});
   const pump=async()=>{for(let turn=0;turn<2000;turn++){await settle(4);const due=[...timers].filter(([,t])=>t.at<=clock);if(!due.length){if(!timers.size||done.has('L')&&fed>=300)return;clock=Math.min(...[...timers.values()].map(t=>t.at));continue;}for(const [key,t]of due){timers.delete(key);t.fn();}}};
   try{
    for(const t of ['a','b','c','d'])s.wake(t);
    s.sweep().catch(()=>{}); // the startup sweep (lib/server/serve/evaluator-preview.js)
    await pump();
    const found=ran.find(([tenant])=>tenant==='L');
    assert(found,'the lost write is evaluated');
    // Marked at 12 000; the next sweep is due by 15 000 or 20 000 at the latest,
    // and the queue then holds at most a handful of tenants (one is fed per run).
    const waited=found[1]-LOST_AT;
    assert(waited<=SWEEP+10*STEP,'SWEEP_DID_NOT_REARM_UNDER_SATURATION: the lost write waited '+waited+' ms of a pass that stayed busy '+(300*STEP)+' ms; sweeps run '+s.sweepStats().runs);
   }finally{await s.close();}
  });
 }
});
