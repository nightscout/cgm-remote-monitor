'use strict';

const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const fixture = require('./fixtures/tenant-notifications');
const { notification } = fixture;
const contract = require('../lib/tenant-notifications/contract');
const component = require('../lib/tenant-notifications/component');
const { validateCatalogue } = require('../lib/migrations/catalogue');

describe('durable tenant notification source protocol', function () {
  let mode, f, owned;
  beforeEach(function () { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); f = fixture(); owned = []; });
  afterEach(async function () { await Promise.all(owned.map(c => c.close())); scope.setTenancyMode(mode); });
  const open = overrides => { const c = f.component(overrides); owned.push(c); return c; };

  it('commits durable request and attempt before composed adapter dispatch and reuses accepted admission', async function () {
    f.setCycle([notification()]);
    const c = open(); const result = await c.run(f.A);
    assert.ok(f.observedAttempts.every(row => row.storedState === 'attempting' && !row.inTransaction), 'NOTIFICATION_DURABLE_BEFORE_EFFECT');
    assert.equal(result.results[0].state, 'accepted'); assert.equal(f.effects.length, 1);
    const stored = f.snapshot().requests[0]; assert.equal(stored.state, 'accepted'); assert.equal(stored.attempt, 1);
    f.setCycle([notification()]); await c.run(f.A);
    assert.equal(f.effects.length, 1, 'normal accepted window suppresses new output');
    assert.equal(f.snapshot().requests.length, 1);
  });

  it('retains one logical identity across uncertain callback and component restart; rearms after accepted window', async function () {
    f.setCycle([notification()]); let sends = 0;
    const send = (row, callback) => { f.effects.push(row); sends++; callback(sends === 1 ? new Error('synthetic uncertain result') : null, { accepted: true }); };
    const first = open({ adapter: { id: 'synthetic', send } }); await first.run(f.A);
    const id = f.snapshot().requests[0].request_id; assert.equal(f.snapshot().requests[0].state, 'uncertain');
    await first.retry(f.A); assert.equal(f.effects.length, 1, 'legacy short window not extended by retry call');
    f.advance(30001); await first.close();
    f.setCycle([notification()], { runtimeId: 'new-runtime' });
    const second = open({ adapter: { id: 'synthetic', send } }); await second.run(f.A);
    assert.equal(f.effects.length, 2); assert.equal(f.effects[1].id, id, 'NOTIFICATION_RETRY_IDENTITY persisted request reused');
    assert.equal(f.snapshot().requests.length, 1); assert.equal(f.snapshot().requests[0].state, 'accepted');
    f.advance(899999); f.setCycle([notification()]); await second.run(f.A); assert.equal(f.effects.length, 2);
    f.advance(1); f.setCycle([notification()]); await second.run(f.A); assert.equal(f.effects.length, 2, 'exact success expiry is still cached');
    f.advance(1); f.setCycle([notification()]); await second.run(f.A);
    assert.equal(f.effects.length, 3); assert.notEqual(f.effects[2].id, id, 'legitimate rearmed alarm is a new logical request');
  });

  it('does not dispatch before failed enqueue COMMIT and never marks acceptance on failure', async function () {
    f.setCycle([notification()]); f.failCommit();
    await assert.rejects(open().run(f.A), /SYNTHETIC_COMMIT_FAILURE/);
    assert.equal(f.effects.length, 0, 'NOTIFICATION_COMMIT_FAILURE_NO_EFFECT'); assert.equal(f.snapshot().requests.length, 0);
    f.failCommit(false);
    await open({ adapter: { id: 'synthetic', send (row, callback) { callback(new Error('failed')); } } }).run(f.A);
    assert.equal(f.snapshot().requests[0].state, 'uncertain', 'NOTIFICATION_FAILED_SEND_NOT_ACCEPTED');
  });

  it('rechecks current suppression and condition before retries; cannot replay a cleared alarm', async function () {
    f.setCycle([notification()]);
    const c = open({ adapter: { id: 'synthetic', send (row, callback) { f.effects.push(row); callback(new Error('uncertain')); } } });
    await c.run(f.A); f.advance(30001); f.suppressed(); await c.retry(f.A);
    assert.equal(f.effects.length, 1, 'NOTIFICATION_SNOOZED_RETRY_NO_EFFECT'); assert.equal(f.snapshot().requests[0].state, 'cancelled');
    f.suppressed(false); f.setCycle([notification({ level: 2 })]); await c.run(f.A);
    f.advance(30001); f.setCycle([]); await c.retry(f.A);
    assert.equal(f.effects.length, 2, 'NOTIFICATION_CLEARED_CONDITION_NO_STALE_RETRY');
    assert.ok(f.snapshot().requests.every(row => row.state === 'cancelled'));
  });

  it('refuses unavailable cycles, current-config failure and suppression read failure without fallback', async function () {
    f.setCycle([notification()], { eligible: false }); await assert.rejects(open().run(f.A), /CYCLE_UNAVAILABLE/);
    f.setCycle([notification()], { eligible: true }); f.configCurrent(false);
    assert.equal((await open().run(f.A)).results[0].state, 'ineligible');
    f.configCurrent(true); f.gateError(new Error('synthetic suppression unavailable'));
    await assert.rejects(open().run(f.A), /suppression unavailable/);
    assert.equal(f.effects.length, 0); assert.equal(f.snapshot().requests.length, 0);
  });

  it('detects config/output change while suppression is read and never enqueues old output', async function () {
    f.setCycle([notification()]); let release; f.holdGate(new Promise(resolve => { release = resolve; }));
    const work = open().run(f.A); await new Promise(resolve => setImmediate(resolve));
    f.setCycle([notification()], { identity: 'config-two' }); release(); await work;
    assert.equal(f.snapshot().requests.length, 0, 'NOTIFICATION_CURRENT_CYCLE_AFTER_GATE'); assert.equal(f.effects.length, 0);
  });

  it('fences callback timeout, close, restart and superseded attempt tokens', async function () {
    f.setCycle([notification()]); const callbacks = [];
    const first = open({ adapter: { id: 'synthetic', send (row, callback) { callbacks.push(callback); } }, attemptTimeoutMs: 5 });
    await first.run(f.A); assert.equal(f.snapshot().requests[0].state, 'uncertain');
    f.advance(30001); const second = open({ adapter: { id: 'synthetic', send (row, callback) { callbacks.push(callback); } } });
    const pending = second.retry(f.A); await new Promise(resolve => setImmediate(resolve)); await second.close(); await pending;
    const before = f.snapshot(); callbacks.forEach(done => done(null, { accepted: true, receipt: 'late' }));
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(f.snapshot(), before, 'NOTIFICATION_LATE_CALLBACK_FENCE');
    assert.equal(before.requests[0].state, 'attempting', 'NOTIFICATION_CLOSED_ATTEMPT_REMAINS_RECOVERABLE');
    f.advance(31); const third = open(); await third.retry(f.A);
    assert.equal(f.snapshot().requests[0].state, 'attempting', 'restart cannot bypass the active normal retry window');
    f.advance(30001); await third.retry(f.A);
    assert.equal(f.snapshot().requests[0].state, 'accepted');
    const stale = await scope.withTenant(f.A, () => f.store.finish({ tenant: f.A, id: before.requests[0].request_id,
      token: before.requests[0].attempt_token, state: 'uncertain', at: f.now(), nextAt: f.now(), receipt: null, cleared: [] }));
    assert.equal(stale, false); assert.equal(f.snapshot().requests[0].state, 'accepted');
  });

  it('preserves clear events without alarm fields and supplies persisted receipt references', async function () {
    const c = open({ adapter: { id: 'synthetic', send (row, callback) {
      f.effects.push(row); callback(null, { accepted: true, receipt: row.notification.clear ? null : 'persisted-receipt',
        clearedRequestIds: row.notification.clear ? row.receipts.map(receipt => receipt.request_id) : [] });
    } } });
    f.setCycle([notification()]); await c.run(f.A); const alarmId = f.snapshot().requests[0].request_id;
    f.setCycle([{ clear: true, title: 'All Clear', message: 'Synthetic clear', group: 'default' }]); await c.run(f.A);
    assert.equal(f.effects.length, 2); assert.equal(f.effects[1].notification.clear, true);
    assert.deepEqual(f.effects[1].receipts, [{ request_id: alarmId, receipt: 'persisted-receipt' }]);
    assert.equal(f.snapshot().requests[0].cleared_at, f.now());
    await c.run(f.A); assert.equal(f.effects.length, 2, 'same clear output instance is not newly admitted');
    f.setCycle([{ clear: true, title: 'All Clear', message: 'Synthetic clear', group: 'default' }]); await c.run(f.A);
    assert.equal(f.effects.length, 3, 'new clear output bypasses normal alarm dedup');
  });

  it('passes all tenant consumer receipts across groups to clear while retaining other consumer references', async function () {
    const c = open(); f.setCycle([notification()]); await c.run(f.A);
    f.setCycle([notification({ group: 'another', plugin: { name: 'another' } })]); await c.run(f.A);
    await open({ adapter: { id: 'other', send (row, callback) { callback(null, { accepted: true, receipt: 'other-receipt' }); } } }).run(f.A);
    let received;
    const clear = open({ adapter: { id: 'synthetic', send (row, callback) {
      received = row.receipts; callback(null, { accepted: true, clearedRequestIds: row.receipts.map(item => item.request_id) });
    } } });
    f.setCycle([{ clear: true, title: 'All Clear', message: 'Synthetic' }]); await clear.run(f.A);
    assert.equal(received.length, 2, 'clear retains existing all-group consumer scope');
    const other = f.snapshot().requests.find(row => row.consumer === 'other');
    assert.equal(other.cleared_at, undefined, 'clear never releases another consumer receipt');
  });

  it('keeps consumer/config/tenant admissions separate and refuses foreign retry rows', async function () {
    f.setCycle([notification()]); await open().run(f.A);
    await open({ adapter: { id: 'other', send (row, callback) { f.effects.push(row); callback(null, { accepted: true }); } } }).run(f.A);
    f.setCycle([notification()], { identity: 'config-two' }); await open().run(f.A);
    assert.equal(f.snapshot().requests.length, 3);
    const foreign = { ...f.snapshot().requests[0], tenant_id: f.B };
    await assert.rejects(open({ store: { ...f.store, due: async () => [foreign] } }).retry(f.A), /TENANT_MISMATCH/);
    assert.equal(f.effects.length, 3);
    await assert.rejects(scope.withTenant(f.A, () => f.store.due({ tenant: f.B, consumer: 'synthetic', at: f.now() })), /TENANT_MISMATCH/);
  });

  it('matches frozen pushnotify normal keys, announcement precedence and explicit payload/batch bounds', async function () {
    const a = contract.notification(notification(), 10000);
    assert.equal(contract.key(a), 'synthetic_1'); assert.equal(contract.key({ ...a, group: 'another' }), 'synthetic_1');
    assert.notEqual(contract.key({ ...a, isAnnouncement: true }), contract.key(a));
    assert.equal(contract.key({ ...a, isAnnouncement: true }), contract.key({ ...a, level: 0 }));
    assert.equal(contract.key({ ...a, notifyhash: 'explicit' }), 'explicit');
    assert.throws(() => contract.notification(notification(), 1), /PAYLOAD_BOUND/);
    assert.throws(() => component(), /capabilities/);
    f.setCycle(Array.from({ length: 11 }, () => notification())); await assert.rejects(open().run(f.A), /CYCLE_UNAVAILABLE/);
  });

  it('keeps immutable SAME-payload retries across runtime and diagnostic changes', async function () {
    const original = notification({ eventName: 'low', message: 'Synthetic first reading' });
    const effects = [];
    const c = open({ adapter: { id: 'synthetic', send (row, callback) {
      effects.push(row); callback(effects.length === 1 ? new Error('uncertain') : null, { accepted: true });
    } } });
    f.setCycle([original]); await c.run(f.A); const id = f.snapshot().requests[0].request_id;
    f.advance(30001); f.setCycle([{ ...original, debug: { lastSGV: 55, now: f.now() } }], { runtimeId: 'different-runtime' }); await c.retry(f.A);
    assert.equal(effects.length, 2); assert.equal(effects[1].id, id);
    assert.equal(effects[1].notification.message, original.message, 'same named-condition retry never rewrites original payload');
    const first = contract.notification(notification(), 10000);
    assert.equal(contract.sameEffect(first, { ...first, message: 'Changed unnamed condition' }), false,
      'unnamed message changes require conservative new admission rather than guessing a condition');
    assert.equal(contract.sameEffect({ ...first, eventName: 'low' }, { ...first, eventName: 'low', eventType: 'another' }), false);
  });

  it('retires obsolete in-flight effects without allowing their late completion to update a new head', async function () {
    f.setCycle([notification({ eventName: 'low', message: 'Synthetic LOW 60' })]);
    let complete, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const first = open({ attemptTimeoutMs: 60000, adapter: { id: 'synthetic', send (row, callback) { complete = callback; entered(); } } });
    const oldWork = first.run(f.A); await started;
    const old = f.snapshot().requests[0];
    f.advance(30001); f.setCycle([notification({ eventName: 'low', message: 'Synthetic LOW 55' })]);
    const second = open(); await second.run(f.A);
    const before = f.snapshot(); complete(null, { accepted: true, receipt: 'late-old' });
    const finished = await oldWork;
    assert.equal(finished.results[0].state, 'superseded');
    assert.deepEqual(f.snapshot(), before, 'NOTIFICATION_RETIRED_ATTEMPT_FENCE');
    assert.equal(before.requests.find(row => row.request_id === old.request_id).state, 'cancelled');
    assert.equal(before.requests.filter(row => row.state === 'accepted').length, 1);
    assert.notEqual(before.heads[0].request_id, old.request_id);
  });

  it('consumes readiness before every SQL effect and refuses unsafe role RLS grants shape and ledger', async function () {
    f.setCycle([notification()]);
    const cases = [
      { role: { rolsuper: true } }, { role: { rolbypassrls: true } }, { role: { rolcreaterole: true } },
      { role: { owns_schema: true } }, { role: { any_schema_writes: true } }, { role: { database_create: true } },
      { role: { elevated_membership: true } }, { role: { foreign_writes: true } },
      { tables: { tenant_notification_heads: { secured: false } } },
      { tables: { tenant_notification_requests: { owns: true } } },
      { tables: { tenant_notification_requests: { broad_writes: true } } },
      { tables: { tenant_notification_requests: { columns: [] } } },
      { tables: { tenant_notification_requests: { primary_key: ['request_id'] } } },
      { tables: { tenant_notification_requests: { policies: [{ command: '*', roles: [0], permissive: true, using: 'true', check: 'true' }] } } },
      { tables: { schema_migrations: { any_writes: true } } }, { ledger: [] },
      { ledger: [{ name: '0001_tenant_notification_outbox', checksum: 'wrong' }] }
    ];
    for (const unsafe of cases) {
      f.unsafe(unsafe);
      await assert.rejects(open().run(f.A), /NOTIFICATION_SCHEMA_UNSAFE/, 'NOTIFICATION_READINESS_REFUSAL');
      assert.equal(f.snapshot().requests.length, 0, 'unsafe metadata cannot insert a request');
    }
    assert.equal(f.effects.length, 0); f.unsafe();
    const c = open(); await c.run(f.A);
    const queries = f.calls.filter(call => call.sql?.includes('notification-readiness-role')).length;
    f.unsafe({ tables: { tenant_notification_requests: { broad_writes: true } } });
    await assert.rejects(c.retry(f.A), /NOTIFICATION_SCHEMA_UNSAFE/);
    assert.ok(f.calls.filter(call => call.sql?.includes('notification-readiness-role')).length > queries,
      'readiness is consumed again after privilege change, never cached');
  });

  it('declares isolated forced-RLS outbox schema without clinical authority', function () {
    const catalogue = validateCatalogue(require('../lib/tenant-notifications/postgres-candidate.json'));
    const sql = catalogue[0].up.join('\n');
    for (const table of ['tenant_notification_heads', 'tenant_notification_requests']) {
      assert.ok(sql.includes('ALTER TABLE ' + table + ' FORCE ROW LEVEL SECURITY'));
      assert.ok(sql.includes('CREATE POLICY ' + table + '_tenant ON ' + table));
      assert.ok(sql.includes('REVOKE ALL ON ' + table + ' FROM PUBLIC'));
    }
    assert.equal((sql.match(/tenant_id = nullif/g) || []).length, 4);
    assert.equal(/GRANT .* (entries|treatments|access_|tenant_settings)/i.test(sql), false);
  });
});

