'use strict';

const assert = require('node:assert/strict');
const fixture = require('./fixtures/operation-window-runtime-protocol');
const windows = require('../lib/tenant-lifecycle/operation-window');
const diagnostic = require('../lib/diagnostics/evaluator-failure');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const hold = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const refusal = fn => { try { fn(); } catch (error) { return error; } assert.fail('expected refusal'); };

describe('operation-window refusal provenance', function () {
  it('binds original errors to their own window and rejects copied or fabricated provenance', async function () {
    const own = fixture({ trustedWorker: true }), foreign = fixture({ trustedWorker: true });
    try {
      const error = refusal(() => own.window.assertCurrent(A));
      assert.equal(error.code, 'LIFECYCLE_WINDOW_SCOPE_INVALID');
      assert.equal(windows.failureGuard(own.window, error), 'scope-missing');
      for (const candidate of [new Error(error.message), Object.assign(new Error(error.message), error, {guard:'verification-pending'}), {}, null]) {
        assert.equal(windows.failureGuard(own.window, candidate), null);
      }
      assert.equal(windows.failureGuard(foreign.window, error), null);
      assert.equal(windows.failureGuard({}, error), null);
      const lines = [], trace = diagnostic.create('synthetic', { NS_EVALUATOR_FAILURE_TRACE_LIMIT:'10' }, line => lines.push(JSON.parse(line.slice(24))), () => true);
      const ownAttempt = trace.start(1, true, own.window), foreignAttempt = trace.start(1, true, foreign.window);
      ownAttempt.refused(error); foreignAttempt.refused(error);
      assert.equal(ownAttempt.innerGuard, 'scope-missing');
      assert.equal(foreignAttempt.innerGuard, null);
      const state = {tenant:A,failedCompletions:1,generation:1,code:null};
      for (const operationWindow of [own.window, foreign.window]) trace.failure('dispatch-exception', ownAttempt, state, {error,operationWindow});
      assert.deepEqual(lines.slice(1).map(line => line.exceptionGuard), ['scope-missing', null]);
    } finally { await Promise.all([own.window.close(), foreign.window.close()]); }
  });

  it('records pending verification at issuance, preserves scope-fault precedence and never makes scope errors retryable', async function () {
    const f = fixture({ trustedWorker:true }), body = hold(), entered = hold(), checked = hold(), check = hold();
    let verifying, inner;
    const running = f.window.run(A, async () => {
      entered.resolve(); await body.promise;
      const foreign = refusal(() => f.window.assertCurrent(B));
      assert.equal(windows.failureGuard(f.window, foreign), 'scope-tenant-mismatch');
      inner = refusal(() => f.window.currentGeneration(A));
      assert.equal(inner.code, 'LIFECYCLE_WINDOW_SCOPE_INVALID');
      assert.equal(windows.failureGuard(f.window, inner), 'verification-pending');
      assert.equal(windows.isPendingVerification(f.window, inner), false, 'diagnostic provenance adds no retry classification');
    });
    const ended = running.catch(error => error);
    try {
      await entered.promise;
      verifying = f.window.verifyOperational(async () => { checked.resolve(); await check.promise; });
      await checked.promise; body.resolve();
      const outer = await ended;
      assert.equal(outer.code, 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE');
      assert.equal(windows.failureGuard(f.window, outer), 'verification-pending');
      check.resolve(); await verifying;
      assert.equal(windows.failureGuard(f.window, inner), 'verification-pending', 'provenance describes issuance, not present health');
      await f.window.run(A, () => f.window.assertCurrent(A));
    } finally { body.resolve(); check.resolve(); await verifying?.catch(() => {}); await ended; await f.window.close(); }
  });

  it('keeps a failed verification withdrawn and never labels concurrent failed admission as pending', async function () {
    const f = fixture({trustedWorker:true}), body = hold(), entered = hold(), check = hold(), checked = hold();
    let verifying;
    const running = f.window.run(A, async () => {
      entered.resolve(); await body.promise;
      const error = refusal(() => f.window.assertCurrent(A));
      assert.equal(windows.failureGuard(f.window, error), 'admission-withdrawn');
    });
    const ended = running.catch(error => error);
    try {
      await entered.promise;
      verifying = f.window.verifyOperational(async () => { checked.resolve(); await check.promise; });
      await checked.promise;
      await assert.rejects(f.window.verifyOperational(() => { throw Error('synthetic authority refusal'); }), /authority refusal/);
      body.resolve(); assert.equal(windows.failureGuard(f.window, await ended), 'admission-withdrawn');
      check.resolve(); await verifying;
      await assert.rejects(f.window.run(A, () => assert.fail('failed admission body')), error => windows.failureGuard(f.window, error) === 'admission-withdrawn');
      await f.window.verifyOperational(); await f.window.run(A, () => {});
    } finally { body.resolve(); check.resolve(); await verifying?.catch(() => {}); await ended; await f.window.close(); }
  });

  it('retains restore invalidation and expired-scope refusals', async function () {
    const f = fixture({trustedWorker:true}); let late;
    try {
      await f.window.run(A, async () => {
        late = new Promise(resolve => setImmediate(() => resolve(refusal(() => f.window.assertCurrent(A)))));
      });
      assert.equal(windows.failureGuard(f.window, await late), 'scope-inactive');
      await f.window.run(A, () => {
        f.window.invalidateTenant(A);
        const error = refusal(() => f.window.assertCurrent(A));
        assert.equal(error.code, 'LIFECYCLE_WINDOW_SUSPENDED');
        assert.equal(windows.failureGuard(f.window, error), 'tenant-invalidated');
        assert.equal(windows.isSuspension(error), true);
      });
    } finally { await f.window.close(); }
  });

  it('keeps a lost session from being labelled as an otherwise unfailed verification', async function () {
    const f = fixture({trustedWorker:true}), body = hold(), entered = hold(), checked = hold(), check = hold();
    let verifying;
    const running = f.window.run(A, async () => {
      entered.resolve(); await body.promise;
      assert.equal(windows.failureGuard(f.window, refusal(() => f.window.assertCurrent(A))), 'scope-inactive');
    });
    const ended = running.catch(error => error);
    try {
      await entered.promise;
      verifying = f.window.verifyOperational(async () => { checked.resolve(); await check.promise; });
      await checked.promise;
      const failure = new Error('synthetic lost lifetime session');
      f.client.emit('error', failure);
      await assert.rejects(f.window.run(B, () => assert.fail('lost session admission')), error =>
        windows.failureGuard(f.window, error) === 'admission-withdrawn');
      body.resolve(); assert.equal(await ended, failure);
    } finally { body.resolve(); check.resolve(); await verifying?.catch(() => {}); await ended; await f.window.close(); }
  });

  it('reports a scope that has stopped accepting children while its admitted child drains', async function () {
    const f = fixture({trustedWorker:true}); let lease, later;
    try {
      await f.window.run(A, async () => {
        lease = await f.window.acquireClient(f.client,A);
        later = new Promise(resolve => setImmediate(() => {
          const error = refusal(() => f.window.assertCurrent(A));
          lease.close(); resolve(error);
        }));
      });
      assert.equal(windows.failureGuard(f.window, await later), 'scope-closing');
    } finally { lease?.close(); await f.window.close(); }
  });

  it('classifies an explicit feed fence without adding provenance to arbitrary errors', function () {
    const lines = [], trace = diagnostic.create('synthetic', {NS_EVALUATOR_FAILURE_TRACE_LIMIT:'10'}, line => lines.push(JSON.parse(line.slice(24))), () => true);
    const attempt = trace.start(1,true);
    attempt.refused(new Error('EVALUATOR_FEED_UNAVAILABLE'));
    assert.equal(attempt.inner, 'EVALUATOR_FEED_UNAVAILABLE');
    assert.equal(attempt.innerGuard, null);
    attempt.refused(Object.assign(new Error('sensitive details'), {guard:'verification-pending'}));
    assert.equal(attempt.inner, 'unclassified'); assert.equal(attempt.innerGuard, null);
  });
});
