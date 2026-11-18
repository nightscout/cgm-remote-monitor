'use strict';
const assert = require('node:assert/strict');
const worker = require('../lib/trusted-worker/postgres');
const runtime = require('../lib/server/serve/evaluator-runtime');
const scope = require('../lib/storage/tenant-scope');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const ns = { activity: 'tw_activity', clock: 'tw_clock', settings: 'tw_settings', operatorPolicy: 'tw_policy' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture (options = {}) {
  let version = 1, generation = 1, at = 0, held;
  const calls = [];
  const connection = { async readOnly (text, values) {
    calls.push({ text, values, tenant: scope.currentTenant() });
    if (/FROM pg_class/.test(text)) return { rows: values[0].map(() => ({ secured: true, owns: false, writes: false })) };
    if (/WHERE false/.test(text)) return { rows: [] };
    if (/activity_version/.test(text)) return { rows: values[0].map(tenant => ({ tenant, activity_version: '1', paused: false, suspended: false, settings: version, policy: generation, stamp: '1', deleted: '0' })) };
    if (held) await held.promise;
    return { rows: [{ version, values: { SHOW_SECONDS: version % 2 === 0 }, generation, policy: { deployment: {}, overrides: {} } }] };
  } };
  const reader = worker.create({ connection, namespaces: ns, now: () => at, ...options });
  return { reader, calls, connection, bump: () => { version++; }, policy: () => { generation++; }, time: value => { at = value; }, hold: value => { held = value; } };
}
describe('trusted worker metadata and operational scope', function () {
  it('native stream metadata never reads or requires the public history clock', async function(){
    const f=fixture({stream:true});
    const original=f.connection.readOnly;
    f.connection.readOnly=async(text,values)=>{assert(!text.includes('tenant_write_clock'),'NATIVE_METADATA_RETIRED_CLOCK_READ');assert(!values?.[0]?.includes?.('"tw_clock".tenant_write_clock'),'NATIVE_METADATA_RETIRED_CLOCK_ADMISSION');const result=await original(text,values);if(text.includes('activity_version'))for(const row of result.rows){row.stamp=null;row.deleted=null;}return result;};
    await f.reader.verify();const rows=await f.reader.scan([A]);assert.equal(rows.get(A).signature,null);await f.reader.close();
  });

  it('keeps full bigint activity versions exact through recovery bootstrap', async function () {
    for (const version of ['9007199254740993', '9223372036854775807']) {
      const f = fixture(), original = f.connection.readOnly;
      f.connection.readOnly = async (...args) => { const result = await original(...args); if (/activity_version/.test(args[0])) for (const row of result.rows) row.activity_version = version; return result; };
      await f.reader.verify(); const rows = await f.reader.scan([A]);
      let observed;
      await require('../lib/pgstream/bootstrap')({ observeMany: async page => { observed = page[0].observed.activity; } }, rows);
      assert.equal(observed, version, 'BOOTSTRAP_MUST_KEEP_EXACT_ACTIVITY_VERSION');
      assert.notEqual(String(Number(version)), version, 'NUMBER_CONVERSION_CONTROL_MUST_LOSE_PRECISION');
      await f.reader.close();
    }
    for (const version of [9007199254740992, '9223372036854775808', '01', null]) {
      const f = fixture(), original = f.connection.readOnly;
      f.connection.readOnly = async (...args) => { const result = await original(...args); if (/activity_version/.test(args[0])) for (const row of result.rows) row.activity_version = version; return result; };
      await f.reader.verify(); await assert.rejects(f.reader.scan([A]), /TRUSTED_WORKER_UNAVAILABLE/); await f.reader.close();
    }
  });
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
    assert.equal(f.reader.health().settingsReads, count, 'UNCHANGED_VERSION_MUST_NOT_EXPIRE');
    await f.reader.close();
  });
  it('retains settings by version across elapsed time, and reloads a committed version change', async () => {
    const f=fixture(); await f.reader.verify(); await f.reader.scan([A]);
    const first=await f.reader.read(A), before=f.reader.health().settingsReads;
    f.time(600001); assert.equal(await f.reader.read(A),first);
    assert.equal(f.reader.health().settingsReads,before,'UNCHANGED_VERSION_MUST_NOT_EXPIRE');
    f.bump(); await f.reader.scan([A]); assert.equal((await f.reader.read(A)).version,2); await f.reader.close();
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
  it('re-arms the serving reader outside the requesting tenant without catalogue SQL', async function () {
    const f = fixture();
    const lifecycle = await require('../lib/trusted-worker/lifecycle')(f.reader);
    const before = f.calls.length;
    const previousMode = scope.getTenancyMode();
    scope.setTenancyMode('multi');
    try { await scope.withTenant(A, async () => { await lifecycle.verify(); }); }
    finally { scope.setTenancyMode(previousMode); }
    assert.equal(f.calls.length - before, 0, 'NO_CATALOGUE_SCREEN_WHILE_SERVING');
    assert.equal(f.reader.health().available, true);
    await lifecycle.close(); await f.reader.close();
  });
  // Decision platform-application-boundary: the catalogue screen is the admin
  // pre-start step's. It refuses RLS, ownership and write-privilege drift.
  it('admin catalogue screen refuses RLS, ownership and write drift and accepts the reviewed shape', async function () {
    for (const [drift, expected] of [[{}, null], [{ secured: false }, /TRUSTED_WORKER_UNAVAILABLE/], [{ owns: true }, /TRUSTED_WORKER_UNAVAILABLE/], [{ writes: true }, /TRUSTED_WORKER_UNAVAILABLE/]]) {
      const calls = [];
      const connection = { async readOnly (text, values) {
        calls.push({ text, tenant: scope.currentTenant() });
        if (/FROM pg_class/.test(text)) return { rows: values[0].map(() => ({ secured: true, owns: false, writes: false, ...drift })) };
        return { rows: [] };
      } };
      const screened = worker.screen({ connection, namespaces: ns });
      if (expected) await assert.rejects(screened, expected); else await screened;
      assert(calls.every(row => row.tenant === undefined), 'ADMIN_SCREEN_OUTSIDE_TENANT');
    }
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
  it('binds trusted namespaces and refuses retired polling settings in the product configuration', function () {
    const fixture = require('./fixtures/multitenant-plan');
    const layout = fixture.layout(), urls = fixture.syntheticUrls(layout);
    const docs = fixture.documents({ layout, urls, variant: 'full' });
    const parse = require('../lib/server/serve/evaluator-config').parseMetadata;
    const original = docs.configs.evaluator;
    for (const key of ['changeFeed', 'recoveryIntervalMs', 'settingsRefreshMs']) delete original[key];
    delete original.postgres.namespaces.changeStamps;
    if (!original.pgstream) original.pgstream = { receiver:{url:'http://127.0.0.1:'+18080+'/',trust:'network',bindHost:'127.0.0.1',maxBytes:16777216,timeoutMs:5000}, slot: 'trusted_stream', streamRole: 'trusted_stream',
      bounds: { stepMs: 5000, recoveryMs: 30000, pendingMs: 30000 } };
    assert.equal(Object.hasOwn(parse(original), 'settingsRefreshMs'), false);
    assert.equal(parse(original).timeIntervalMs, original.timeIntervalMs);
    for (const name of ['activity', 'settings', 'operatorPolicy', 'clock']) {
      const changed = structuredClone(original); changed.trustedWorker[name] = 'other_' + name.toLowerCase();
      assert.throws(() => parse(changed), /explicit evaluator/);
    }
    for (const settingsRefreshMs of [0, -1, 1.5, 1000, 2147483648]) assert.throws(() => parse({ ...original, settingsRefreshMs }), /explicit evaluator/);
    assert.equal(parse(original).trustedWorker.clock, original.postgres.namespaces.clock);
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
    // Drain the queued post-cycle signature check before advancing time.
    await new Promise(resolve => setImmediate(resolve)); const settled = f.calls();
    f.time(600001); await f.service.backstop(); assert.equal(f.calls(), settled, 'UNCHANGED_RUNTIME_CONFIG_MUST_NOT_EXPIRE');
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
    const f=fixture();let held=null,calls=0,pending;
    const lifecycle=await require('../lib/trusted-worker/lifecycle')(f.reader,{verifyWorker:async()=>{
      assert.equal(scope.currentTenant(),undefined);f.reader.invalidate();calls++;if(held)await held.promise;await f.reader.verify();
    }});
    await f.reader.scan([A]);held=deferred();
    const previous=scope.getTenancyMode();scope.setTenancyMode('multi');
    try { await scope.withTenant(A,async()=>{pending=lifecycle.verify();assert.equal(f.reader.health().available,false);}); }
    finally { scope.setTenancyMode(previous); }
    assert.equal(lifecycle.verify(),pending);await assert.rejects(f.reader.read(A),/TRUSTED_WORKER_UNAVAILABLE/);
    held.resolve();await pending;assert.equal(calls,2);assert.equal(f.reader.health().available,true);await lifecycle.close();await f.reader.close();
  });
});

describe('explicit worker verification and recovery', function () {
  const settle = () => new Promise(resolve => setImmediate(resolve));
  it('coalesces explicit verification and adopts the model epoch only through real recovery', async function () {
    const f = fixture(), source = 'a'.repeat(64); let held, service;
    const lifecycle = await require('../lib/trusted-worker/lifecycle')(f.reader, {
      verifyWorker: async () => { assert.equal(scope.currentTenant(), undefined); f.reader.invalidate(); if (held) await held.promise; await f.reader.verify(); }
    });
    await f.reader.scan([A, B]);
    service = await runtime({ tenants: [A, B], externalRecovery: true,
      readCurrent: async tenant => { const row = await f.reader.read(tenant); return { tenant, identity: 'b'.repeat(64), sourceIdentity: source, settingsVersion: row.version, policyGeneration: row.policyGeneration }; },
      readMetadata: f.reader.scan, metadataCurrent: f.reader.current, readSource: () => source,
      create: async () => ({ evaluate: async () => ({ checkpoint: 1, signature: { stamp: 1, deleted: 0 } }), close () {} }),
      recoveryIntervalMs: 1000, timeIntervalMs: 1000, schedule: () => 1, cancel () {}, setTimer: () => 1, clearTimer () {} });
    try {
      held=deferred();const before=f.reader.health().operationalChecks,pending=lifecycle.verify();assert.equal(lifecycle.verify(),pending);
      await settle();assert.equal(service.last(A),null,'WITHDRAWN_WORKER_OUTPUT_REFUSED');
      held.resolve();await pending;
      assert.equal(f.reader.health().operationalChecks,before+1,'ONE_CHECK_FOR_CONCURRENT_REQUESTS');
      assert.equal(service.last(A),null,'VERIFICATION_ALONE_MUST_NOT_ADOPT_CLINICAL_EPOCH');
      await service.backstop([A,B],{recovery:true});assert.equal(service.last(A)?.eligible,true);
    } finally { held?.resolve();await lifecycle.close();await service.close();await f.reader.close(); }
  });
  it('retries an actual verification refusal on the next explicit request, without a refresh cadence', async () => {
    let calls=0,refuse=false;
    const lifecycle=await require('../lib/trusted-worker/lifecycle')({verify:async()=>{calls++;if(refuse)throw Error('SYNTHETIC_SCHEMA_REFUSAL');}});
    try { refuse=true;await assert.rejects(lifecycle.verify(),/SYNTHETIC_SCHEMA_REFUSAL/);
      refuse=false;await lifecycle.verify();assert.equal(calls,3);
    } finally { await lifecycle.close(); }
  });
});

describe('normal operational verification and owned clinical dispatch', function () {
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  it('drains recovery-page cycles before invalidation while another tenant keeps progressing', async function () {
    const f=fixture(),window=require('./fixtures/operation-window-runtime-protocol')({trustedWorker:true});
    await window.window.ready();await f.reader.verify();await f.reader.scan([A,B]);
    let hold,entered,recovery,queued,queuedDone=false;const started=deferred(),source='a'.repeat(64),jobs=require('../lib/server/serve/evaluator-job-context').create('clinical');
    const service=await runtime({tenants:[A,B],externalRecovery:true,operationWindow:window.window,jobContext:jobs,
      readCurrent:async tenant=>{const row=await f.reader.read(tenant);return {tenant,identity:'b'.repeat(64),sourceIdentity:source,settingsVersion:row.version,policyGeneration:row.policyGeneration,settingsReadAt:row.readAt};},
      readMetadata:f.reader.scan,metadataCurrent:f.reader.current,readSource:()=>source,
      create:async current=>({evaluate:async()=>{if(current.tenant===A&&hold){started.resolve();await hold.promise;}return {checkpoint:1,signature:{stamp:1,deleted:0}};},signature:async()=>({stamp:1,deleted:0}),close(){}}),
      recoveryIntervalMs:1000,timeIntervalMs:1000,schedule:()=>1,cancel(){},setTimer:()=>1,clearTimer(){}});
    const initial=service.health([A]).tenants[0].progress.generation,beforeB=service.health([B]).tenants[0].progress.completedAcquisitions;
    try{
      hold=deferred();entered=service.acquire(A);await started.promise;
      const scans=f.reader.health().scans;recovery=service.backstop([A],{recovery:true});
      queued=service.acquire(A).then(()=>{queuedDone=true;});await settle();
      assert.equal(f.reader.health().scans,scans,'RECOVERY_SCAN_MUST_WAIT_ENTERED_PAGE_CYCLE');assert.equal(queuedDone,false);
      await service.acquire(B);assert(service.health([B]).tenants[0].progress.completedAcquisitions>beforeB,'OTHER_TENANT_MUST_PROGRESS_DURING_PAGE_DRAIN');
      hold.resolve();await Promise.all([entered,recovery,queued]);
      const result=service.health([A]).tenants[0];assert.equal(result.progress.generation,initial);assert.equal(result.progress.failedCompletions,0);assert.equal(result.ready,true);
    }finally{hold?.resolve();await Promise.allSettled([entered,recovery,queued]);await service.close();await f.reader.close();await window.window.close();}
  });

  it('refuses a pre-recovery authority read without discarding the recovered model, then rebuilds an actual settings change', async function () {
    const f=fixture(),hold=deferred(),started=deferred(),source='a'.repeat(64);await f.reader.verify();await f.reader.scan([A]);
    const service=await runtime({tenants:[A],externalRecovery:true,
      readCurrent:async tenant=>{const row=await f.reader.read(tenant);return {tenant,identity:(row.version===1?'b':'c').repeat(64),sourceIdentity:source,settingsVersion:row.version,policyGeneration:row.policyGeneration,settingsReadAt:row.readAt};},
      readMetadata:f.reader.scan,metadataCurrent:f.reader.current,readSource:()=>source,
      create:async()=>({evaluate:async()=>({checkpoint:1,signature:{stamp:1,deleted:0}}),signature:async()=>({stamp:1,deleted:0}),close(){}}),
      recoveryIntervalMs:1000,timeIntervalMs:1000,schedule:()=>1,cancel(){},setTimer:()=>1,clearTimer(){}});
    const initial=service.health().tenants[0].progress.generation,read=f.connection.readOnly;let first=true,authority;
    f.connection.readOnly=async(...args)=>{const result=await read(...args);if(first&&/activity_version/.test(args[0])){first=false;started.resolve();await hold.promise;}return result;};
    try{
      f.time(600001);authority=service.isCurrent(A,'b'.repeat(64));await started.promise;
      await service.backstop([A],{recovery:true});hold.resolve();assert.equal(await authority,false,'PRE_RECOVERY_AUTHORITY_READ_STAYS_REFUSED');
      assert.equal(service.health().tenants[0].progress.generation,initial,'REFUSED_OLD_AUTHORITY_MUST_NOT_DISCARD_RECOVERED_MODEL');assert.equal(await service.isCurrent(A,'b'.repeat(64)),true);
      f.bump();await service.backstop([A],{recovery:true});assert(service.health().tenants[0].progress.generation>initial);assert.equal(service.health().tenants[0].identity,'c'.repeat(64));
    }finally{hold.resolve();await Promise.allSettled([authority]);await service.close();await f.reader.close();}
  });

});
