'use strict';
const assert=require('node:assert/strict');
const {create}=require('../lib/server/serve/registry-tenant-set');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function registry(first=[B],extra={}){
  let version=1,at=0;const ids=new Set(first),calls={pages:0,enumerations:0};
  const store={revision:async()=>String(version),enumerate:async()=>{calls.enumerations++;return {revision:String(version),tenants:[...ids].sort()};},page:async(after,size)=>{calls.pages++;return {revision:String(version),tenants:[...ids].sort().filter(t=>after===null||t>after).slice(0,size)};}};
  const value=create({store,first:{revision:'1',tenants:first},settings:{namespace:'registry',refreshMs:100},maxTenants:1000,build:tenant=>({tenant}),now:()=>at,schedule:()=>null,cancel:()=>{},alert:()=>{},...extra});
  return {value,calls,add:t=>{ids.add(t);version++;},remove:t=>{ids.delete(t);version++;},advance:()=>{at+=101;}};
}
describe('live registry admission and dynamic worker rosters',function(){
  it('keeps a new tenant invisible until preparation commits, then activates without restarting B',async function(){
    const r=registry(),gate=deferred(),events=[];
    await r.value.follow({prepare:async t=>{events.push('prepare:'+t);await gate.promise;return ()=>events.push('rollback:'+t);},activate:t=>events.push('activate:'+t),remove:async t=>events.push('remove:'+t)});
    try{r.add(A);await r.value.poll();assert.equal(r.value.isActive(A),false);assert.equal(r.value.tenants.has(A),false);assert.equal(r.value.isActive(B),true);
      gate.resolve();await r.value.drained();assert.equal(r.value.isActive(A),true,'LIVE_TENANT_ADMITTED_WITHOUT_RESTART');assert.equal(r.value.tenants.get(B).tenant,B);assert.ok(events.includes('activate:'+A));}
    finally{gate.resolve();await r.value.close();}
  });
  it('retries failed warm and rolls back activation failure rather than exposing a ghost tenant',async function(){
    const r=registry();let prepared=0,activated=0,rollbacks=0;
    await r.value.follow({prepare:async()=>{if(prepared++===0)throw new Error('synthetic warm');return ()=>{rollbacks++;};},activate:()=>{if(activated++===0)throw new Error('synthetic activation');},remove:async()=>{}});
    try{r.add(A);await r.value.poll();await r.value.drained();assert.equal(r.value.isActive(A),false);
      r.advance();await r.value.poll();await r.value.drained();assert.equal(r.value.isActive(A),false);assert.equal(rollbacks,1);
      r.advance();await r.value.poll();await r.value.drained();assert.equal(r.value.isActive(A),true);assert.equal(r.value.isActive(B),true);}
    finally{await r.value.close();}
  });
  it('hides removal before drain and cannot resurrect a removed tenant from late preparation',async function(){
    const r=registry(),hold=deferred(),removed=deferred();let rolled=false;
    await r.value.follow({prepare:async()=>{await hold.promise;return ()=>{rolled=true;};},activate:()=>{throw new Error('must not activate');},remove:async()=>{await removed.promise;}});
    try{r.add(A);await r.value.poll();r.remove(A);r.remove(B);await r.value.poll();assert.equal(r.value.isActive(B),false);assert.equal(r.value.tenants.has(B),false);
      hold.resolve();removed.resolve();await r.value.drained();assert.equal(r.value.isActive(A),false,'LIVE_NO_LATE_PREPARE_RESURRECTION');assert.equal(rolled,true);}
    finally{hold.resolve();removed.resolve();await r.value.close();}
  });
  it('starts empty, bounds burst admission concurrency, and reads no full roster on unchanged revision',async function(){
    const r=registry([]);let inflight=0,peak=0;
    await r.value.follow({concurrency:1,prepare:async()=>{inflight++;peak=Math.max(peak,inflight);await Promise.resolve();inflight--;return ()=>{};},activate:()=>{},remove:async()=>{}});
    try{for(let i=0;i<50;i++)r.add('10000000-0000-4000-8000-'+i.toString(16).padStart(12,'0'));await r.value.poll();await r.value.drained();assert.equal(r.value.tenants.size,50);assert.equal(peak,1);
      const count=r.calls.enumerations;await r.value.poll();assert.equal(r.calls.enumerations,count);}
    finally{await r.value.close();}
  });
  it('adds and removes empty evaluator/realtime/feed rosters while static empty contracts still refuse',async function(){
    const evalFactory=require('../lib/server/serve/evaluator-runtime'),rtFactory=require('../lib/server/realtime/runtime');
    const tenants=new Map(),evaluated=[],frames=[];
    const current=async tenant=>tenants.has(tenant)?{tenant,identity:'a'.repeat(64)}:null;
    const evaluator=await evalFactory({tenants:[],dynamic:true,maxTenants:2,externalRecovery:true,recoveryIntervalMs:100,timeIntervalMs:100,
      schedule:()=>null,cancel:()=>{},setTimer:()=>null,clearTimer:()=>{},readCurrent:current,
      create:async ctx=>({evaluate:async()=>{evaluated.push(ctx.tenant);return {checkpoint:1,signature:{stamp:1,deleted:0}};},evaluateTime:async()=>({checkpoint:1}),close:()=>{}})});
    const realtime=await rtFactory({tenants:[],dynamic:true,maxTenants:2,eventDriven:true,recoveryIntervalMs:100,schedule:()=>null,cancel:()=>{},readCurrent:current,
      create:ctx=>({acquire:async()=>({checkpoint:1,frame:{tenant:ctx.tenant}})}),fanout:async row=>frames.push(row.tenant)});
    try{tenants.set(A,true);evaluator.addTenant(A);realtime.addTenant(A);await evaluator.acquire(A);await realtime.check([A]);assert.deepEqual(evaluated,[A]);assert.deepEqual(frames,[A]);
      await evaluator.removeTenant(A);await realtime.removeTenant(A);assert.equal(evaluator.last(A),null);assert.equal(realtime.last(A),null);assert.equal(evaluator.health().tenants.length,0);assert.equal(realtime.health().configured,0);}
    finally{await evaluator.close();await realtime.close();}
    await assert.rejects(evalFactory({tenants:[],readCurrent:current,create:async()=>{},recoveryIntervalMs:1,timeIntervalMs:1}),/Explicit/);
  });
  it('gives a newly added evaluator its own watchdog age and preserves pool-owned/unowned selection',async function(){
    let at=100000;const runtime=await require('../lib/server/serve/evaluator-runtime')({tenants:[],dynamic:true,externalRecovery:true,recoveryIntervalMs:100,timeIntervalMs:100,now:()=>at,
      schedule:()=>null,cancel:()=>{},setTimer:()=>null,clearTimer:()=>{},readCurrent:async tenant=>({tenant,identity:'a'.repeat(64)}),
      pool:{refresh:async()=>{},admits:tenant=>tenant===B,reason:()=>null},create:async()=>({evaluate:async()=>({checkpoint:1,signature:{stamp:1,deleted:0}}),evaluateTime:async()=>({checkpoint:1}),close:()=>{}})});
    try{runtime.addTenant(A);runtime.addTenant(B);await runtime.acquire(A);await runtime.acquire(B);assert.equal(runtime.last(A),null);assert.ok(runtime.last(B));assert.ok(runtime.health().tenants.every(t=>t.evaluatedAgeMs===0));}
    finally{await runtime.close();}
  });
});
