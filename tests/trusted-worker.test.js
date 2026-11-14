'use strict';
const assert = require('node:assert/strict');
const worker = require('../lib/trusted-worker/postgres');
const runtime = require('../lib/server/serve/evaluator-runtime');
const scope = require('../lib/storage/tenant-scope');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const ns = { activity: 'tw_activity', clock: 'tw_clock', settings: 'tw_settings', operatorPolicy: 'tw_policy' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture () {
  let version = 1, generation = 1, at = 0, held;
  const calls = [];
  const connection = { async readOnly (text, values) {
    calls.push({ text, values, tenant: scope.currentTenant() });
    if (/FROM pg_class/.test(text)) return { rows: Object.keys(ns).map(() => ({ secured: true, owns: false, writes: false })) };
    if (/WHERE false/.test(text)) return { rows: [] };
    if (/activity_version/.test(text)) return { rows: values[0].map(tenant => ({ tenant, activity_version: '1', paused: false, suspended: false, settings: version, policy: generation, stamp: '1', deleted: '0' })) };
    if (held) await held.promise;
    return { rows: [{ version, values: { SHOW_SECONDS: version % 2 === 0 }, generation, policy: { deployment: {}, overrides: {} } }] };
  } };
  const reader = worker.create({ connection, namespaces: ns, now: () => at });
  return { reader, calls, connection, bump: () => { version++; }, policy: () => { generation++; }, time: value => { at = value; }, hold: value => { held = value; } };
}
describe('trusted worker metadata and operational scope', function () {
  it('uses one set-based metadata query and no settings/catalogue queries for unchanged reads', async function () {
    const f = fixture(); await f.reader.verify(); await f.reader.scan([A, B]);
    const initial = await f.reader.read(A), before = f.calls.length;
    const snapshots = [];
    for (let i = 0; i < 100; i++) snapshots.push(await f.reader.read(A));
    assert.equal(f.calls.length, before, 'TRUSTED_UNCHANGED_ZERO_SQL');
    assert.ok(snapshots.every(snapshot => snapshot === initial));
    assert.equal(f.calls.filter(row => /activity_version/.test(row.text)).length, 1);
    assert.ok(!f.calls.some(row => /set_config|SECURITY DEFINER|FOREACH/.test(row.text)));
    f.bump(); await f.reader.scan([A, B]); const changed = await f.reader.read(A);
    assert.notEqual(changed, initial); assert.equal(changed.version, 2);
    f.policy(); await f.reader.scan([A, B]); assert.equal((await f.reader.read(A)).policyGeneration, 2);
    f.time(600001); const count = f.reader.health().settingsReads; await f.reader.read(A);
    assert.equal(f.reader.health().settingsReads, count + 1, 'TRUSTED_SLOW_SETTINGS_RECONCILIATION');
    await f.reader.close();
  });
  it('rejects obsolete in-flight settings completion after invalidation and recovery', async function () {
    const f = fixture(); await f.reader.verify(); await f.reader.scan([A]);
    const hold = deferred(); f.hold(hold); const pending = f.reader.read(A);
    f.reader.invalidate(); await f.reader.verify(); hold.resolve();
    await assert.rejects(pending, /TRUSTED_WORKER_UNAVAILABLE/, 'TRUSTED_OBSOLETE_READ_REFUSED');
    f.hold(null); await f.reader.scan([A]); await f.reader.read(A);
    assert.equal(f.reader.health().settingsReads, 2, 'TRUSTED_OLD_RESULT_NOT_CACHED');
    await f.reader.close();
  });
  it('runs periodic operational verification outside the tenant that invokes its timer', async function () {
    const f = fixture(); let timer, at = 0;
    const lifecycle = await require('../lib/trusted-worker/lifecycle')(f.reader, { intervalMs: 10, retryMs: 1, now: () => at, schedule: fn => { timer = fn; return 1; }, cancel () {} });
    const before = f.calls.length; at = 20;
    const previousMode = scope.getTenancyMode();
    scope.setTenancyMode('multi');
    try { await scope.withTenant(A, async () => { timer(); await lifecycle.verify(); }); }
    finally { scope.setTenancyMode(previousMode); }
    assert.equal(f.calls.length - before, 2);
    assert.ok(f.calls.every(row => row.tenant === undefined), 'TRUSTED_OPERATIONAL_OUTSIDE_TENANT');
    await lifecycle.close(); await f.reader.close();
  });
  it('fences an operational verification that began before invalidation', async function () {
    const f = fixture(), held = deferred(), original = f.connection.readOnly;
    await f.reader.verify();
    f.connection.readOnly = async (...args) => { const result = await original(...args); if (/WHERE false/.test(args[0])) await held.promise; return result; };
    const pending = f.reader.verify(); await new Promise(resolve => setImmediate(resolve));
    f.reader.invalidate(); held.resolve(); await assert.rejects(pending, /TRUSTED_WORKER_UNAVAILABLE/);
    assert.equal(f.reader.health().available, false, 'TRUSTED_VERIFY_INVALIDATION_NOT_RESURRECTED');
    await f.reader.close();
  });
  it('does not share an older settings read across a newer version/recovery scan', async function () {
    const f = fixture(), held = deferred(), original = f.connection.readOnly;
    await f.reader.verify(); await f.reader.scan([A]);
    let first = true;
    f.connection.readOnly = async (...args) => { const result = await original(...args); if (/SELECT s.version/.test(args[0]) && first) { first = false; await held.promise; } return result; };
    const old = f.reader.read(A); old.catch(() => {}); await new Promise(resolve => setImmediate(resolve));
    f.bump(); await f.reader.scan([A], { recovery: true });
    const current = await f.reader.read(A, { force: true }); assert.equal(current.version, 2, 'TRUSTED_NEW_VERSION_NOT_SHARED_WITH_OLD_READ');
    held.resolve(); await assert.rejects(old, /TRUSTED_WORKER_UNAVAILABLE/);
    assert.equal((await f.reader.read(A)).version, 2); await f.reader.close();
  });
  it('binds trusted namespaces and configurable settings cadence to the authoritative configuration', function () {
    const fixture = require('./fixtures/multitenant-plan');
    const layout = fixture.layout(), urls = fixture.syntheticUrls(layout);
    const docs = fixture.documents({ layout, urls, variant: 'full' });
    const parse = require('../lib/server/serve/evaluator-config').parseMetadata;
    const original = docs.configs.evaluator;
    assert.equal(parse(original).settingsRefreshMs, 600000);
    for (const name of ['activity', 'settings', 'operatorPolicy', 'clock']) {
      const changed = structuredClone(original); changed.trustedWorker[name] = 'other_' + name.toLowerCase();
      assert.throws(() => parse(changed), /explicit evaluator/);
    }
    for (const settingsRefreshMs of [0, -1, 1.5, 2147483648]) assert.throws(() => parse({ ...original, settingsRefreshMs }), /explicit evaluator/);
    assert.equal(parse({ ...original, settingsRefreshMs: 1000 }).settingsRefreshMs, 1000);
  });
  it('grants cross-tenant SELECT only to explicitly named workers', function () {
    const sql = worker.grants({ namespaces: ns, roles: ['trusted_evaluator', 'trusted_realtime'] }).join('\n');
    assert.match(sql, /FOR SELECT TO "trusted_evaluator" USING \(true\)/);
    assert.doesNotMatch(sql, /BYPASSRLS|SECURITY DEFINER|TO PUBLIC|display_reader|TO "api"/);
    assert.equal((sql.match(/CREATE POLICY/g) || []).length, 8);
  });
});
async function evaluatorFixture ({ activity = false } = {}) {
  let at = 0, calls = 0, scanCalls = 0, hold, stamp = 1;
  const source = 'a'.repeat(64), metadata = new Map([A, B].map(tenant => [tenant, { settings: 1, policy: 1, activity: { state: 'active' }, signature: { stamp: 1, deleted: 0 } }]));
  const cycles = new Map([[A, []], [B, []]]);
  const instance = tenant => ({
    async evaluate () { const observed = stamp; if (hold && tenant === A) await hold.promise; cycles.get(tenant).push(observed); return { checkpoint: observed, signature: { stamp: observed, deleted: 0 }, due: { dueAt: Infinity, slow: [], reason: 'idle' } }; },
    async evaluateTime () { cycles.get(tenant).push('TIME'); return { checkpoint: stamp, due: { dueAt: Infinity, slow: [], reason: 'idle' } }; },
    signature: async () => ({ stamp, deleted: 0 }), close () {}
  });
  const service = await runtime({ tenants: [A, B], readCurrent: async tenant => { calls++; const row = metadata.get(tenant); return { tenant, identity: (row.settings === 1 ? 'b' : 'c').repeat(64), sourceIdentity: source, settingsVersion: row.settings, policyGeneration: row.policy, settingsReadAt: at };  },
    create: async current => instance(current.tenant), recoveryIntervalMs: 1000, timeIntervalMs: 1000,
    ...(activity ? { activity: { check: async (operation, tenant) => { const state = metadata.get(tenant)?.activity?.state; return { eligible: state === 'active', state, code: 'TENANT_' + state.toUpperCase() }; } } } : {}),
    readMetadata: async list => { scanCalls++; return new Map(list.map(tenant => [tenant, metadata.get(tenant)])); }, metadataCurrent: tenant => metadata.get(tenant), readSource: () => source,
    schedule: () => 1, cancel () {}, setTimer: () => 1, clearTimer () {}, now: () => at });
  return { service, cycles, metadata, calls: () => calls, scans: () => scanCalls, time: value => { at = value; }, hold: value => { hold = value; }, write: () => { stamp++; metadata.get(A).signature = { stamp, deleted: 0 }; } };
}
describe('trusted evaluator dirty checkpoints', function () {
  it('does no per-tenant settings read for unchanged scans and retained due-time computation', async function () {
    const f = await evaluatorFixture(); const before = f.calls();
    for (let i = 0; i < 5; i++) await f.service.backstop();
    await f.service.tick(A);
    assert.equal(f.calls(), before, 'TRUSTED_RUNTIME_UNCHANGED_SETTINGS');
    assert.ok(f.cycles.get(A).includes('TIME'), 'TRUSTED_DUE_WORK_RETAINED');
    f.time(600001); await f.service.backstop(); assert.ok(f.calls() > before, 'TRUSTED_RUNTIME_SLOW_RECONCILIATION');
    await f.service.close();
  });
  it('rechecks a write that arrives during an earlier acquisition rather than clearing it', async function () {
    const f = await evaluatorFixture(), hold = deferred(); f.hold(hold); f.write();
    const first = f.service.backstop([A]); await new Promise(resolve => setImmediate(resolve));
    f.write(); const second = f.service.backstop([A]); hold.resolve();
    await Promise.all([first, second]); await f.service.backstop([A]);
    assert.equal(f.cycles.get(A).at(-1), 3, 'TRUSTED_WRITE_DURING_EVALUATION_RETAINED');
    assert.deepEqual(f.cycles.get(B), [1], 'TRUSTED_UNCHANGED_PEER_NOT_EVALUATED');
    await f.service.close();
  });
  it('retains a feed dirty hint arriving while its previous checkpoint is evaluated', async function () {
    const { EventEmitter } = require('node:events');
    const f = await evaluatorFixture(), client = new EventEmitter();
    client.query = async () => {}; client.end = async () => {};
    const channel = 'trusted_signal';
    const feed = require('../lib/change-feed/consumer').create({ tenants: [A, B], config: { channel, pageSize: 2, degradedPages: 1, intervalMs: 1000, heartbeatTimeoutMs: 5000, sweepMs: 30000 },
      now: () => 0, schedule: () => null, cancel () {}, alert () {}, connect: async () => client,
      check: (selected, options) => f.service.backstop(selected, options) });
    const send = value => client.emit('notification', { channel, payload: JSON.stringify({ v: 1, ...value }) });
    try {
      await feed.start(); send({ k: 'heartbeat', reader: A }); await feed.tick();
      const hold = deferred(); f.hold(hold); f.write(); send({ k: 'data', t: A });
      const first = feed.tick(); await new Promise(resolve => setImmediate(resolve));
      f.write(); send({ k: 'data', t: A }); hold.resolve(); await first;
      await feed.tick();
      assert.equal(f.cycles.get(A).at(-1), 3, 'TRUSTED_FEED_DIRTY_GENERATION_NOT_LOST');
      assert.deepEqual(f.cycles.get(B), [1]);
    } finally { await feed.close(); await f.service.close(); }
  });

  it('discovers an unhinted settings change and pauses/unpauses from batched activity', async function () {
    const f = await evaluatorFixture({ activity: true });
    const initial = f.calls(); f.metadata.get(A).settings = 2;
    await f.service.backstop([A]);
    assert.ok(f.calls() > initial, 'TRUSTED_UNHINTED_SETTINGS_FOUND');
    const before = f.cycles.get(A).length;
    f.metadata.get(A).activity = { state: 'paused' };
    await f.service.backstop([A]); await f.service.tick(A);
    assert.equal(f.cycles.get(A).length, before, 'TRUSTED_PAUSED_NO_CLINICAL_WORK');
    f.metadata.get(A).activity = { state: 'active' }; await f.service.backstop([A]);
    assert.ok(f.cycles.get(A).length > before, 'TRUSTED_UNPAUSE_REACQUIRES');
    await f.service.close();
  });
  it('fences in-flight and cached clinical output across worker failure and quick recovery', async function () {
    const f = fixture(), source = 'a'.repeat(64); await f.reader.verify(); await f.reader.scan([A]);
    const held = deferred(), started = deferred();
    const service = await runtime({ tenants: [A], readCurrent: async tenant => { const state = await f.reader.read(tenant); return { tenant, identity: 'b'.repeat(64), sourceIdentity: source, settingsVersion: state.version, policyGeneration: state.policyGeneration, settingsReadAt: state.readAt }; },
      readMetadata: f.reader.scan, metadataCurrent: f.reader.current, readSource: () => source,
      create: async () => ({ evaluate: async () => ({ checkpoint: 1, signature: { stamp: 1, deleted: 0 } }), evaluateTime: async () => { started.resolve(); await held.promise; return { checkpoint: 1, properties: { alarm: true } }; }, close () {} }),
      recoveryIntervalMs: 1000, timeIntervalMs: 1000, schedule: () => 1, cancel () {}, setTimer: () => 1, clearTimer () {} });
    const pending = service.tick(A); await started.promise;
    f.reader.invalidate(); assert.equal(service.last(A), null, 'TRUSTED_UNAVAILABLE_CACHE_INELIGIBLE');
    await f.reader.verify(); held.resolve(); await pending;
    assert.equal(service.last(A), null, 'TRUSTED_INFLIGHT_OUTPUT_FENCED_AFTER_RECOVERY');
    assert.equal(service.health().tenants[0].outputRevision, null, 'TRUSTED_INFLIGHT_REVISION_NOT_PUBLISHED');
    f.reader.invalidate(); await assert.rejects(service.backstop([A], { recovery: true }), /TRUSTED_WORKER_UNAVAILABLE/, 'TRUSTED_FEED_RECONCILIATION_FAILURE_PROPAGATES');
    await f.reader.verify(); await service.backstop([A], { recovery: true });
    assert.equal(service.last(A)?.eligible, true, 'TRUSTED_RECOVERY_REACQUIRES_BEFORE_ELIGIBILITY');
    await service.close(); await f.reader.close();
  });
  it('fences realtime frames and propagates detector failures for feed retry', async function () {
    let available = true, generation = 0, fail = false, fanouts = 0;
    const held = deferred(), started = deferred(); let block = false;
    const service = await require('../lib/server/realtime/runtime')({ tenants: [A], eventDriven: true,
      workerState: () => ({ available, generation }), readCurrent: async tenant => ({ tenant, identity: 'same' }),
      create: () => ({ acquire: async () => { if (block) { started.resolve(); await held.promise; } return { tenant: A, checkpoint: 1, frame: {} }; } }),
      fanout: async () => { fanouts++; }, detect: async () => { if (fail) throw new Error('metadata unavailable'); return new Map([[A, { stamp: '1', identity: 'same' }]]); },
      recoveryIntervalMs: 1000, schedule: () => 1, cancel () {} });
    block = true; const pending = service.refresh(A); pending.catch(() => {}); await started.promise;
    available = false; generation++; assert.equal(service.last(A), null); assert.equal(service.warm(A), false);
    available = true; held.resolve(); await assert.rejects(pending, /TRUSTED_WORKER_UNAVAILABLE/);
    assert.equal(fanouts, 1, 'TRUSTED_REALTIME_LATE_FRAME_NOT_PUBLISHED');
    fail = true; await assert.rejects(service.check([A]), /metadata unavailable/, 'TRUSTED_REALTIME_DETECT_FAILURE_PROPAGATES');
    await service.close();
  });
  it('reacquires previously warm quiet realtime cells once after metadata recovery', async function () {
    let available = true, generation = 0, fail = false, acquisitions = 0;
    const service = await require('../lib/server/realtime/runtime')({ tenants: [A], eventDriven: true,
      workerState: () => ({ available, generation }), readCurrent: async tenant => ({ tenant, identity: 'same' }),
      create: () => ({ acquire: async () => { acquisitions++; return { tenant: A, checkpoint: 1, frame: {} }; } }),
      fanout: async () => {}, detect: async () => { if (fail) throw new Error('metadata unavailable'); return new Map([[A, { stamp: '1', identity: 'same' }]]); },
      recoveryIntervalMs: 1000, schedule: () => 1, cancel () {} });
    fail = true; available = false; generation++;
    await assert.rejects(service.check([A]), /metadata unavailable/);
    fail = false; available = true; await service.check([A]);
    assert.equal(acquisitions, 2, 'TRUSTED_RT_RECOVERY_REACQUIRES');
    assert.equal(service.warm(A), true); assert.ok(service.last(A));
    await service.check([A]); assert.equal(acquisitions, 2, 'TRUSTED_RT_QUIET_AFTER_RECOVERY');
    await service.close();
  });
  it('checks the captured runtime epoch after protocol fanout awaits and before socket emission', async function () {
    let available = true, generation = 0, stamp = 0, block = false, service;
    const started = deferred(), held = deferred(), events = [];
    const socket = { id: 'synthetic', request: { headers: { host: 'one.example.test' }, socket: {} }, rooms: new Set(['synthetic']), handlers: {},
      on (name, fn) { this.handlers[name] = fn; }, emit (name) { events.push(name); }, join (room) { this.rooms.add(room); }, leave (room) { this.rooms.delete(room); }, disconnect () {} };
    const current = { identity: 'same' };
    const protocol = require('../lib/server/realtime/protocol').create({ admission: { resolve: async () => A },
      api: { authorizeSocket: async () => ({ permissions: { read: true, write: false, write_treatment: false, ack: false }, collections: ['entries'] }), executeSocketMutation: async () => {} },
      runtime: () => service, readCurrent: async () => { if (block) { started.resolve(); await held.promise; } return current; }, domains: ['entries'] });
    try {
      service = await require('../lib/server/realtime/runtime')({ tenants: [A], eventDriven: true, recoveryIntervalMs: 1000, workerState: () => ({ available, generation }),
        readCurrent: async () => current, create: () => ({ acquire: async () => ({ tenant: A, checkpoint: stamp, rows: stamp ? [{ domain: 'entries', document: { _id: 'synthetic', type: 'sgv', sgv: 123 } }] : [], frame: {} }) }),
        fanout: protocol.fanout, schedule: () => 1, cancel () {} });
      await protocol.prepare(socket); protocol.bind(socket, '/storage'); let reply;
      await socket.handlers.subscribe({ accessToken: 'synthetic-token', collections: ['entries'] }, value => { reply = value; });
      assert.equal(reply.success, true); stamp++; block = true;
      const pending = service.refresh(A); pending.catch(() => {}); await started.promise;
      available = false; generation++; available = true; held.resolve();
      await assert.rejects(pending, /TRUSTED_WORKER_UNAVAILABLE/);
      assert.equal(events.includes('create'), false, 'TRUSTED_PROTOCOL_NO_STALE_EMISSION');
    } finally { protocol.close(); await service?.close(); }
  });

});


describe('joined worker operational verification', function () {
  it('awaits the configured whole batch outside the invoking tenant scope', async function () {
    const f=fixture();let timer,at=0,held=null,calls=0;
    const lifecycle=await require('../lib/trusted-worker/lifecycle')(f.reader,{intervalMs:10,retryMs:1,now:()=>at,schedule:fn=>{timer=fn;return 1;},cancel(){},verifyWorker:async()=>{
      assert.equal(scope.currentTenant(),undefined);f.reader.invalidate();calls++;if(held)await held.promise;await f.reader.verify();
    }});
    await f.reader.scan([A]);held=deferred();at=20;
    const previous=scope.getTenancyMode();scope.setTenancyMode('multi');
    try { await scope.withTenant(A,async()=>{timer();assert.equal(f.reader.health().available,false);}); }
    finally { scope.setTenancyMode(previous); }
    const pending=lifecycle.verify();await assert.rejects(f.reader.read(A),/TRUSTED_WORKER_UNAVAILABLE/);
    held.resolve();await pending;assert.equal(calls,2);assert.equal(f.reader.health().available,true);await lifecycle.close();await f.reader.close();
  });
});

describe('coordinated evaluator operational refresh', function () {
  const settle = () => new Promise(resolve => setImmediate(resolve));
  it('holds the real model epoch fence until verification and clinical completion finish, with one refresh', async function () {
    const f = fixture(), source = 'a'.repeat(64);
    let timer, at = 0, held, service, refreshes = 0;
    const lifecycle = await require('../lib/trusted-worker/lifecycle')(f.reader, {
      intervalMs: 10, now: () => at, schedule: fn => { timer = fn; return 1; }, cancel () {},
      verifyWorker: async () => { assert.equal(scope.currentTenant(), undefined); f.reader.invalidate(); if (held) await held.promise; await f.reader.verify(); },
      refreshWorker: async () => { refreshes++; await service.backstop([A, B], { recovery: true }); }
    });
    await f.reader.scan([A, B]);
    service = await runtime({ tenants: [A, B], externalRecovery: true,
      readCurrent: async tenant => { const row = await f.reader.read(tenant); return { tenant, identity: 'b'.repeat(64), sourceIdentity: source, settingsVersion: row.version, policyGeneration: row.policyGeneration, settingsReadAt: row.readAt }; },
      readMetadata: f.reader.scan, metadataCurrent: f.reader.current, readSource: () => source,
      create: async () => ({ evaluate: async () => ({ checkpoint: 1, signature: { stamp: 1, deleted: 0 } }), close () {} }),
      recoveryIntervalMs: 1000, timeIntervalMs: 1000, schedule: () => 1, cancel () {}, setTimer: () => 1, clearTimer () {} });
    try {
      assert(service.health().tenants.every(row => row.ready));
      held = deferred(); at = 20; timer(); timer(); await settle();
      assert.equal(refreshes, 0, 'CLINICAL_REFRESH_MUST_WAIT_FOR_VERIFICATION');
      assert(service.health().tenants.every(row => !row.ready));
      assert.equal(service.last(A), null, 'OLD_EPOCH_OUTPUT_REFUSED');
      held.resolve(); await lifecycle.verify(); await settle();
      assert.equal(refreshes, 1, 'ONE_REFRESH_FOR_CONCURRENT_TIMER_TICKS');
      assert(service.health().tenants.every(row => row.ready), 'VERIFIED_EPOCH_MUST_BE_ADOPTED_WITHOUT_ANOTHER_TIMER');
      assert(service.health().tenants.every(row => row.progress.failedCompletions === 0));
      assert.equal(service.last(A)?.eligible, true);
    } finally { await lifecycle.close(); await service.close(); await f.reader.close(); }
  });
  it('retains the custom settings cadence and retries failed refresh without repeating successful verification', async function () {
    let timer, at = 0, verifies = 0, refreshes = 0, refuse = true;
    const reader = { health: () => ({ available: true }), verify: async () => { verifies++; } };
    const lifecycle = await require('../lib/trusted-worker/lifecycle')(reader, {
      intervalMs: 100, refreshMs: 10, now: () => at, schedule: fn => { timer = fn; return 1; }, cancel () {},
      refreshWorker: async () => { refreshes++; if (refuse) throw new Error('clinical guard refused'); }
    });
    try {
      at = 11; timer(); await settle(); assert.equal(refreshes, 1); assert.equal(verifies, 1);
      refuse = false; timer(); await settle(); assert.equal(refreshes, 2); assert.equal(verifies, 1);
      timer(); await settle(); assert.equal(refreshes, 2);
      // Manual schema/transport verification cannot run clinical work until its
      // caller has reopened the feed. The next scheduled pass adopts the epoch.
      await lifecycle.verify(); assert.equal(refreshes, 2); timer(); await settle(); assert.equal(refreshes, 3);
    } finally { await lifecycle.close(); }
  });
});

describe('normal operational verification and owned clinical dispatch', function () {
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  it('drains an entered cycle and retains queued work across the real 600s operational boundary', async function () {
    const f=fixture(),window=require('./fixtures/operation-window-runtime-protocol')({trustedWorker:true});
    const contexts=require('../lib/server/serve/evaluator-job-context');
    const jobs=contexts.create('clinical'),source='a'.repeat(64);
    let service,timer,at=0,calls=0,evaluationHold;
    const evaluationStarted=deferred(),verifyEntered=deferred(),verifyHold=deferred();
    await window.window.ready();
    const lifecycle=await require('../lib/trusted-worker/lifecycle')(f.reader,{
      now:()=>at,schedule:fn=>{timer=fn;return 1;},cancel(){},
      verifyWorker:periodic=>{
        const verify=()=>{f.reader.invalidate();return window.window.verifyOperational(async()=>{
          if(++calls>1){verifyEntered.resolve();await verifyHold.promise;}
          await f.reader.verify();
        });};
        return periodic&&service?service.verifyOperational(verify):verify();
      },refreshWorker:jobs.bind(()=>service.backstop([A],{recovery:true}))
    });
    await f.reader.scan([A]);
    service=await runtime({tenants:[A],externalRecovery:true,operationWindow:window.window,jobContext:jobs,
      readCurrent:async tenant=>{const row=await f.reader.read(tenant);return {tenant,identity:'b'.repeat(64),sourceIdentity:source,settingsVersion:row.version,policyGeneration:row.policyGeneration,settingsReadAt:row.readAt};},
      readMetadata:f.reader.scan,metadataCurrent:f.reader.current,readSource:()=>source,
      create:async()=>({evaluate:async()=>{if(evaluationHold){evaluationStarted.resolve();await evaluationHold.promise;}return {checkpoint:1,signature:{stamp:1,deleted:0}};},close(){}}),
      recoveryIntervalMs:1000,timeIntervalMs:1000,schedule:()=>1,cancel(){},setTimer:()=>1,clearTimer(){}});
    const initial=service.health().tenants[0].progress.generation;
    let entered,queued,authority;const authorityHold=deferred();
    try{
      evaluationHold=deferred();entered=service.acquire(A);await evaluationStarted.promise;
      f.time(600001);f.hold(authorityHold);
      authority=window.window.run(A,()=>service.isCurrent(A,'b'.repeat(64)));authority.catch(()=>{});await settle();
      at=600001;timer();await settle();evaluationHold.resolve();await entered;
      await verifyEntered.promise;
      authorityHold.resolve();await assert.rejects(authority,{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
      await assert.rejects(window.window.run(A,()=>assert.fail('WITHDRAWN_EPOCH_EFFECT')), {code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
      queued=service.acquire(A);verifyHold.resolve();await lifecycle.verify();await queued;
      await settle();await service.backstop([A],{recovery:true});
      const row=service.health().tenants[0];
      assert.equal(row.progress.generation,initial,'BENIGN_VERIFY_MUST_NOT_DISCARD_CURRENT_MODEL');
      assert.equal(row.progress.failedCompletions,0,'NORMAL_VERIFY_MUST_DRAIN_BEFORE_WITHDRAWAL');
      assert.equal(row.ready,true);assert.equal(row.code,null);await window.window.run(A,()=>assert(service.last(A)));
    }finally{evaluationHold?.resolve();authorityHold.resolve();verifyHold.resolve();await Promise.allSettled([entered,queued,authority]);await lifecycle.close();await service.close();await f.reader.close();await window.window.close();}
  });
  it('waits for an entered metadata read and closes queued dispatch without restarting it', async function () {
    const f=fixture(),source='a'.repeat(64);await f.reader.verify();await f.reader.scan([A]);
    let evaluations=0;
    const service=await runtime({tenants:[A],externalRecovery:true,
      readCurrent:async tenant=>({tenant,identity:'b'.repeat(64),sourceIdentity:source}),
      readMetadata:f.reader.scan,metadataCurrent:f.reader.current,readSource:()=>source,
      create:async()=>({evaluate:async()=>{evaluations++;return {checkpoint:1,signature:{stamp:1,deleted:0}};},close(){}}),
      recoveryIntervalMs:1000,timeIntervalMs:1000,schedule:()=>1,cancel(){},setTimer:()=>1,clearTimer(){}});
    const entered=deferred(),scanHold=deferred(),verifyHold=deferred();
    const original=f.connection.readOnly;let hold=true,verified=false;
    f.connection.readOnly=async(...args)=>{const result=await original(...args);if(hold&&args[0].includes('activity_version')){hold=false;entered.resolve();await scanHold.promise;}return result;};
    let pass,verifying,queued;
    try {
      pass=service.backstop([A]);await entered.promise;
      verifying=service.verifyOperational(async()=>{verified=true;await verifyHold.promise;});
      await settle();assert.equal(verified,false,'VERIFY_MUST_DRAIN_ENTERED_METADATA');
      scanHold.resolve();await pass;await settle();assert.equal(verified,true);
      const count=evaluations;queued=service.acquire(A);await service.close();await queued;
      verifyHold.resolve();await verifying;await settle();
      assert.equal(evaluations,count,'CLOSE_MUST_NOT_RESTART_PAUSED_WORK');
    }finally{scanHold.resolve();verifyHold.resolve();await Promise.allSettled([pass,verifying,queued]);await service.close();await f.reader.close();}
  });

});
