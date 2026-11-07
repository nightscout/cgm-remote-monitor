'use strict';

const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const fixture = require('./fixtures/tenant-alarm-state');
const { optInSuite } = require('./support/opt-in');
function frame (tenant, now, emitted) {
  return { identity: 'synthetic-native-config', runtimeId: 'synthetic-runtime', outputRevision: 1, inputCheckpoint: 0, eligible: true,
    result: { tenant, now, checkpoint: 0, emitted, requested: [], properties: {} } };
}
optInSuite(process.env.NS_TENANT_ALARM_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_TENANT_ALARM_TEST=1 with disposable PostgreSQL')('durable tenant alarm native boundary', function () {
  this.timeout(60000);
  const lab = fixture();
  before(() => lab.open()); beforeEach(() => lab.reset()); after(() => lab.close());
  const trace = (phase, value) => { console.log('TENANT_ALARM_OBSERVATION ' + JSON.stringify({ phase, ...value })); return value; };
  const ack = (forwarder = lab.forwarder(), level = 1, group = 'default', duration = 60000) =>
    forwarder.forward({ namespace: '/alarm', event: 'ack', args: [level, group, duration] });
  it('commits tenant-wide original expiry and consumes suppression after fresh handles', async function () {
    assert.equal((await ack()).delivered, true);
    assert.equal(lab.commits[0].status, 'committed', 'independent actual transaction commit receipt');
    const first = await lab.physical(), bBefore = await lab.physical(lab.B);
    assert.equal((await ack(lab.forwarder(), 1, 'default', 600000)).delivered, true);
    const repeated = await lab.physical();
    const expiry = Number(first[0].expires_at);
    const source = frame(lab.A, expiry, [{ level: 1, group: 'default' }, { level: 1, group: 'other' }, { level: 0 }]);
    const selected = await lab.cycle(() => source).select(lab.A);
    trace('native-repeat-restart', { first, repeated, commits: lab.commits, bBefore, bAfter: await lab.physical(lab.B), selected });
    assert.deepEqual(repeated, first, 'ALARM_NATIVE_REPEAT original absolute expiry is not extended');
    assert.deepEqual(selected.result.emitted, source.result.emitted.slice(1), 'ALARM_NATIVE_CONSUMED persisted silence survives new handle at exact expiry');
    source.result.now = expiry + 1;
    assert.equal((await lab.cycle(() => source).select(lab.A)).result.emitted.length, 3);
    assert.deepEqual(await lab.physical(lab.B), bBefore);
  });
  it('preserves first accepted expiry under concurrent actors and urgent warning cascade', async function () {
    let release, reached; const held = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { reached = resolve; });
    const first = lab.forwarder({ receiver: lab.receiver({ afterUpdate: async () => { reached(); await held; } }) });
    const second = lab.forwarder({ credential: { id: 'owner-a2' } });
    const firstPending = ack(first, 2, 'same', 60000); await ready;
    const secondPending = ack(second, 2, 'same', 600000);
    let lock;
    try { lock = await lab.waitForWriterLock(); } finally { release(); }
    const outcomes = await Promise.all([firstPending, secondPending]);
    const rows = await lab.physical();
    trace('native-concurrent-cascade', { outcomes, rows, lock, commits: lab.commits });
    assert.ok(outcomes.every(value => value.delivered));
    assert.ok(lab.commits.every(value => value.status === 'committed'));
    assert.deepEqual(rows.map(row => row.alarm_level), [1, 2], 'ALARM_NATIVE_CASCADE both levels committed');
    assert.equal(rows[0].acked_at, rows[1].acked_at);
    assert.equal(rows[0].expires_at, rows[1].expires_at);
    assert.equal(Number(rows[1].expires_at) - Number(rows[1].acked_at), 60000, 'ALARM_NATIVE_CONCURRENT first requested window wins');
  });
  it('confirms commit before callback and never acknowledges rolled back or revoked writes', async function () {
    let release, reached; const ready = new Promise(resolve => { reached = resolve; }), held = new Promise(resolve => { release = resolve; });
    const receiver = lab.receiver({ beforeCommit: async () => { reached(); await held; } });
    let callbacks = 0;
    const pending = lab.forwarder({ receiver }).forward({ namespace: '/alarm', event: 'ack', args: [2, 'default', 60000], acknowledge: () => { callbacks++; } });
    await ready; const outside = await lab.physical(); trace('native-before-commit', { outside, callbacks });
    assert.equal(callbacks, 0, 'ALARM_NATIVE_NO_EARLY_ACK before commit'); assert.deepEqual(outside, []);
    release(); assert.equal((await pending).delivered, true); assert.equal(callbacks, 1);
    await lab.reset();
    let staged;
    const failed = lab.forwarder({ receiver: lab.receiver({ afterUpdate: async () => { staged = await lab.physical(); }, failCommit: true }) });
    const failure = await failed.forward({ namespace: '/alarm', event: 'ack', args: [2, 'default'], acknowledge: () => { callbacks++; } });
    const afterFailure = await lab.physical();
    const revoked = lab.forwarder({ receiver: lab.receiver({ afterOuterAdmission: async operation => {
      await lab.admin.query(`UPDATE "${lab.namespace}".fixture_authority SET active=false WHERE tenant_id=$1 AND credential=$2`, [operation.tenant, operation.credential.id]);
    } }) });
    const denied = await ack(revoked); const afterRevoked = await lab.physical();
    trace('native-rollback-revocation', { failure, staged, afterFailure, denied, afterRevoked, callbacks, commits: lab.commits });
    assert.equal(failure.delivered, false); assert.equal(lab.commits[0].status, 'aborted'); assert.deepEqual(staged, []); assert.deepEqual(afterFailure, []);
    assert.equal(denied.delivered, false, 'ALARM_NATIVE_CURRENT_AUTHORITY transaction recheck denies revoked actor');
    assert.ok(lab.commits.every(value => value.status === 'aborted'));
    assert.deepEqual(afterRevoked, []); assert.equal(callbacks, 1, 'ALARM_NATIVE_FAILURE_NOACK no synthesized success');
  });
  it('keeps foreign state unreadable and realtime unable to write, with unsafe privilege refusal', async function () {
    await ack(lab.forwarder({ tenant: lab.B, credential: { id: 'owner-b' } }), 2, 'shared', 60000);
    const b = await lab.physical(lab.B);
    const read = await scope.withTenant(lab.A, () => lab.reader.query(`SELECT * FROM ${lab.table} WHERE tenant_id=$1`, [lab.B]));
    await assert.rejects(scope.withTenant(lab.A, () => lab.reader.query(`UPDATE ${lab.table} SET expires_at=expires_at+1`)), error => error.code === '42501');
    await assert.rejects(scope.withTenant(lab.A, () => lab.realtime.query(`INSERT INTO ${lab.table} VALUES($1,'x',1,1,2)`, [lab.A])), error => error.code === '42501');
    const a = frame(lab.A, Number(b[0].acked_at), [{ level: 1, group: 'shared' }]);
    const selected = await lab.cycle(() => a).select(lab.A);
    trace('native-isolation', { read: read.rows, selected, bBefore: b, bAfter: await lab.physical(lab.B) });
    assert.deepEqual(read.rows, [], 'ALARM_NATIVE_RLS no cross-tenant state');
    assert.equal(selected.result.emitted.length, 1, 'ALARM_NATIVE_ISOLATION foreign ack cannot silence A');
    assert.deepEqual(await lab.physical(lab.B), b);
    await lab.admin.query(`GRANT UPDATE ON ${lab.table} TO "${lab.roles.writer}"`);
    const unsafe = await ack();
    trace('native-unsafe-writer', { unsafe, aPhysical: await lab.physical() });
    assert.equal(unsafe.delivered, false, 'ALARM_NATIVE_PRIVILEGES broad writer refused');
    assert.deepEqual(await lab.physical(), []);
    await lab.admin.query(`REVOKE UPDATE ON ${lab.table} FROM "${lab.roles.writer}"`);
    await lab.admin.query(`GRANT UPDATE(acked_at,expires_at) ON ${lab.table} TO "${lab.roles.writer}"`);
  });
});
