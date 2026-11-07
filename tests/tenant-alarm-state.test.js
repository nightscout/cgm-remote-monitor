'use strict';

const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const protocol = require('./fixtures/tenant-alarm-protocol');
const c = require('../lib/tenant-alarms/contract');
const { createWriter, createReader } = require('../lib/tenant-alarms/postgres');
const { validateCatalogue } = require('../lib/migrations/catalogue');

describe('durable tenant alarm state source protocol', function () {
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));
  it('requires explicit transaction authority, narrow namespace and bounded reader', function () {
    assert.throws(() => createWriter(), TypeError);
    const f = protocol();
    assert.throws(() => createWriter({ connection: f.db, namespace: 'safe' }), /authority/);
    assert.throws(() => createReader({ connection: f.db, namespace: 'public', maxRows: 1, maxBytes: 100 }), /NAMESPACE/);
    assert.throws(() => createReader({ connection: f.db, namespace: 'safe' }), /bounds/);
    const candidate = require('../migrations/candidates/postgres-alarm-suppression-v1.json');
    assert.equal(validateCatalogue(candidate).length, 1);
    assert.ok(candidate.migrations[0].up.some(sql => sql.includes('FORCE ROW LEVEL SECURITY')), 'ALARM_CANDIDATE_FORCED_RLS required');
    assert.ok(candidate.migrations[0].up.some(sql => sql.includes('WITH CHECK')));
    assert.equal(candidate.migrations[0].up.some(sql => /GRANT|TRIGGER/i.test(sql)), false);
  });
  it('persists original expiry and ignores an active repeat across fresh writer handles', async function () {
    const f = protocol(), op = f.operation();
    const first = await f.writer.ack(op), expiry = first.rows[0].expiresAt;
    f.now += 100;
    const fresh = createWriter({ connection: f.db, namespace: 'alarm_protocol', authorizeInTransaction: async () => true });
    const repeated = await fresh.ack({ ...op, args: [1, 'default', 10000] });
    assert.equal(repeated.accepted, false, 'ALARM_REPEAT_NO_SLIDE active repeat is ignored');
    assert.equal(repeated.rows[0].expiresAt, expiry, 'ALARM_RESTART_ORIGINAL_EXPIRY restart retains absolute expiry');
    assert.equal(f.rows()[0].expires_at, String(expiry));
    f.now = expiry;
    const renewed = await fresh.ack(op);
    assert.equal(renewed.accepted, true, 'legacy ack repeat guard is strict < at expiry');
    assert.equal(renewed.rows[0].expiresAt, expiry + 1000);
  });
  it('serializes concurrent repeats without sliding the first accepted window', async function () {
    const f = protocol(), first = f.now;
    const results = await Promise.all([f.writer.ack(f.operation()), f.writer.ack(f.operation(1, 'default', 10000))]);
    assert.deepEqual(results.map(result => result.accepted), [true, false], 'ALARM_CONCURRENT_NO_SLIDE only the first window is accepted');
    assert.equal(f.rows()[0].expires_at, String(first + 1000));
  });
  it('applies level2 to level1 atomically while preserving already-active lower-level expiry', async function () {
    const f = protocol();
    const warn = await f.writer.ack(f.operation(1, 'pump', 5000)); f.now += 10;
    const urgent = await f.writer.ack(f.operation(2, 'pump', 1000));
    assert.deepEqual(urgent.rows.map(row => row.level), [2, 1], 'ALARM_LEVEL_CASCADE urgent suppression includes warning');
    assert.equal(urgent.rows[1].expiresAt, warn.rows[0].expiresAt);
    const urgentExpiry = urgent.rows[0].expiresAt;
    f.now += 100;
    assert.equal((await f.writer.ack(f.operation(2, 'pump', 10000))).accepted, false);
    assert.equal(f.rows().find(row => row.alarm_level === 2).expires_at, String(urgentExpiry));
    const g = protocol(); g.failCommit = true;
    await assert.rejects(g.writer.ack(g.operation(2)), /COMMIT_REFUSAL/);
    assert.deepEqual(g.rows(), [], 'both suppression rows roll back together');
  });
  it('keeps tenant/group state isolated and refuses foreign scope before SQL', async function () {
    const f = protocol();
    await f.writer.ack(f.operation(1, 'same', 1000));
    await f.writer.ack(f.operation(2, 'same', 2000, f.B));
    const a = await f.reader.read({ tenant: f.A, at: f.now });
    assert.deepEqual(a.map(row => [row.tenant, row.level]), [[f.A, 1]], 'ALARM_TENANT_ISOLATION no foreign suppression');
    const calls = f.calls.length;
    await assert.rejects(scope.withTenant(f.B, () => f.writer.ack(f.operation())), /TENANT_MISMATCH/);
    assert.equal(f.calls.length, calls);
  });
  it('defaults omitted/null/zero duration and refuses malformed or overflowing arithmetic', async function () {
    for (const time of [undefined, null, 0]) assert.equal(c.args([1, 'default', time]).duration, 1800000);
    for (const args of [[0, 'default', 1], [1, '', 1], [1, 'x', -1], [1, 'x', '10'], [1, 'x', Infinity], [1, 'x', false]]) assert.throws(() => c.args(args), /INVALID/);
    const f = protocol(); f.now = c.LIMIT - 10;
    await assert.rejects(f.writer.ack(f.operation()), /TIME_INVALID/);
    assert.deepEqual(f.rows(), []);
    assert.throws(() => c.row({ tenant_id: f.A, alarm_group: 'x', alarm_level: 1, acked_at: null, expires_at: 10 }, f.A), /INVALID/);
  });
  it('refuses current authority inside the transaction before persistence', async function () {
    const f = protocol(); f.allowed = false;
    await assert.rejects(f.writer.ack(f.operation()), /AUTHORITY_REFUSED/);
    assert.deepEqual(f.rows(), []);
    assert.equal(f.calls.some(call => call.text?.startsWith('INSERT')), false);
  });
  it('enforces row and byte bounds without returning partial suppression', async function () {
    const f = protocol(); await f.writer.ack(f.operation(2));
    const rowReader = createReader({ connection: f.db, namespace: 'alarm_protocol', maxRows: 1, maxBytes: 10000 });
    await assert.rejects(rowReader.read({ tenant: f.A, at: f.now }), /READ_ROW_BOUND/);
    const byteReader = createReader({ connection: f.db, namespace: 'alarm_protocol', maxRows: 10, maxBytes: 1 });
    await assert.rejects(byteReader.read({ tenant: f.A, at: f.now }), /READ_BYTE_BOUND/);
  });
});
