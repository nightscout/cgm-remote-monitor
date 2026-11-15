'use strict';
const assert = require('node:assert/strict');
const fixture = require('./fixtures/operation-window-runtime-protocol');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const count = (f, text) => f.log.filter(row => row[0].includes(text)).length;
const barrier = () => { let release; const wait = new Promise(resolve => { release = resolve; }); return { wait, release }; };

describe('Lifetime lane lock reuse (source protocol, not PostgreSQL evidence)', function () {
  it('shares only overlapping same-tenant locks and revalidates every registration transaction', async function () {
    const options = { leaseSessionCount: 1 }; const f = fixture(options), first = barrier(), entered = barrier();
    const pending = f.window.run(A, async () => { entered.release(); await first.wait; });
    await entered.wait;
    const before = count(f, '/* operation-window-current');
    await f.window.run(A, () => {});
    assert.equal(count(f, 'pg_try_advisory_lock_shared'), 1);
    assert.equal(count(f, 'pg_advisory_unlock_shared'), 0, 'first body still owns the lock');
    assert.equal(count(f, '/* operation-window-current'), before + 1, 'new transaction reads current principal and tenant window');
    assert.equal([...f.pending.values()].filter(done => !done).length, 1);
    await f.window.run(B, () => {});
    assert.equal(count(f, 'pg_try_advisory_lock_shared'), 2, 'other tenant acquires its own lock');
    first.release(); await pending;
    assert.equal(count(f, 'pg_advisory_unlock_shared'), 2);
    await f.window.run(A, () => {});
    assert.equal(count(f, 'pg_try_advisory_lock_shared'), 3, 'nonoverlapping lifetime acquires anew');
    await f.window.close();
  });
  for (const [label, change, code] of [
    ['tenant suspension', options => { options.phase = 'suspended'; }, 'LIFECYCLE_WINDOW_SUSPENDED'],
    ['lock binding', options => { options.key = '23'; }, 'LIFECYCLE_WINDOW_BINDING_CHANGED'],
    ['authority', options => { options.superuser = true; }, 'LIFECYCLE_WINDOW_ROLE_UNSAFE'],
    ['datastore', options => { options.datastore = { postmaster_birth: 'changed' }; }, 'LIFECYCLE_WINDOW_DATASTORE_CHANGED'],
    ['physical backend', (options, f) => { f.client.processID++; }, 'LIFECYCLE_WINDOW_LOCK_LOST']
  ]) it('refuses changed ' + label + ' while another body holds a reused lock', async function () {
    const options = { leaseSessionCount: 1 }; const f = fixture(options), first = barrier(), entered = barrier();
    const pending = f.window.run(A, async () => { entered.release(); await first.wait; });
    const settled = pending.catch(error => error);
    await entered.wait; change(options, f);
    let called = false;
    await assert.rejects(f.window.run(A, () => { called = true; }), { code });
    assert.equal(called, false);
    assert.equal(f.pending.size, 1, 'refused registration creates no marker');
    first.release(); await settled;
    await f.window.close().catch(() => {});
  });
  it('refuses live owner membership while sharing a lock', async function () {
    let drift = false;
    const options = { leaseSessionCount: 1, catalogueMutate: (kind, rows) => { if (drift && kind === 'role') rows[0].elevated = true; } };
    const f = fixture(options), first = barrier(), entered = barrier();
    const pending = f.window.run(A, async () => { entered.release(); await first.wait; });
    await entered.wait; options.ownsControl = true;
    await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_ROLE_UNSAFE' });
    assert.equal(count(f, 'pg_try_advisory_lock_shared'), 1);
    first.release(); await pending;
    await f.window.close();
  });
  it('rolls back a refused reused registration and keeps the original lease until its body finishes', async function () {
    const options = { leaseSessionCount: 1 }; const f = fixture(options), first = barrier(), entered = barrier();
    const pending = f.window.run(A, async () => { entered.release(); await first.wait; });
    await entered.wait; options.phase = 'suspended';
    await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_SUSPENDED' });
    assert.equal(count(f, 'ROLLBACK'), 1);
    assert.equal(count(f, 'pg_advisory_unlock_shared'), 0);
    options.phase = 'active'; first.release(); await pending;
    assert.equal(count(f, 'pg_advisory_unlock_shared'), 1);
    assert.deepEqual([...f.pending.values()], [true]);
    await f.window.close();
  });
  it('evicts and refuses a lane when the last shared unlock is lost', async function () {
    const options = { leaseSessionCount: 1 }; const f = fixture(options), first = barrier(), entered = barrier();
    const pending = f.window.run(A, async () => { entered.release(); await first.wait; });
    const settled = pending.catch(error => error);
    await entered.wait; await f.window.run(A, () => {});
    options.unlock = false; first.release();
    assert.equal((await settled).code, 'LIFECYCLE_WINDOW_RELEASE_FAILED');
    assert(f.log.some(row => row[0] === 'release' && row[1] === true), 'lost owner is evicted');
    await assert.rejects(f.window.run(A, () => {}));
    assert.equal(count(f, 'pg_try_advisory_lock_shared'), 1, 'failed lane cannot acquire again');
    await f.window.close().catch(() => {});
  });
  it('keeps unfinished markers on transport loss and refuses subsequent lane reuse', async function () {
    const f = fixture({ leaseSessionCount: 1 }), first = barrier(), entered = barrier();
    const pending = f.window.run(A, async () => { entered.release(); await first.wait; });
    const settled = pending.catch(error => error);
    await entered.wait;
    const lost = new Error('synthetic lost backend'); f.client.emit('error', lost);
    await assert.rejects(f.window.run(A, () => {}), error => error === lost);
    first.release(); await settled;
    assert.deepEqual([...f.pending.values()], [false]);
    assert.equal(f.log.filter(row => row[0].startsWith('UPDATE')).length, 0);
    await f.window.close().catch(() => {});
  });
});
