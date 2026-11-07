'use strict';

const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const protocol = require('./fixtures/tenant-alarm-protocol');
const createCycle = require('../lib/tenant-alarms/cycle');
const evaluator = require('../lib/data/tenant-projection-evaluator');
const createNotifications = require('../lib/notifications');
const { EventEmitter } = require('node:events');
const { createReceiver } = require('../lib/tenant-alarms/composition');
function frame (tenant, at, emitted) { return { result: { tenant, now: at, checkpoint: 7, emitted, requested: [], properties: {} },
  identity: 'synthetic-config-v1', runtimeId: 'synthetic-runtime', outputRevision: 1, inputCheckpoint: 7, eligible: true }; }

describe('durable alarm API and successful-cycle composition', function () {
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));
  it('requires explicit transport/current-socket and transaction admission adapters', function () {
    const f = protocol();
    assert.throws(() => createReceiver({ connection: f.db, namespace: 'alarm_protocol' }), /authority adapters/);
  });
  it('wires actual forwarding and API persistence with no acknowledgement before COMMIT', async function () {
    const f = protocol(); let release, replies = 0;
    f.holdCommit = new Promise(resolve => { release = resolve; });
    const pending = f.forwarder.forward({ namespace: '/alarm', event: 'ack', args: [2, 'default', 1000], acknowledge: () => { replies++; } });
    for (let i = 0; i < 30 && !f.calls.some(call => call.text?.startsWith('INSERT')); i++) await Promise.resolve();
    assert.equal(replies, 0, 'ALARM_COMMIT_BEFORE_ACK no precommit reply');
    assert.deepEqual(f.rows(), [], 'uncommitted state is not externally visible');
    release();
    assert.equal((await pending).delivered, true);
    assert.equal(replies, 1);
    assert.equal(f.rows().length, 2);
    assert.ok(f.calls.indexOf('AUTHORITY_IN_TRANSACTION') < f.calls.indexOf('COMMIT'));
  });
  it('keeps failed COMMIT and revoked/current socket authority as no-ack failures', async function () {
    const f = protocol(); let replies = 0;
    const input = { namespace: '/alarm', event: 'ack', args: [1, 'default'], acknowledge: () => { replies++; } };
    f.failCommit = true;
    assert.equal((await f.forwarder.forward(input)).delivered, false);
    assert.equal(replies, 0, 'ALARM_FAILED_COMMIT_NO_ACK failed durable write cannot acknowledge');
    assert.deepEqual(f.rows(), []);
    f.failCommit = false; f.allowed = false;
    assert.equal((await f.forwarder.forward(input)).delivered, false);
    assert.equal(replies, 0);
    f.allowed = true;
    assert.equal((await f.forwarder.forward(input)).delivered, true);
    f.allowed = false;
    assert.equal((await f.forwarder.forward(input)).delivered, false, 'ALARM_CURRENT_AUTHORITY no retained socket grant');
    assert.equal(replies, 1);
  });
  it('rechecks admission inside persistence after an earlier socket credential check', async function () {
    const f = protocol(); let current = true, admitted = 0;
    const receive = createReceiver({ connection: f.db, namespace: 'alarm_protocol', authenticateTransport: async () => true,
      resolveTenant: async () => f.A, authorizeSocket: async () => { admitted++; current = false; return { tenant: f.A }; },
      authorizeAckInTransaction: async ({ credential, connection }) => { assert.deepEqual(credential, { id: 'original' }); assert.equal(connection, f.db); return current; },
      executeWrite: async () => [] });
    await assert.rejects(receive({}, { tenant: f.A, credential: { id: 'original' }, namespace: '/alarm', event: 'ack', args: [1, 'default'] }),
      /SOCKET_FORWARD_UNAVAILABLE/, 'ALARM_CURRENT_AUTHORITY revoked between outer admission and write is refused');
    assert.equal(admitted, 1); assert.deepEqual(f.rows(), []);
  });
  it('consumes durable tenant suppression while preserving info, announcement, clear and other groups', async function () {
    const f = protocol(); await f.writer.ack(f.operation(2));
    const emitted = [{ level: 2, group: 'default' }, { level: 1, group: 'default' }, { level: 1, group: 'other' },
      { level: 0, group: 'default' }, { level: 1, group: 'default', isAnnouncement: true }, { clear: true, group: 'default' }];
    const source = frame(f.A, f.now, emitted), cycle = f.createCycle(() => source);
    const selected = await cycle.select(f.A);
    assert.deepEqual(selected.result.emitted, emitted.slice(2), 'ALARM_SUPPRESSION_CONSUMED persisted urgent/warn state filters actual output');
    assert.equal(source.result.emitted.length, 6, 'caller successful result remains unchanged');
    assert.equal(selected.inputCheckpoint, source.result.checkpoint, 'suppression does not advance clinical progress');
    const b = frame(f.B, f.now, emitted), foreign = f.createCycle(() => b);
    assert.deepEqual((await foreign.select(f.B)).result.emitted, emitted);
  });
  it('preserves legacy equality boundary: repeat allowed at expiry, emission resumes strictly after', async function () {
    const f = protocol(); const expiry = (await f.writer.ack(f.operation())).rows[0].expiresAt;
    let source = frame(f.A, expiry, [{ level: 1, group: 'default' }]);
    const cycle = f.createCycle(() => source);
    assert.deepEqual((await cycle.select(f.A)).result.emitted, [], 'ALARM_EXPIRY_BOUNDARY at-expiry remains silent');
    source = frame(f.A, expiry + 1, source.result.emitted);
    assert.equal((await cycle.select(f.A)).result.emitted.length, 1);
    // Independently characterize current single-tenant notification code.
    const oldNow = Date.now, bus = new EventEmitter(), observed = [];
    const data = { lastUpdated: expiry }; bus.on('notification', value => observed.push(value));
    Date.now = () => expiry - 1000;
    const notifications = createNotifications({}, { levels: { WARN: 1, URGENT: 2, INFO: 0, toDisplay: String }, bus, ddata: data });
    try {
      notifications.ack(1, 'default', 1000);
      notifications.requestNotify({ level: 1, group: 'default', title: 'synthetic', message: 'synthetic', plugin: {} });
      notifications.process(); assert.equal(observed.length, 0, 'legacy exact expiry remains silent');
      data.lastUpdated++; notifications.process(); assert.equal(observed.length, 1, 'legacy immediately after emits');
    } finally { Date.now = oldNow; bus.emit('teardown'); }
  });
  it('fails closed on reader failure, closed consumer and superseded successful/config identity', async function () {
    const f = protocol(); let source = frame(f.A, f.now, [{ level: 1, group: 'default' }]);
    const cycle = f.createCycle(() => source); f.failRead = true;
    await assert.rejects(cycle.select(f.A), /SUPPRESSION_READ_FAILURE/);
    f.failRead = false; let release;
    f.holdRead = new Promise(resolve => { release = resolve; });
    const pending = cycle.select(f.A); await Promise.resolve();
    source = { ...source, identity: 'config-new' }; release();
    await assert.rejects(pending, /CYCLE_CHANGED/, 'ALARM_STALE_CYCLE no output after config replacement');
    f.holdRead = undefined;
    source = null; await assert.rejects(cycle.select(f.A), /NOT_ELIGIBLE/, 'failed clinical cycle has no eligible output');
    source = frame(f.A, f.now, []); let finish;
    f.holdRead = new Promise(resolve => { finish = resolve; }); const closing = cycle.select(f.A);
    cycle.close(); finish();
    await assert.rejects(closing, /CYCLE_CLOSED/, 'ALARM_CLOSED_NO_OUTPUT close fences in-flight read');
  });
  it('filters actual successful evaluator plugin output, never calling a provider', async function () {
    const f = protocol(); const at = Date.UTC(2026, 10, 6, 12);
    const environment = require('../lib/server/tenant-app/environment');
    const env = environment({ settings: { enable: ['bgnow', 'simplealarms'], thresholds: { bgHigh: 200, bgTargetTop: 180, bgTargetBottom: 80, bgLow: 55 } } });
    const docs = [{ _id: 'synthetic-high', type: 'sgv', sgv: 250, date: at - 60000 }];
    const v = evaluator({ tenant: f.A, env, language: require('../lib/language')(), dbstats: async () => ({ dataSize: 0, indexSize: 0 }),
      replay: { reconcile: async () => ({ checkpoint: 7, rows: docs.map(document => ({ domain: 'entries', document })) }) },
      connection: { query: async (text, values) => {
        const source = values.find(value => typeof value === 'string' && value.startsWith('[{'));
        return { rows: source ? JSON.parse(source) : [] };
      } }, maxRows: 10, maxBytes: 10000 });
    const successful = await v.evaluate({ at });
    assert.ok(successful.emitted.some(value => value.level === 1 || value.level === 2), 'ALARM_ACTUAL_EVALUATOR actual plugin produces alarm');
    f.now = at; await f.writer.ack(f.operation(2, 'default', 1000));
    const current = { ...frame(f.A, at, []), result: successful, identity: 'clinical-config' };
    const filtered = await f.createCycle(() => current).select(f.A);
    assert.equal(filtered.result.emitted.filter(value => [1, 2].includes(value.level)).length, 0, 'ALARM_ACTUAL_EVALUATOR_SUPPRESSED actual emitted alarms consumed');
    assert.equal(v.last(), successful); v.close();
  });
  it('rechecks fresh suppression at each retry instant and refuses a stale identity', async function () {
    const f = protocol(), notify = { level: 1, group: 'default' };
    assert.equal(await f.reader.allows({ tenant: f.A, notification: notify, at: f.now }), true);
    const accepted = await f.writer.ack(f.operation());
    assert.equal(await f.reader.allows({ tenant: f.A, notification: notify, at: f.now }), false, 'ALARM_RETRY_RECHECK fresh snooze blocks queued attempt');
    assert.equal(await f.reader.allows({ tenant: f.A, notification: notify, at: accepted.rows[0].expiresAt + 1 }), true);
    f.failRead = true;
    await assert.rejects(f.reader.allows({ tenant: f.A, notification: notify, at: f.now }), /READ_FAILURE/);
    const source = frame(f.A, f.now, [notify]);
    const gated = createCycle({ current: () => source, isCurrent: async () => false, reader: { read: async () => [] } });
    await assert.rejects(gated.select(f.A), /CYCLE_CHANGED/, 'ALARM_CURRENT_CONFIG reread identity before eligible output');
  });
  it('rejects foreign or malformed stored suppression before producing output', async function () {
    const f = protocol(); const source = frame(f.A, f.now, []);
    const cycle = createCycle({ current: () => source, isCurrent: async () => true, reader: { read: async () => [{ tenant: f.B }] } });
    await assert.rejects(cycle.select(f.A), /STORED_STATE_INVALID/);
  });
});
