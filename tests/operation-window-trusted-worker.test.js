'use strict';
const assert = require('node:assert/strict');
const fixture = require('./fixtures/operation-window-runtime-protocol');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const epochs = f => f.log.filter(row => row[0].includes('/* operation-window-epoch'));
const full = f => f.log.filter(row => row[0].includes('operation-window-role'));

describe('Explicit trusted worker operation boundary (source protocol)', function () {
  it('omits catalogue digests for trusted work and retains full inspection at the operational boundary', async function () {
    const f = fixture({ trustedWorker: true });
    await f.window.ready(); const baseline = full(f).length;
    await f.window.run(A, () => {}); await f.window.run(B, () => {});
    assert.equal(epochs(f).length, 0);
    assert.equal(full(f).length, baseline, 'no per-tenant full admission');
    const current = f.log.filter(row => row[0].includes('/* operation-window-current'));
    assert.equal(current.length, 2, 'each registration checks current tenant state');
    for (const [sql] of current) {
      assert(!sql.includes('pg_auth_members') && !sql.includes('string_agg') && !sql.includes('sha256'));
      assert(sql.includes('w.tenant_id=$1') && sql.includes('r.rolsuper') && sql.includes('pg_backend_pid()'));
    }
    await f.window.verifyClient(f.client);
    await f.window.verifyOperational();
    assert.equal(full(f).length, baseline + 2);
    await f.window.close();
  });
  for (const method of ['verifyOperational', 'verifyClient']) it('withdraws trusted admission after ' + method + ' fails and requires operational revalidation', async function () {
    let drift = false;
    const f = fixture({ trustedWorker: true, catalogueMutate: (kind, rows) => { if (drift && kind === 'role') rows[0].elevated = true; } });
    await f.window.ready(); await f.window.run(A, () => {});
    drift = true;
    await assert.rejects(f.window[method](...(method === 'verifyClient' ? [f.client] : [])), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    await assert.rejects(f.window.run(A, () => assert.fail('withdrawn worker body')), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    drift = false;
    await f.window.verifyClient(f.client);
    await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    await f.window.verifyOperational();
    await f.window.run(A, () => {});
    await f.window.close();
  });
  it('defers catalogue drift detection to the trusted operational boundary while the public default remains per transaction', async function () {
    let drift = false;
    const options = { trustedWorker: true, catalogueMutate: (kind, rows) => { if (drift && kind === 'role') rows[0].elevated = true; } };
    const f = fixture(options); await f.window.ready(); await f.window.run(A, () => {});
    drift = true; options.epoch = 'f'.repeat(64);
    await f.window.run(A, () => {});
    await assert.rejects(f.window.verifyOperational(), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    const publicFixture = fixture({ ...options, trustedWorker: false });
    await assert.rejects(publicFixture.window.ready(), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    await f.window.close();
  });
  for (const [label, options, code] of [
    ['suspension', { phase: 'suspended' }, 'LIFECYCLE_WINDOW_SUSPENDED'],
    ['tenant binding', { key: '23' }, 'LIFECYCLE_WINDOW_BINDING_CHANGED'],
    ['role elevation', { superuser: true }, 'LIFECYCLE_WINDOW_ROLE_UNSAFE'],
    ['datastore replacement', { datastore: { postmaster_birth: 'changed' } }, 'LIFECYCLE_WINDOW_DATASTORE_CHANGED'],
    ['backend replacement', { sqlPid: 124 }, 'LIFECYCLE_WINDOW_DATASTORE_CHANGED']
  ]) it('checks live ' + label + ' before trusted body SQL', async function () {
    // Apply changes only after successful startup admission.
    const live = { trustedWorker: true }; const changed = fixture(live); await changed.window.ready(); Object.assign(live, options);
    await assert.rejects(changed.window.run(A, () => assert.fail('unsafe trusted body')), { code });
    assert.equal(changed.pending.size, 0);
    assert(changed.log.some(row => row[0] === 'ROLLBACK'));
    await changed.window.close();
  });
  it('withdraws in-flight scope and output when external operational verification fails', async function () {
    let drift = false, releaseBody, entered;
    const f = fixture({ trustedWorker: true, catalogueMutate: (kind, rows) => { if (drift && kind === 'role') rows[0].elevated = true; } });
    const barrier = new Promise(resolve => { releaseBody = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const running = f.window.run(A, async () => {
      entered(); await barrier;
      assert.equal(f.window.current(A), false);
      assert.throws(() => f.window.assertCurrent(A), { code: 'LIFECYCLE_WINDOW_SCOPE_INVALID' });
      assert.throws(() => f.window.currentGeneration(A), { code: 'LIFECYCLE_WINDOW_SCOPE_INVALID' });
      return 'withdrawn output';
    });
    const settled = running.catch(error => error);
    await started; drift = true;
    await assert.rejects(f.window.verifyOperational(), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    releaseBody(); assert.equal((await settled).code, 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE');
    assert.deepEqual([...f.pending.values()], [true], 'healthy registration backend still finishes its marker');
    await f.window.close();
  });
  it('withdraws trusted admission when acquiring the operational backend fails', async function () {
    const f = fixture({ trustedWorker: true }); await f.window.ready();
    const connect = f.pool.connect;
    f.pool.connect = async () => { throw new Error('synthetic operational backend unavailable'); };
    await assert.rejects(f.window.verifyOperational(), /synthetic operational backend unavailable/);
    f.pool.connect = connect;
    await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    await f.window.verifyOperational(); await f.window.run(A, () => {});
    await f.window.close();
  });
  it('keeps admission withdrawn through the held related callback, then reopens', async function () {
    const f = fixture({ trustedWorker: true }); await f.window.ready();
    let release, entered;
    const held = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const verifying = f.window.verifyOperational(async () => { entered(); await held; });
    await started;
    await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    await f.window.verifyClient(f.client);
    await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    release(); await verifying;
    await f.window.run(A, () => {}); await f.window.close();
  });
  it('leaves admission withdrawn after a related callback fails and supports a full retry', async function () {
    const f = fixture({ trustedWorker: true }); await f.window.ready();
    const failure = new Error('synthetic related worker verification failure');
    await assert.rejects(f.window.verifyOperational(async () => { await f.window.verifyClient(f.client); throw failure; }), error => error === failure);
    await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    await f.window.verifyOperational(async () => { await f.window.verifyClient(f.client); });
    await f.window.run(A, () => {}); await f.window.close();
  });
  it('does not reopen around a concurrent pending or failed verification', async function () {
    const f = fixture({ trustedWorker: true }); await f.window.ready();
    let release, entered;
    const held = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const first = f.window.verifyOperational(async () => { entered(); await held; });
    await started;
    await f.window.verifyOperational();
    await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    await assert.rejects(f.window.verifyOperational(async () => { throw new Error('synthetic concurrent refusal'); }));
    release(); await first;
    await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    await f.window.verifyOperational(); await f.window.run(A, () => {}); await f.window.close();
  });
  it('rejects invalid related-verification callbacks', async function () {
    const f = fixture({ trustedWorker: true });
    for (const value of [null, false, 1, {}, 'callback']) await assert.rejects(f.window.verifyOperational(value), TypeError);
    await f.window.run(A, () => {}); await f.window.close();
  });
  it('still rejects cross-tenant nesting and operational checks inherited from a tenant body', async function () {
    const f = fixture({ trustedWorker: true });
    await f.window.run(A, async () => {
      await assert.rejects(f.window.run(B, () => {}), { code: 'LIFECYCLE_WINDOW_SCOPE_INVALID' });
      await assert.rejects(f.window.verifyOperational(), { code: 'LIFECYCLE_WINDOW_AMBIENT_SCOPE' });
    });
    await f.window.close();
  });
});