describe('notification consumer source compatibility', function () {
  it('compares real pushnotify normal key precedence, shared fanout dedup and receipt clear shape', function () {
    const { EventEmitter } = require('node:events');
    const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
    const { createRequire } = require('node:module');
    const filename = path.resolve(__dirname, '../lib/server/pushnotify.js'), local = createRequire(filename);
    const box = { module: { exports: {} }, console: { info () {}, warn () {}, error () {} }, require: local };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), box, { filename });
    const sends = [], maker = [], cancelled = [], bus = new EventEmitter();
    const ctx = { bus, levels: { isAlarm: value => [1, 2].includes(value), toKey: value => String(value) },
      pushover: { send (notify, callback) { sends.push({ key: notify.key, title: notify.title, group: notify.group }); callback(null, JSON.stringify({ receipt: 'synthetic-' + sends.length })); },
        cancelWithReceipt (id, callback) { cancelled.push(id); callback(null); } },
      maker: { sendEvent (event, callback) { maker.push(event); callback(null); }, sendAllClear (notify, callback) { maker.push({ clear: notify.clear }); callback(null, { sent: true }); } } };
    const real = box.module.exports({ settings: { isAlarmEventEnabled: () => true } }, ctx);
    try {
      const rows = [notification(), notification({ group: 'other' }), notification({ isAnnouncement: true }),
        notification({ level: 0, message: 'other message' }), notification({ notifyhash: 'explicit' })];
      rows.forEach(row => real.emitNotification(row));
      assert.deepEqual(sends.map(row => row.key), [contract.key(rows[0]), contract.key(rows[2]), contract.key(rows[3]), contract.key(rows[4])]);
      assert.equal(maker.length, sends.length, 'real selected consumers share normal admission dedup');
      real.emitNotification({ clear: true, title: 'All Clear', message: 'Synthetic clear', group: 'default' });
      assert.equal(cancelled.length, 4, 'actual clear cancels retained receipts without plugin/level');
      assert.equal(maker.at(-1).clear, true); assert.equal(sends.length, 4);
    } finally { bus.emit('teardown'); }
  });
});

