'use strict';
const assert = require('node:assert/strict');
const startRuntime = require('../lib/server/serve/evaluator-runtime');
const producer = require('../lib/tenant-notifications/producer');
const scope = require('../lib/storage/tenant-scope');
const tenants = Array.from({length:5}, (_,i) => String(i+1).repeat(8)+'-'+String(i+1).repeat(4)+'-4'+String(i+1).repeat(3)+'-8'+String(i+1).repeat(3)+'-'+String(i+1).repeat(12));
const identity='a'.repeat(64);
async function fixture (factory = startRuntime) {
  const outputs = new Map(), due = new Map(), created = [], retired = [], active = new Set(), sourceReads = [], timers = [];
  let held, release, top = 0;
  const runtime = await factory({tenants, readCurrent:async tenant=>({tenant,identity}),
    residentLimit:2, checkConcurrency:4, loadOutput:async tenant=>JSON.parse(JSON.stringify(outputs.get(tenant))),
    externalRecovery:true,recoveryIntervalMs:1000,timeIntervalMs:1000,schedule(){throw Error('NO_ROSTER_INTERVAL');},cancel(){},
    setTimer:fn=>{timers.push(fn);return{};},clearTimer(){},now:()=>10000,
    durable:{begin:async()=>({clock:'1'}),complete:async(tenant,{result})=>{
      const output={tenant,identity,contentDigest:'b'.repeat(64),outputRevision:1,inputCheckpoint:1,result,rows:result.encodedRows,frame:result.frame};
      outputs.set(tenant,output);due.set(tenant,result.due.dueAt);return{output,changed:true,pendingAt:null};}},
    create:async ({tenant})=>{
      created.push(tenant);active.add(tenant);top=Math.max(top,active.size);
      return{async evaluate(){sourceReads.push(tenant);if(held===tenant)await new Promise(resolve=>{release=resolve;});return{
        now:10000,checkpoint:1,properties:{bgnow:{mean:123,mills:9000}},requested:[],emitted:[],signature:{stamp:1,deleted:0},
        encodedRows:[{domain:'entries',id_kind:'string',doc:{_id:tenant,extension:'x'.repeat(1000)}}],frame:{sgvs:[]},due:{dueAt:20000,reason:'expiry',slow:[]}};},
        async evaluateTime(){throw Error('COLD_COMPONENT_MUST_ACQUIRE_ACCEPTED_STATE');},close(){retired.push(tenant);active.delete(tenant);}};
    }});
  return{runtime,outputs,due,created,retired,active,sourceReads,timers,get top(){return top;},hold:tenant=>{held=tenant;},release:()=>release?.()};
}
describe('fleet resident clinical cache ownership',()=>{
  it('bounds active/cold contexts and full outputs independently of the tenant roster and rehydrates only completed output',async()=>{
    const f=await fixture();try{
      for(const tenant of tenants)await f.runtime.acquire(tenant);
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal(f.runtime.cacheStats().residents,2,'FLEET_RESIDENT_BOUND');assert(f.top<=2,'CONTEXTS_BOUNDED_BEFORE_CREATE');
      assert.equal(f.runtime.last(tenants[0]),null,'COLD_FULL_OUTPUT_NOT_RETAINED');
      const before={created:f.created.length,reads:f.sourceReads.length,timers:f.timers.length};
      const peek=f.runtime.peek(tenants[0]);assert.equal(peek.eligible,true);assert.equal(peek.hasNotifications,false);
      assert(!Object.hasOwn(peek,'result'));assert(!Object.hasOwn(peek,'rows'));assert(!Object.hasOwn(peek,'frame'));
      const actual=await f.runtime.output(tenants[0]);assert.equal(actual.rows[0].doc._id,tenants[0]);assert.equal(actual.eligible,true);
      assert.deepEqual({created:f.created.length,reads:f.sourceReads.length,timers:f.timers.length},before,'OUTPUT_CACHE_MISS_NEVER_REACQUIRES_RAW_INPUT');
      assert.deepEqual([...f.due.values()],tenants.map(()=>20000),'EVICTION_PRESERVES_DURABLE_DEADLINES');
      const cold=f.runtime.clinicalResults([tenants[0]])[0];assert.equal(cold.status,'eligible-model');assert.equal(cold.bgNow.meanFinite,true);
      await f.runtime.tick(tenants[0]);assert.equal(f.created.at(-1),tenants[0],'DUE_FOR_COLD_TENANT_REACQUIRES_DISPOSABLE_COMPONENT');
    }finally{await f.runtime.close();}
  });
  it('never evicts an in-flight tenant and admits neighboring work in a free slot',async()=>{
    const f=await fixture();try{
      f.hold(tenants[0]);const held=f.runtime.acquire(tenants[0]);await new Promise(resolve=>setImmediate(resolve));
      for(const tenant of tenants.slice(1))await f.runtime.acquire(tenant);
      assert(f.active.has(tenants[0]),'HELD_TENANT_CONTEXT_STILL_OWNED');assert(!f.retired.includes(tenants[0]));assert(f.top<=2,'ACTIVE_PLUS_RESIDENT_CONTEXT_BOUND');
      assert.equal(f.outputs.size,4,'UNRELATED_TENANTS_PROGRESS');f.release();await held;
      assert.equal(f.outputs.size,5);assert.equal(f.runtime.cacheStats().residents,2);
    }finally{f.release();await f.runtime.close();}
  });
  it('control: deleting aggregate eviction makes the actual runtime exceed the resident bound, then restoration passes',async()=>{
    const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module'),file=require.resolve('../lib/server/serve/evaluator-runtime'),source=fs.readFileSync(file,'utf8');
    const needle='if (residentLimit === undefined) return;\n    for (const [tenant, state] of residents)';assert.equal(source.split(needle).length,2);
    const loaded={exports:{}};vm.runInThisContext('(function(require,module,exports){'+source.replace(needle,'if (true) return;\n    for (const [tenant, state] of residents)')+'\n})',{filename:file})(createRequire(file),loaded,loaded.exports);
    const criterion=async factory=>{const f=await fixture(factory);try{for(const tenant of tenants)await f.runtime.acquire(tenant);await new Promise(resolve=>setImmediate(resolve));assert(f.runtime.cacheStats().residents<=2,'FLEET_RESIDENT_BOUND');}finally{await f.runtime.close();}};
    await assert.rejects(criterion(loaded.exports),/FLEET_RESIDENT_BOUND/);await criterion(startRuntime);
  });
  it('selects durable notification effects from a cold asynchronously rehydrated output with stable version identity',async()=>{
    const previous=scope.getTenancyMode();scope.setTenancyMode('multi');
    const lab=require('./fixtures/tenant-notifications')(),at=Date.UTC(2026,10,16,12);
    const env=require('../lib/server/tenant-app/environment')({settings:{enable:['simplealarms']}});
    const view=require('../lib/data/views')(env,{language:require('../lib/language')(),levels:require('../lib/levels'),moment:require('moment-timezone')});
    const ddata=require('../lib/data/ddata')();ddata.lastUpdated=at;ddata.sgvs=[{_id:'synthetic',mgdl:50,mills:at-1000,type:'sgv',direction:'Flat'}];
    const result=view.evaluateCycle({now:at,ddata}),output={tenant:lab.A,identity:'config',runtimeId:'same-runtime',outputRevision:1,inputCheckpoint:1,eligible:true,contentDigest:startRuntime.contentDigest(result),result};
    let reads=0;const p=producer({store:lab.store,reader:{read:async()=>[]},current:async()=>{reads++;return JSON.parse(JSON.stringify(output));},currentConfig:async()=>({tenant:lab.A,identity:'config'}),isCurrent:async()=>true,consumer:'realtime-test',now:()=>at,maxRows:10,maxBytes:65536,maxPayloadBytes:10000});
    try{const selected=await p.select(lab.A);assert.equal(selected.result.emitted.length,1,'COLD_OUTPUT_MUST_RETAIN_ALARM_EFFECT');assert.equal(lab.snapshot().requests.length,1);assert(reads>=2);await p.select(lab.A);assert.equal(lab.snapshot().requests.length,1,'REHYDRATION_ADMITS_NO_DUPLICATE_EFFECT');}
    finally{p.close();scope.setTenancyMode(previous);}
  });
});
