'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const scope = require('../lib/storage/tenant-scope');
const parse = require('../lib/server/serve/evaluator-config');
const readiness = require('../lib/server/serve/evaluator-consumer-readiness');
const protocol = require('./fixtures/evaluator-consumers-protocol');
const A = '11111111-1111-4111-8111-111111111111';
function document () {
  return { version: 1, postgres: { connectionEnv: 'EVAL_PG', namespaces: Object.fromEntries(
    ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'clock', 'checkpoint'].map(name => [name, 'eval_' + name])) },
  consumer: 'evaluator-composed', pageSize: 1, maxRows: 10, maxBytes: 10000, maxTenants: 2, recoveryIntervalMs: 100, timeIntervalMs: 200,
  tenants: [{ id: A, revision: 'one', settings: { enable: ['bgnow'] } }] };
}
function selected () {
  return { realtime: { outbox: { connectionEnv: 'OUTBOX_PG', namespace: 'composed_outbox', maxRows: 10, maxBytes: 100000, maxConnections: 2 },
    suppression: { connectionEnv: 'ALARM_PG', namespace: 'composed_alarm', maxRows: 10, maxBytes: 100000, maxConnections: 2 },
    route: { id: 'realtime-composed', maxMessageBytes: 20000, operationTimeoutMs: 500 },
    maxPayloadBytes: 10000, maxInflight: 2, attemptTimeoutMs: 1000, retryDelayMs: 100, pollIntervalMs: 100, retryIntervalMs: 200 } };
}
const source = { EVAL_PG: 'postgres://synthetic-evaluator:synthetic@127.0.0.1/composition_test',
  OUTBOX_PG: 'postgres://synthetic-outbox:synthetic@127.0.0.1:5432/composition_test',
  ALARM_PG: 'postgresql://synthetic-reader:synthetic@127.0.0.1/composition_test', NS_REALTIME_INTERNAL_SOCKET: '/tmp/synthetic-composition/rt.sock' };