describe('actual alarm selector notification composition', function () {
  it('consumes freshly filtered alarm envelopes without confusing stable output tags with result object identity', async function () {
    // Test-only frozen sibling source before the coordinator joins the two owned branches.
    // eslint-disable-next-line security/detect-non-literal-require
    const createAlarmCycle = require(process.env.NS_NOTIFICATION_ALARM_CYCLE || '../lib/tenant-alarms/cycle');
    const mode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    const f = fixture(); f.setCycle([notification()]);
    const current = { ...f.current(), inputCheckpoint: 0,
      result: { ...f.current().result, tenant: f.A, requested: [] } };
    const alarms = createAlarmCycle({ reader: { read: async () => [] }, current: () => current, isCurrent: async () => true });
    const component = f.component({ selectCycle: tenant => alarms.select(tenant) });
    try {
      const one = await alarms.select(f.A), two = await alarms.select(f.A);
      assert.notEqual(one.result, two.result, 'actual alarm selector returns a fresh filtered result');
      assert.equal(one.outputRevision, two.outputRevision);
      const observed = await component.run(f.A);
      assert.equal(f.effects.length, 1, 'NOTIFICATION_ACTUAL_ALARM_COMPOSITION_LIVE');
      assert.equal(observed.results[0].state, 'accepted');
    } finally { await component.close(); alarms.close(); scope.setTenancyMode(mode); }
  });
});

