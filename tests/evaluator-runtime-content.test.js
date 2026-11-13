'use strict';

// The evaluator output revision changes only with content: checkpoint,
// progress, emitted, requested and properties. Actual runtime, actual views and
// plugins over synthetic data; only the clock is controlled.
// covers: lib/server/serve/evaluator-runtime.js
const assert = require('node:assert/strict');
const startRuntime = require('../lib/server/serve/evaluator-runtime');
const levels = require('../lib/levels');

const A = '11111111-1111-4111-8111-111111111111';
const identity = 'a'.repeat(64);

describe('evaluator output revision follows content, not cycles', function () {
  // The single-site stale-data alarm (timeago with enableAlerts). The tenant
  // environment cannot carry extendedSettings.timeago today, so the env is
  // built in the single-site shape here.
  const env = require('../lib/server/tenant-app/environment')({ settings: { enable: ['bgnow', 'delta', 'direction', 'timeago'],
    alarmTimeagoWarn: true, alarmTimeagoWarnMins: 15, alarmTimeagoUrgent: true, alarmTimeagoUrgentMins: 30 } });
  env.extendedSettings = { timeago: { enableAlerts: true } };
  const view = require('../lib/data/views')(env, { language: require('../lib/language')(), levels, moment: require('moment-timezone') });
  const t0 = Date.UTC(2026, 10, 10, 12);
  function cycle (at) {
    const ddata = require('../lib/data/ddata')(); ddata.lastUpdated = at;
    ddata.sgvs = [{ _id: 'synthetic', mgdl: 120, mills: t0 - 60000, type: 'sgv', direction: 'Flat' }];
    return { checkpoint: 7, progress: null, ...view.evaluateCycle({ now: at, ddata }) };
  }

  it('keeps the revision and frozen output for an identical time-only cycle and bumps it when only time passes into a stale-data alarm', async function () {
    let at = t0; const woken = [];
    const runtime = await startRuntime({ tenants: [A], readCurrent: async () => ({ tenant: A, identity }),
      create: async () => ({ evaluate: async ({ at }) => cycle(at), evaluateTime: async ({ at }) => cycle(at), close () {} }),
      recoveryIntervalMs: 1000, timeIntervalMs: 1000, schedule: () => ({}), cancel () {}, now: () => at, onRevision: tenant => woken.push(tenant) });
    try {
      const first = runtime.last(A);
      assert.equal(first.outputRevision, 1); assert.deepEqual(woken, [A]);
      at = t0 + 60000; await runtime.tick(A); at = t0 + 61000; await runtime.acquire(A);
      const held = runtime.last(A);
      assert.equal(held.outputRevision, 1, 'EVALUATOR_IDENTICAL_CONTENT_KEEPS_REVISION');
      assert.equal(held.result, first.result, 'the same frozen output object');
      assert.deepEqual(woken, [A], 'no wake for identical content');
      assert.equal(runtime.health().tenants[0].cycles, 3, 'every cycle still ran');
      at = t0 + 20 * 60000; await runtime.tick(A);
      const stale = runtime.last(A);
      assert.ok(stale.result.requested.some(row => row.kind === 'notify' && row.plugin?.name === 'timeago'), 'only time passed and the stale-data alarm appeared');
      assert.equal(stale.outputRevision, 2, 'EVALUATOR_TIME_DRIVEN_CONTENT_BUMPS');
      assert.deepEqual(woken, [A, A]);
    } finally { await runtime.close(); }
  });

  it('defines content as exactly the fields consumers and the producer read', function () {
    assert.deepEqual(startRuntime.CONTENT, ['checkpoint', 'progress', 'emitted', 'requested', 'properties']);
    const base = cycle(t0);
    assert.equal(startRuntime.contentDigest({ ...base, now: t0 + 1, evaluationRevision: 9, trigger: 'time-only' }), startRuntime.contentDigest(base),
      'per-cycle metadata is not content');
    assert.equal(startRuntime.contentDigest({ ...base, properties: JSON.parse(JSON.stringify(base.properties)) }), startRuntime.contentDigest(base),
      'canonical: a JSON round trip of the same values has the same digest');
    for (const key of startRuntime.CONTENT) {
      assert.notEqual(startRuntime.contentDigest({ ...base, [key]: { changed: key } }), startRuntime.contentDigest(base), key + ' is content');
    }
  });
  it('observes retained clinical properties without conflating completion, confirmation, or authority', async function () {
    let at = t0, calls = 0, timers = 0;
    const runtime = await startRuntime({ tenants: [A], readCurrent: async () => ({ tenant: A, identity }),
      create: async () => ({ evaluate: async ({ at }) => { calls++; return { ...cycle(at), signature: { stamp: 7, deleted: 0 } }; },
        evaluateTime: async ({ at }) => { calls++; return cycle(at); }, signature: async () => ({ stamp: 7, deleted: 0 }), close () {} }),
      recoveryIntervalMs: 1000, timeIntervalMs: 1000, schedule: () => { timers++; return {}; }, cancel () {}, now: () => at });
    try {
      const read = () => runtime.clinicalResults([A])[0];
      const first = read();
      assert.equal(first.status, 'eligible-model'); assert.equal(first.bgNow.meanPresent, true); assert.equal(first.bgNow.meanFinite, true);
      assert.equal(first.bgNow.mills, t0 - 60000); assert.equal(first.retainedModelAt, t0);
      assert.equal(first.inputCheckpoint, 7); assert.equal(first.lastCompletedAgeMs, null, 'legacy path has no owned completion witness');
      const before = { calls, timers, cycles: runtime.health([A]).tenants[0].cycles };
      for (let i=0;i<10;i++) assert.deepEqual(read(), first);
      assert.deepEqual({ calls, timers, cycles: runtime.health([A]).tenants[0].cycles }, before, 'READ_ONLY_NO_WORK');
      at = t0 + 60000; await runtime.tick(A);
      assert.equal(read().retainedModelAt, t0, 'identical content retains its original model instant');
      assert.equal(read().outputRevision, first.outputRevision);
      at = t0 + 61000; await runtime.backstop([A]);
      assert.equal(runtime.health([A]).tenants[0].evaluatedAgeMs, 0, 'unchanged signature confirms health');
      assert.equal(read().retainedModelAt, t0, 'confirmation is not a clinical evaluation');
      assert.equal(calls, 2);
      await runtime.close(); assert.equal(read().status, 'retained-ineligible');
      assert.equal(read().bgNow.meanFinite, true, 'retained property is distinct from cached eligibility');
      for (const selected of [undefined, [], [A,A], ['unknown'], Array(129).fill(A)]) assert.throws(() => runtime.clinicalResults(selected), /selector refused/);
    } finally { await runtime.close(); }
  });

  it('observes actual projection fresh, aged-unavailable and restored results at the same checkpoint without SQL', async function () {
    const scope = require('../lib/storage/tenant-scope'), previous = scope.getTenancyMode(); scope.setTenancyMode('multi');
    const clock = require('./lib/views-replay/clock'), projection = require('../lib/data/tenant-projection-evaluator');
    const doc = { _id: 'synthetic-observation', type: 'sgv', sgv: 123, date: t0, utcOffset: 0, srvModified: t0 + 1 };
    let at = t0 + 120000, sql = 0, runtime;
    clock.install(); clock.pin(at);
    try {
      runtime = await startRuntime({ tenants:[A], readCurrent:async()=>({tenant:A,identity}), now:()=>at,
        create:async()=>projection({tenant:A,replay:{reconcile:async()=>({checkpoint:doc.srvModified,rows:[{domain:'entries',document:doc}]})},
          connection:{query:async()=>{sql++;throw Error('NO_SQL');}},env:require('../lib/server/tenant-app/environment')({settings:{enable:['bgnow']}}),
          language:require('../lib/language')(),dbstats:async()=>({dataSize:0,indexSize:0}),maxRows:10,maxBytes:10000}),
        recoveryIntervalMs:1000,timeIntervalMs:1000,schedule:()=>({}),cancel(){} });
      const fresh=runtime.clinicalResults([A])[0]; assert.equal(fresh.bgNow.meanFinite,true);
      at=t0+2*24*60*60000+1;clock.pin(at);await runtime.tick(A);
      const aged=runtime.clinicalResults([A])[0];assert.equal(aged.status,'eligible-model');assert.equal(aged.bgNow.meanPresent,false);assert.equal(aged.bgNow.meanFinite,false);
      assert.equal(aged.inputCheckpoint,fresh.inputCheckpoint);assert(aged.outputRevision>fresh.outputRevision);assert.equal(aged.retainedModelAt,at);
      at=t0+120000;clock.pin(at);await runtime.tick(A);assert.equal(runtime.clinicalResults([A])[0].bgNow.meanFinite,true);assert.equal(sql,0);
      assert(!JSON.stringify(runtime.clinicalResults([A])).includes('123'),'NO_RAW_GLUCOSE_VALUE');
    } finally { await runtime?.close();clock.uninstall();scope.setTenancyMode(previous); }
  });

  it('distinguishes absent model and nonfinite or missing retained mean without inventing timestamps', async function () {
    for (const properties of [{}, {bgnow:{mean:Infinity,mills:NaN}}, {bgnow:{mean:'123'}}, {bgnow:{mean:0,mills:0}}]) {
      const runtime=await startRuntime({tenants:[A],readCurrent:async()=>({tenant:A,identity}),
        create:async()=>({evaluate:async()=>({checkpoint:0,properties,emitted:[],requested:[]}),close(){}}),
        recoveryIntervalMs:1000,timeIntervalMs:1000,schedule:()=>({}),cancel(){}});
      try { const v=runtime.clinicalResults([A])[0];assert.equal(v.retainedModelAt,null);assert.equal(v.bgNow.meanPresent,Object.hasOwn(properties.bgnow||{},'mean'));
        assert.equal(v.bgNow.meanFinite,typeof properties.bgnow?.mean==='number'&&Number.isFinite(properties.bgnow.mean));
        assert.equal(v.bgNow.mills,properties.bgnow?.mills===0?0:null);
      } finally { await runtime.close(); }
    }
    const runtime=await startRuntime({tenants:[A],readCurrent:async()=>{throw Error('REFUSED');},create:async()=>{throw Error('NO_COMPONENT');},recoveryIntervalMs:1000,timeIntervalMs:1000,schedule:()=>({}),cancel(){}});
    try {const v=runtime.clinicalResults([A])[0];assert.equal(v.status,'no-model');assert.equal(v.bgNow,null);assert.equal(v.retainedModelAt,null);assert.equal(v.outputRevision,null);assert.equal(v.inputCheckpoint,null);} finally {await runtime.close();}
  });

});

describe('durable evaluator pending-work health replaces roster watchdogs',function(){
 it('has no interval/watch timer for unchanged tenants, including a new dynamic tenant',async()=>{
   const intervals=[],timers=[];const current=tenant=>({tenant,identity});
   const runtime=await startRuntime({tenants:[A],dynamic:true,maxTenants:2,readCurrent:async tenant=>current(tenant),
     recoveryIntervalMs:1000,timeIntervalMs:60000,externalRecovery:true,schedule:fn=>{intervals.push(fn);return 1;},cancel(){},setTimer:fn=>{timers.push(fn);return 1;},clearTimer(){},
     durable:{begin:async()=>({clock:'1'}),complete:async(tenant,{result})=>({changed:true,output:{tenant,identity,contentDigest:'same',outputRevision:1,inputCheckpoint:1,result}})},
     create:async()=>({evaluate:async()=>({checkpoint:1,signature:{stamp:1,deleted:0},due:{dueAt:null,slow:[]}}),close(){}})});
   try{runtime.addTenant('22222222-2222-4222-8222-222222222222');assert.equal(intervals.length,0,'durable idle must not sweep roster health');assert.equal(timers.length,0,'unchanged dynamic tenant must not own a watchdog');}finally{await runtime.close();}
 });
});