describe('explicit evaluator consumer configuration', function () {
  it('is default-off and admits same datastore with different restricted principals rather than equal credential URLs', async function () {
    const off = parse.parse(document(), source); assert.equal(off.consumers, undefined);
    assert.equal(await require('../lib/server/serve/evaluator-consumers').prepare({ config: off }), null);
    const d = document(); d.consumers = selected(); const configured = parse.parse(d, source);
    assert.equal(configured.consumers.realtime.outbox.connectionString, source.OUTBOX_PG);
    assert.equal(configured.consumers.realtime.route.socketPath, source.NS_REALTIME_INTERNAL_SOCKET);
  });
  it('refuses unknown routes unsafe namespace/datastore and missing or non-Node-compatible explicit bounds', function () {
    for (const change of [d => { d.consumers.unknown = {}; }, d => { d.consumers.realtime.extra = true; },
      d => { delete d.consumers.realtime.retryIntervalMs; }, d => { d.consumers.realtime.pollIntervalMs = 2147483648; },
      d => { d.consumers.realtime.attemptTimeoutMs = 2147483648; }, d => { d.consumers.realtime.route.operationTimeoutMs = 1001; },
      d => { d.consumers.realtime.route.maxMessageBytes = 10000; },
      d => { d.consumers.realtime.outbox.namespace = 'public'; }, d => { d.consumers.realtime.suppression.namespace = 'eval_entries'; }]) {
      const d = document(); d.consumers = selected(); change(d); assert.throws(() => parse.parse(d, source), /evaluator consumer/);
    }
    const d = document(); d.consumers = selected();
    assert.throws(() => parse.parse(d, { ...source, OUTBOX_PG: source.OUTBOX_PG.replace('composition_test', 'another_test') }), /evaluator consumer/);
  });
  it('requires restart for consumer infrastructure or credential changes while rereading current tenant admission', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-config-')), file = path.join(dir, 'config.json');
    try {
      const d = document(); d.consumers = selected(); fs.writeFileSync(file, JSON.stringify(d));
      const env = { ...source, MULTITENANT_EVALUATOR_CONFIG: file }, loaded = parse.load(env);
      d.consumers.realtime.retryIntervalMs++; fs.writeFileSync(file, JSON.stringify(d)); await assert.rejects(loaded.readCurrent(A), /requires restart/);
      d.consumers.realtime.retryIntervalMs--; fs.writeFileSync(file, JSON.stringify(d));
      env.OUTBOX_PG = env.OUTBOX_PG.replace(':synthetic@', ':changed-synthetic@'); await assert.rejects(loaded.readCurrent(A), /requires restart/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('selected actual database consumer readiness protocols', function () {
  let mode;
  beforeEach(function () { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(function () { scope.setTenancyMode(mode); });
  it('challenges actual selected connections with one scoped nonce and refuses another datastore without credential comparison', async function () {
    let held = null; const observed = [];
    const clinical = { async transaction (fn) { try { return await fn(); } finally { held = null; } },
      async query (text, values) { held = values[0]; observed.push('owner'); return { rows: [] }; } };
    const target = acquired => ({ transaction: fn => fn(), async query (text, values) {
      assert.equal(values[0], held); assert.equal(scope.currentTenant(), A); observed.push('challenge'); return { rows: [{ acquired }] };
    } });
    await readiness.sameDatastore(clinical, [target(false), target(false)], A);
    assert.deepEqual(observed, ['owner', 'challenge', 'challenge']); assert.equal(held, null);
    await assert.rejects(readiness.sameDatastore(clinical, [target(true)], A), /READINESS_REFUSED/, 'EVALUATOR_CONSUMER_DATASTORE_PROOF');
    assert.equal(held, null); await assert.rejects(readiness.sameDatastore(clinical, [clinical], A), /READINESS_REFUSED/);
  });
  it('screens the selected suppression snapshot role table policy shape and exact read-only catalogue', async function () {
    const migration = require('../migrations/candidates/postgres-alarm-suppression-v1.json').migrations[0];
    const template = { kind: 'r', persistence: 'p', secured: true,
      columns: [['tenant_id', 'uuid', true], ['alarm_group', 'text', true], ['alarm_level', 'integer', true], ['acked_at', 'bigint', true], ['expires_at', 'bigint', true]],
      primary_key: ['tenant_id', 'alarm_group', 'alarm_level'], policies: [{ command: '*', roles: [0], permissive: true,
        using: "tenant_id = nullif(current_setting('app.current_tenant_id',true),'')::uuid", check: "tenant_id = nullif(current_setting('app.current_tenant_id',true),'')::uuid" }] };
    const db = flags => ({ async query (text) {
      if (text.includes('suppression-role')) return { rows: [{ uses_schema: true, unrelated: flags.unrelated, creates: flags.creates, operator: flags.operator }] };
      if (text.includes('suppression-shape')) return { rows: [{ ...structuredClone(template), ...(flags.shape || {}) }] };
      return { rows: flags.history || [{ name: migration.name, checksum: migration.checksum }] };
    } });
    await readiness.suppression(db({}), 'alarm_test');
    for (const flags of [{ unrelated: true }, { creates: true }, { operator: true }, { shape: { secured: false } },
      { shape: { policies: [] } }, { shape: { primary_key: ['alarm_group'] } }, { shape: { columns: [] } }, { history: [] }]) {
      await assert.rejects(readiness.suppression(db(flags), 'alarm_test'), /READINESS_REFUSED/, 'EVALUATOR_CONSUMER_SUPPRESSION_SCOPE');
    }
  });
});

describe('actual runtime alarm outbox consumer source composition', function () {
  let mode, owned;
  beforeEach(function () { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); owned = []; });
  afterEach(async function () { await Promise.all(owned.map(lab => lab.close())); scope.setTenancyMode(mode); });
  async function open (send) { const lab = await protocol(send); owned.push(lab); return lab; }
  it('consumes successful role outputs with committed intent before handoff and normal RT repeats', async function () {
    const l = await open(); await l.start();
    assert.equal(l.effects.length, 2, 'EVALUATOR_CONSUMER_ACTUAL_PATH both tenant outputs consumed');
    for (const request of l.effects) assert.equal(l.files.get(request.tenant).snapshot().requests[0].state, 'accepted');
    await l.consumers.wake(l.A); assert.equal(l.effects.length, 2, 'same output once');
    await l.runtime.tick(l.A); await l.consumers.wake(l.A);
    assert.equal(l.effects.length, 3, 'EVALUATOR_CONSUMER_RT_POLICY later cycle repeats existing alarm');
    assert.notEqual(l.effects[0].id, l.effects.at(-1).id);
    assert.equal(l.consumers.health().tenants.find(row => row.tenant === l.A).state, 'handoff-accepted');
  });
  it('polls actual runtime timer outputs and retries uncertain same IDs without coupling delivery to clinical progress', async function () {
    let failing = true;
    const l = await open((request, callback) => callback(failing ? new Error('controlled sink absent') : null, { accepted: true }));
    await l.start(); const ids = l.effects.map(row => row.id);
    assert.ok(l.consumers.health().tenants.every(row => row.state === 'pending'));
    failing = false; l.advance(1); l.consumerTimers[1].fn();
    await Promise.all([l.consumers.flush(l.A), l.consumers.flush(l.B)]);
    assert.equal(l.effects.length, 4, 'EVALUATOR_CONSUMER_RETRY_TIMER persisted attempts retried');
    assert.deepEqual(new Set(l.effects.slice(2).map(row => row.id)), new Set(ids));
    await l.runtime.tick(l.A); l.consumerTimers[0].fn(); await Promise.all([l.consumers.flush(l.A), l.consumers.flush(l.B)]);
    assert.equal(l.effects.length, 5, 'EVALUATOR_CONSUMER_OUTPUT_POLL timer output actually consumed');
  });
  it('defers failed clinical/config cycles and newly snoozed pending work without stopping the other tenant', async function () {
    const l = await open((request, callback) => callback(new Error('uncertain sink'))); await l.start();
    const a = l.files.get(l.A).snapshot(), b = l.files.get(l.B).snapshot();
    l.refusal.add(l.A); await l.runtime.acquire(l.A); await l.consumers.wake(l.A);
    assert.deepEqual(l.files.get(l.A).snapshot(), a, 'failed clinical cycle cannot enqueue');
    await l.runtime.tick(l.B); await l.consumers.wake(l.B); assert.equal(l.files.get(l.B).snapshot().requests.length, b.requests.length + 1);
    l.refusal.delete(l.A); await l.runtime.acquire(l.A);
    await l.alarm.writer.ack(l.alarm.operation(1, 'default', 1000, l.A));
    const effects = l.effects.length; l.advance(1); await l.consumers.retry(l.A);
    const afterAck = l.effects.slice(effects);
    assert.equal(afterAck.length, 1);
    assert.deepEqual(afterAck[0].notification, {clear: true, title: 'All Clear', message: "default - Warning was ack'd", group: 'default'});
    assert.ok(l.files.get(l.A).snapshot().requests.filter(row => !row.payload.clear).every(row => row.state === 'cancelled'),
      'EVALUATOR_CONSUMER_CURRENT_SNOOZE queued ALARM retry suppressed');
    l.configs.delete(l.B); await l.runtime.acquire(l.B); await l.consumers.retry(l.B);
    assert.equal(l.effects.length, effects + 1); assert.equal(l.consumers.health().tenants.find(row => row.tenant === l.B).clinicalEligible, false);
  });
  it('aborts owned delivery waits on close while clinical scheduling and results remain independent', async function () {
    let enter, complete, signal;
    const entered = new Promise(resolve => { enter = resolve; });
    const l = await open((request, callback) => { if (request.tenant === l.A) { signal = request.signal; complete = callback; enter(); } else callback(null, { accepted: true }); });
    l.consumers.start(); await entered;
    const before = l.runtime.last(l.A).outputRevision; await l.runtime.tick(l.A);
    assert.ok(l.runtime.last(l.A).outputRevision > before, 'clinical cycle does not wait for delivery');
    const closing = l.consumers.close();
    try { assert.equal(signal.aborted, true, 'EVALUATOR_CONSUMER_ABORT_OWNED_WAIT'); }
    finally { complete(new Error('fixture release')); await closing; }
    const stored = l.files.get(l.A).snapshot(); complete(null, { accepted: true }); await Promise.resolve();
    assert.deepEqual(l.files.get(l.A).snapshot(), stored); assert.equal(l.cancelled.filter(timer => l.consumerTimers.includes(timer)).length, 2);
  });
});

describe('selected evaluator role consumes notification composition', function () {
  it('boots starts and wakes the actual selected composition without awaiting handoff latency and closes all owned resources', async function () {
    const vm = require('node:vm'), { createRequire } = require('node:module');
    const filename = path.resolve(__dirname, '../lib/server/serve/evaluator-preview.js'), local = createRequire(filename);
    const calls = []; let release;
    const held = new Promise(resolve => { release = resolve; });
    const clinical = { end: async () => { calls.push('clinical-end'); } };
    const consumer = { start () { calls.push('consumer-start'); }, wake () { calls.push('consumer-wake'); return held; },
      retry () {}, flush () {}, health: () => ({ enabled: true }), async close () { calls.push('consumer-close'); release(); } };
    const runtime = { acquire: async () => { calls.push('clinical-acquire'); }, tick: async () => {},
      last: () => null, isCurrent: async () => true, health: () => ({ tenants: [] }), close: async () => { calls.push('clinical-close'); } };
    const sandbox = { module: { exports: {} }, console: { log () {} }, require (name) {
      if (name === '../../storage/postgres-connection') return async () => clinical;
      if (name === './evaluator-readiness') return Object.assign(async () => { calls.push('clinical-readiness'); }, {provisionTenant: async () => {}});
      if (name === './evaluator-runtime') return async () => { calls.push('clinical-start'); return runtime; };
      if (name === './evaluator-consumers') return { async prepare (input) {
        assert.equal(input.clinicalConnection, clinical); calls.push('consumer-prepare'); return consumer;
      } };
      return local(name);
    } };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    const previous = scope.getTenancyMode();
    const cfg = { ...document(), namespaces: document().postgres.namespaces, tenants: new Map([[A, true]]), consumers: selected() };
    let role;
    try {
      role = await sandbox.module.exports.boot(cfg);
      assert.deepEqual(calls.slice(0, 4), ['clinical-readiness', 'consumer-prepare', 'clinical-start', 'consumer-start'], 'EVALUATOR_CONSUMER_SELECTED_BOOT');
      await role.acquire(A); assert.equal(calls.at(-1), 'consumer-wake', 'clinical promise completed without awaiting held handoff');
      assert.equal(role.health().consumers.enabled, true);
      await role.close(); await role.close();
      assert.equal(calls.filter(name => name === 'consumer-close').length, 1);
      assert.equal(calls.filter(name => name === 'clinical-end').length, 1);
      assert.ok(calls.indexOf('consumer-close') < calls.indexOf('clinical-close'));
    } finally { release(); if (role) await role.close(); scope.setTenancyMode(previous); }
  });
});
