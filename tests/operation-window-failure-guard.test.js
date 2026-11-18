'use strict';

const assert = require('node:assert/strict');
const fixture = require('./fixtures/operation-window-runtime-protocol');
const windows = require('../lib/tenant-lifecycle/operation-window');
const diagnostic = require('../lib/diagnostics/evaluator-failure');
const A = '11111111-1111-4111-8111-111111111111';
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

  it('retains source provenance for an expired scope', async function () {
    const f = fixture({trustedWorker:true}); let late;
    try {
      await f.window.run(A, async () => {
        late = new Promise(resolve => setImmediate(() => resolve(refusal(() => f.window.assertCurrent(A)))));
      });
      assert.equal(windows.failureGuard(f.window, await late), 'scope-inactive');
    } finally { await f.window.close(); }
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
      assert.equal(windows.failureGuard(f.window, await later), 'scope-inactive');
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
