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

});