describe('actual simple alarm condition eligibility', function () {
  it('keeps legacy low/high normal dedup but cannot retry an obsolete low effect against a current high alarm', async function () {
    const mode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    const f = fixture(), effects = [];
    const levels = { URGENT: 2, WARN: 1, INFO: 0, isAlarm: level => [1, 2].includes(level), toDisplay: level => level === 2 ? 'Urgent' : 'Warning' };
    const plugin = require('../lib/plugins/simplealarms')({ levels });
    function actual (mgdl) {
      let output;
      plugin.checkNotifications({ time: f.now(), lastSGVEntry: () => ({ mgdl, mills: f.now() }), scaleEntry: row => row.mgdl,
        scaleMgdl: value => value, buildDefaultMessage: () => 'Synthetic reading ' + mgdl,
        settings: { alarmUrgentHigh: true, alarmHigh: true, alarmUrgentLow: true, alarmLow: true,
          thresholds: { bgHigh: 250, bgTargetTop: 180, bgLow: 70, bgTargetBottom: 80 } },
        notifications: { requestNotify: row => { output = row; } } });
      return output;
    }
    const low = actual(60), high = actual(300);
    assert.equal(low.eventName, 'low'); assert.equal(high.eventName, 'high');
    assert.equal(low.level, high.level); assert.equal(contract.key(low), contract.key(high), 'legacy normal admission key stays shared');
    const component = f.component({ adapter: { id: 'synthetic', send (row, callback) {
      effects.push(row); callback(effects.length === 1 ? new Error('synthetic uncertain low') : null, { accepted: true });
    } } });
    try {
      f.setCycle([low]); await component.run(f.A); const lowId = f.snapshot().requests[0].request_id;
      f.advance(29999); f.setCycle([high]); await component.run(f.A); assert.equal(effects.length, 1, 'normal short window is preserved');
      f.advance(1); await component.retry(f.A); assert.equal(effects.length, 1, 'exact failure expiry remains cached');
      f.advance(1); await component.retry(f.A);
      assert.equal(effects.length, 1, 'NOTIFICATION_CONDITION_DISCRIMINATOR obsolete LOW cannot qualify as current HIGH');
      assert.equal(f.snapshot().requests[0].state, 'cancelled');
      await component.run(f.A); assert.equal(effects.length, 2);
      assert.notEqual(effects[1].id, lowId, 'new condition has new admitted identity after normal rearm');
      assert.equal(effects[1].notification.eventName, 'high');
      assert.equal(f.snapshot().requests[0].payload.eventName, 'low', 'old request payload never overwritten');
    } finally { await component.close(); scope.setTenancyMode(mode); }
  });
});

