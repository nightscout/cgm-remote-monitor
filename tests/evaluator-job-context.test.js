'use strict';
const assert = require('node:assert/strict');
const contexts = require('../lib/server/serve/evaluator-job-context');
const scope = require('../lib/storage/tenant-scope');
const fixture = require('./fixtures/operation-window-runtime-protocol');
const runtime = require('../lib/server/serve/evaluator-runtime');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise,resolve}; };
async function wait (fn) { for (let i=0;i<100;i++) { if(fn())return;await sleep(5); }assert.fail('SCHEDULER_PROGRESS_TIMEOUT'); }
function settings (window, jobContext, extra = {}) {
  return {tenants:[A],operationWindow:window,jobContext,
    readCurrent:async tenant=>({tenant,identity:'a'.repeat(64)}),
    create:async()=>({evaluate:async()=>({checkpoint:0,properties:{synthetic:true}}),evaluateTime:async()=>({checkpoint:0,properties:{synthetic:true}}),close(){}}),
    recoveryIntervalMs:60000,timeIntervalMs:10,schedule:()=>({}),cancel(){},...extra};
}
function singleClient () {
  const createWindow=require('../lib/tenant-lifecycle/operation-window').create;
  let available=true;const waiting=[];
  return fixture({},config=>createWindow({...config,pool:{connect:async()=>{
    if(!available)await new Promise(resolve=>waiting.push(resolve));else available=false;
    const client=await config.pool.connect(),release=client.release;
    client.release=error=>{client.release=release;release(error);const next=waiting.shift();if(next)next();else available=true;};
    return client;
  }}}));
}
describe('trusted evaluator scheduling contexts (recording lifetime protocol)',function(){
  it('refuses tenant, active, expired and closed inherited window authority without mutating it',async function(){
    const f=fixture(), other=fixture();
    try {
      const mode=scope.getTenancyMode();scope.setTenancyMode('multi');
      try { assert.throws(()=>scope.withTenant(A,()=>contexts.create('clinical')),/CONTEXT_REFUSED/); } finally { scope.setTenancyMode(mode); }
      let late,expired;
      await f.window.run(A,async()=>{
        assert.throws(()=>contexts.create('clinical'),/AMBIENT_SCOPE/);
        assert.throws(()=>contexts.create('delivery'),/AMBIENT_SCOPE/);
        expired = new Promise(resolve=>setTimeout(()=>{
          assert.throws(()=>contexts.create('clinical'),/AMBIENT_SCOPE/);resolve();
        },5));
        late = new Promise(resolve=>setTimeout(()=>{
          assert.throws(()=>contexts.create('clinical'),/AMBIENT_SCOPE/);
          // Cross-window neutrality must not look only at the selected window.
          resolve(f.window.run(A,()=>assert.fail('late application body')));
        },20));
        late.catch(()=>{});
      });
      await expired;
      await f.window.close();
      await assert.rejects(late,/AMBIENT_SCOPE|SCOPE_INVALID|closed/i);
    }finally{await f.window.close();await other.window.close();}
    const neutral=contexts.create('clinical');neutral.close();
  });
  it('requires a branded single-owner context and preserves no-window construction',async function(){
    const f=fixture(),jobs=contexts.create('clinical');
    try{
      await assert.rejects(runtime(settings(f.window,{})),/CONTEXT_REFUSED/);
      const r=await runtime(settings(f.window,jobs));
      await assert.rejects(runtime(settings(f.window,jobs)),/CONTEXT_REFUSED/);
      await r.close();
      await assert.rejects(jobs.run(()=>{}),/CONTEXT_REFUSED/);
      const plain=await runtime(settings(undefined,undefined));
      assert.equal(plain.health([A]).tenants[0].progress.completedAcquisitions,0,'NO_WINDOW_HAS_NO_FRESH_WINDOW_CREDIT');
      await plain.close();
    }finally{jobs.close();await f.window.close();}
  });
  it('runs due timers with fresh admission, credits resolved jobs, and refuses late application work',async function(){
    const f=fixture(),jobs=contexts.create('clinical');let late;
    const r=await runtime(settings(f.window,jobs));
    try{
      await wait(()=>r.health([A]).tenants[0].progress.completedTimeCycles>=2);
      const first=r.health([A]),generation=first.tenants[0].progress.generation;
      assert.equal(first.tenants[0].progress.completedAcquisitions,1);
      await f.window.run(A,()=>{
        late=new Promise(resolve=>setTimeout(()=>resolve(f.window.run(A,()=>assert.fail('expired application body'))),10));
      });
      await assert.rejects(late,/SCOPE_INVALID/);
      const before=r.health([A]).tenants[0].progress.completedAcquisitions;
      await f.window.run(A,()=>r.acquire(A));
      assert.equal(r.health([A]).tenants[0].progress.completedAcquisitions,before);
      assert.equal(r.health([A]).tenants[0].progress.generation,generation);
      assert.deepEqual(r.health([]).tenants,[]);
      assert.throws(()=>r.health([B]),/not configured/);
    }finally{await r.close();await f.window.close();}
  });
  it('preserves active-parent two-acquire coalescing on one client, refuses late/foreign callers and independent parent joins',async function(){
    const f=singleClient(),jobs=contexts.create('clinical');
    const r=await runtime(settings(f.window,jobs,{timeIntervalMs:60000}));
    try{
      const initial=r.health([A]).tenants[0].progress.completedAcquisitions;
      await f.window.run(A,()=>Promise.all([r.acquire(A),r.acquire(A)]));
      await f.window.run(A,()=>Promise.all([r.acquire(A),r.wake(A)]));
      await f.window.run(A,()=>Promise.all([r.acquire(A),r.backstop([A])]));
      assert.equal(r.health([A]).tenants[0].progress.completedAcquisitions,initial,'BORROWED_CALLS_DO_NOT_EARN_OWNED_CREDIT');
      const cycles=r.health([A]).tenants[0].cycles;
      await assert.rejects(f.window.run(B,()=>r.acquire(A)),/SCOPE_INVALID/);
      let late;await f.window.run(A,()=>{late=new Promise(resolve=>setTimeout(()=>resolve(r.acquire(A)),5));late.catch(()=>{});});
      await assert.rejects(late,/SCOPE_INVALID/);assert.equal(r.health([A]).tenants[0].cycles,cycles);
      let independent;
      await f.window.run(A,async()=>{
        independent=jobs.run(()=>r.tick(A));await sleep(2);
        await assert.rejects(r.acquire(A),{code:'EVALUATOR_JOB_PARENT_BUSY'});
      });
      await independent;await r.acquire(A);
      assert.equal(r.health([A]).tenants[0].progress.completedAcquisitions,initial+1);
    }finally{await r.close();await f.window.close();}
  });
  it('preserves explicit consumer wake rejection when its activity port fails, then progresses after recovery',async function(){
    let broken=true;const activity={check:async()=>{if(broken)throw new Error('SYNTHETIC_ACTIVITY_UNAVAILABLE');return{eligible:true};}};
    const previous=scope.getTenancyMode();scope.setTenancyMode('multi');
    const q=await require('./fixtures/evaluator-consumers-protocol')(undefined,{activity});
    try{
      q.consumers.start();await sleep(1);
      await assert.rejects(q.consumers.wake(q.A),/SYNTHETIC_ACTIVITY_UNAVAILABLE/);
      broken=false;await q.consumers.wake(q.A);await q.consumers.flush(q.A);
      assert(q.effects.length>0,'RECOVERED_CONSUMER_HANDOFF');
    }finally{await q.close();scope.setTenancyMode(previous);}
  });
  it('selects runtime health without walking the full tenant map or alert census',async function(){
    const tenants=Array.from({length:1024},(_,i)=>String(i).padStart(8,'0')+'-1111-4111-8111-111111111111');
    const r=await runtime(settings(undefined,undefined,{tenants,setTimer:()=>({}),clearTimer(){}}));
    const values=Map.prototype.values,keys=Map.prototype.keys,iterator=Map.prototype[Symbol.iterator];
    try{
      const refuse=()=>{throw new Error('FULL_ROSTER_ITERATION');};
      Map.prototype.values=refuse;Map.prototype.keys=refuse;Map.prototype[Symbol.iterator]=refuse;
      assert.equal(r.health([tenants[999]]).tenants.length,1);
      assert.deepEqual(r.health([]).tenants,[]);
      assert.throws(()=>r.health(),/FULL_ROSTER_ITERATION/,'CONTROL_LEGACY_WHOLE_VIEW_VISITS_ROSTER');
    }finally{Map.prototype.values=values;Map.prototype.keys=keys;Map.prototype[Symbol.iterator]=iterator;await r.close();}
  });
  it('observes queued background clinical boot without taking an ownership window',async function(){
    const f=fixture(),jobs=contexts.create('clinical'),hold=deferred();let entered=false;
    const r=await runtime(settings(f.window,jobs,{tenants:[A,B],boot:'serve',bootConcurrency:1,timeIntervalMs:60000,setTimer:()=>({}),clearTimer(){},create:async()=>{entered=true;await hold.promise;return {evaluate:async()=>({checkpoint:0}),evaluateTime:async()=>({checkpoint:0}),close(){}};}}));
    try{await wait(()=>entered);const before=f.log.length;
      assert.equal(r.health([B]).tenants[0].jobs.booting,true);assert.equal(r.health([B]).tenants[0].jobs.running,false);
      for(let i=0;i<10;i++)assert.equal(r.health([B]).tenants[0].jobs.booting,true);
      assert.equal(f.log.length,before,'READING_QUEUED_BOOT_TAKES_NO_WINDOW');
      hold.resolve();await wait(()=>!r.health([B]).tenants[0].jobs.booting);
    }finally{hold.resolve();await r.close();await f.window.close();}
  });
  it('observes all four queued clinical slots and the full owned window without driving work',async function(){
    const f=singleClient(),jobs=contexts.create('clinical'),hold=deferred();let block=false,entered=false,owned=[];
    const result=()=>({checkpoint:0,properties:{synthetic:true}});
    const r=await runtime(settings(f.window,jobs,{timeIntervalMs:60000,setTimer:()=>({}),clearTimer(){},create:async()=>({
      evaluate:async()=>{if(block){entered=true;await hold.promise;}return result();},evaluateTime:async()=>result(),close(){}
    })}));
    try{
      block=true;
      await f.window.run(A,async()=>{
        const first=r.acquire(A);await wait(()=>entered);
        const second=r.acquire(A),time=r.tick(A);
        jobs.run(()=>{owned=[r.acquire(A),r.tick(A)];});
        const before=r.health([A]);
        assert.deepEqual(before.tenants[0].jobs,{running:true,booting:false,acquire:true,time:true,parentAcquire:true,parentTime:true});
        for(let i=0;i<10;i++)assert.deepEqual(r.health([A]).tenants[0].jobs,before.tenants[0].jobs);
        assert.equal(r.health([A]).tenants[0].cycles,before.tenants[0].cycles,'INSPECTION_DOES_NOT_DRAIN_QUEUED_JOBS');
        block=false;hold.resolve();await Promise.all([first,second,time]);
      });
      await Promise.all(owned);await wait(()=>!r.health([A]).tenants[0].jobs.running);
      assert.deepEqual(r.health([A]).tenants[0].jobs,{running:false,booting:false,acquire:false,time:false,parentAcquire:false,parentTime:false});
    }finally{hold.resolve();await r.close();await f.window.close();}
  });
  it('does not credit unfinished windows, failed completion or generation-invalidated results',async function(){
    const f=fixture(),jobs=contexts.create('clinical'),hold=deferred();let entered=false,block=false;
    const original=f.client.query;
    f.client.query=async(text,...args)=>{const result=await original(text,...args);if(block && typeof text==='string' && text.startsWith('UPDATE')){entered=true;await hold.promise;}return result;};
    let identity='a'.repeat(64);
    const r=await runtime(settings(f.window,jobs,{timeIntervalMs:60000,readCurrent:async tenant=>({tenant,identity})}));
    try{
      block=true;const pending=r.tick(A);await wait(()=>entered);
      assert.equal(r.health([A]).tenants[0].progress.completedTimeCycles,0);
      assert.equal(r.health([A]).tenants[0].jobs.running,true,'FULL_WINDOW_COMPLETION_IS_STILL_INFLIGHT');
      identity='b'.repeat(64);
      assert.equal(await r.isCurrent(A,'a'.repeat(64)),false);
      hold.resolve();await pending;
      assert.equal(r.health([A]).tenants[0].progress.completedTimeCycles,0);
      assert(r.health([A]).tenants[0].progress.failedCompletions>0);
    }finally{hold.resolve();await r.close();await f.window.close();}
  });
});