describe('actual notification current payload compatibility', function () {
  it('matches the actual consumer current LOW reading after the failure window rather than retrying stale text', async function () {
    const { EventEmitter } = require('node:events');
    const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
    const { createRequire } = require('node:module');
    const filename = path.resolve(__dirname, '../lib/server/pushnotify.js');
    const box = { module: { exports: {} }, console: { info () {}, warn () {}, error () {} }, require: createRequire(filename) };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), box, { filename });
    const levels = { URGENT: 2, WARN: 1, INFO: 0, isAlarm: level => [1, 2].includes(level), toDisplay: () => 'Urgent' };
    const plugin = require('../lib/plugins/simplealarms')({ levels });
    const f = fixture(), bus = new EventEmitter(), legacy = [], durable = [];
    const originalNow = Date.now, mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); Date.now = f.now;
    const real = box.module.exports({ settings: { isAlarmEventEnabled: () => true } }, { bus, levels,
      pushover: { send (row, callback) { legacy.push(row.message); callback(legacy.length === 1 ? new Error('synthetic uncertain') : null, JSON.stringify({})); } } });
    const component = f.component({ adapter: { id: 'synthetic', send (row, callback) {
      durable.push(row.notification.message); callback(durable.length === 1 ? new Error('synthetic uncertain') : null, { accepted: true });
    } } });
    function actual (mgdl) {
      let emitted;
      plugin.checkNotifications({ time: f.now(), lastSGVEntry: () => ({ mgdl, mills: f.now() }), scaleEntry: row => row.mgdl,
        scaleMgdl: value => value, buildDefaultMessage: () => 'Synthetic reading ' + mgdl,
        settings: { alarmUrgentHigh: true, alarmHigh: true, alarmUrgentLow: true, alarmLow: true,
          thresholds: { bgHigh: 250, bgTargetTop: 180, bgLow: 70, bgTargetBottom: 80 } },
        notifications: { requestNotify: row => { emitted = row; } } });
      return emitted;
    }
    try {
      const low60 = actual(60); real.emitNotification(low60); f.setCycle([low60]); await component.run(f.A);
      f.advance(30001); const low55 = actual(55); real.emitNotification(low55); f.setCycle([low55]); await component.run(f.A);
      assert.deepEqual(durable, legacy, 'NOTIFICATION_CURRENT_PAYLOAD_COMPAT actual same-condition consumer sends current reading');
    } finally { await component.close(); bus.emit('teardown'); Date.now = originalNow; scope.setTenancyMode(mode); }
  });
});

describe('actual notification cache boundary compatibility', function () {
  it('matches actual failure and success consumer calls before at and after cache expiry', async function () {
    const { EventEmitter } = require('node:events');
    const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
    const { createRequire } = require('node:module');
    const filename = path.resolve(__dirname, '../lib/server/pushnotify.js');
    const originalNow = Date.now, mode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    try {
      for (const [failed, ttl] of [[true, 30000], [false, 900000]]) {
        const f = fixture(), legacy = [], durable = [], bus = new EventEmitter(); Date.now = f.now;
        const box = { module: { exports: {} }, console: { info () {}, warn () {}, error () {} }, require: createRequire(filename) };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), box, { filename });
        const real = box.module.exports({ settings: { isAlarmEventEnabled: () => true } }, { bus, levels: { isAlarm: value => [1, 2].includes(value) },
          pushover: { send (row, callback) { legacy.push(row.message); callback(failed ? new Error('synthetic') : null, JSON.stringify({})); } } });
        const c = f.component({ adapter: { id: 'synthetic', send (row, callback) {
          durable.push(row.notification.message); callback(failed ? new Error('synthetic') : null, { accepted: true });
        } } });
        try {
          f.setCycle([notification()]); real.emitNotification(notification()); await c.run(f.A);
          for (const advance of [ttl - 1, 1, 1]) {
            f.advance(advance); f.setCycle([notification()]); real.emitNotification(notification()); await c.run(f.A);
            assert.equal(durable.length, legacy.length, 'NOTIFICATION_NORMAL_CACHE_BOUNDARY exact legacy expiry retained');
          }
          assert.equal(durable.length, 2);
        } finally { await c.close(); bus.emit('teardown'); }
      }
    } finally { Date.now = originalNow; scope.setTenancyMode(mode); }
  });

  it('supplies active persisted receipt references through exact one-hour expiry only', async function () {
    const mode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    const f = fixture(), c = f.component();
    try {
      f.setCycle([notification()]); await c.run(f.A);
      const counts = [];
      for (const step of [3599999, 1, 1]) {
        f.advance(step);
        const rows = await scope.withTenant(f.A, () => f.store.receipts({ tenant: f.A, consumer: 'synthetic', at: f.now() }));
        counts.push(rows.length);
      }
      assert.deepEqual(counts, [1, 1, 0], 'NOTIFICATION_RECEIPT_CACHE_BOUNDARY');
    } finally { await c.close(); scope.setTenancyMode(mode); }
  });
});
