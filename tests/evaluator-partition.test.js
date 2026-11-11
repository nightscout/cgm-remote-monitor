'use strict';

// Evaluator partitioning (MT-EVALUATOR-PARTITION): the pool gate shared by the
// evaluator runtime and its notification consumers, the operational
// inspection contract and the pool-operations contract. Actual runtime and
// consumer coordinator with SQL protocol doubles; no PostgreSQL.
// covers: lib/server/serve/evaluator-pool.js, lib/server/serve/evaluator-runtime.js, lib/server/serve/evaluator-consumers.js
const assert = require('node:assert/strict');
const protocol = require('./fixtures/evaluator-consumers-protocol');
const gate = require('../lib/server/serve/evaluator-pool');
const contracts = require('../lib/server/internal-api/contracts');
const { validate } = require('../lib/server/internal-api/schema');

// A controllable pool gate with the evaluator-pool interface.
function fakePool (admitted) {
  let reason = null, reads = 0;
  return { admitted, reads: () => reads, set (tenants, why = null) { admitted = new Set(tenants); reason = why; },
    admits: tenant => admitted.has(tenant), reason: () => reason, refresh: async () => { reads++; } };
}

describe('evaluator partitioning: pool gate', function () {
  it('standalone admits every configured tenant and inspects without a lease', async function () {
    const member = require('../lib/pool-membership').standalone('evaluator');
    const g = gate.create({ member, tenants: ['11111111-1111-4111-8111-111111111111'] });
    assert.equal(g.admits('11111111-1111-4111-8111-111111111111'), true);
    const view = await g.inspect();
    assert.equal(view.observed, null, 'no fabricated membership');
    assert.deepEqual(view.configured, { mode: 'standalone', ordinal: 0, rule: null, leaseMs: null, configuredTenants: 1 });
    assert.equal(view.gate.eligible, true);
  });
  it('partitioned admits nothing before the first read or while refused, and reports a change of slice', async function () {
    const A = '11111111-1111-4111-8111-111111111111';
    let next = { eligible: false, reason: 'POOL_COUNT_UNSET', conflicts: [] };
    const member = { configured: { mode: 'partitioned', ordinal: 0, leaseMs: 300 }, slice: async () => next };
    const g = gate.create({ member, tenants: [A] });
    let changes = 0; g.onChange(() => changes++);
    assert.equal(g.admits(A), false); assert.equal(g.reason(), 'POOL_NOT_READ');
    await g.refresh(); assert.equal(g.admits(A), false); assert.equal(changes, 0);
    next = { eligible: true, includes: () => true, members: 1 };
    await g.refresh(); assert.equal(g.admits(A), true); assert.equal(changes, 1);
    next = { eligible: false, reason: 'POOL_DUPLICATE_ORDINAL', conflicts: [] };
    await g.refresh(); assert.equal(g.admits(A), false); assert.equal(g.reason(), 'POOL_DUPLICATE_ORDINAL'); assert.equal(changes, 2);
  });
});

describe('evaluator partitioning: runtime and consumers', function () {
  const scope = require('../lib/storage/tenant-scope');
  let mode;
  beforeEach(function () { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(function () { scope.setTenancyMode(mode); });
  it('works only admitted tenants; a withdrawn tenant has no output, cycle or delivery; re-admission starts with an acquisition', async function () {
    const pool = fakePool(new Set());
    const q = await protocol(undefined, { pool });
    try {
      const { A, B } = q;
      pool.set([A]);
      await q.runtime.acquire(A); await q.runtime.acquire(B);
      assert.ok(q.runtime.last(A), 'admitted tenant publishes');
      assert.equal(q.runtime.last(B), null, 'withdrawn tenant publishes nothing');
      assert.ok(!q.evaluated.includes(B), 'withdrawn tenant is never evaluated');
      await q.start();
      assert.ok(q.effects.some(row => row.tenant === A), 'admitted tenant delivers');
      assert.ok(!q.effects.some(row => row.tenant === B), 'withdrawn tenant delivers nothing');
      const health = q.consumers.health().tenants.find(row => row.tenant === B);
      assert.deepEqual([health.state, health.code], ['inactive', 'EVALUATOR_CONSUMER_POOL_NOT_IN_SLICE']);
      assert.equal(q.runtime.health().tenants.find(row => row.tenant === B).code, 'EVALUATOR_POOL_NOT_IN_SLICE');
      // Membership refused: every tenant is withdrawn, with the reason as its code.
      pool.set([], 'POOL_DUPLICATE_ORDINAL');
      await q.runtime.tick(A);
      assert.equal(q.runtime.last(A), null);
      assert.equal(q.runtime.health().tenants.find(row => row.tenant === A).code, 'EVALUATOR_POOL_DUPLICATE_ORDINAL');
      const sent = q.effects.length; q.advance(120000); await q.consumers.wake(A); await q.consumers.retry(A);
      assert.equal(q.effects.length, sent, 'a refused member delivers nothing, repeat clock included');
      // B enters this member's slice: a fresh acquisition, then output.
      pool.set([B]); const before = q.evaluated.filter(t => t === B).length;
      await q.runtime.tick(B);
      assert.equal(q.evaluated.filter(t => t === B).length, before + 1, 'entry is an acquisition, not a time-only tick');
      assert.ok(q.runtime.last(B));
    } finally { await q.close(); }
  });
  it('fences a cycle in flight when membership changes before it publishes', async function () {
    const pool = fakePool(new Set());
    const q = await protocol(undefined, { pool });
    try {
      const { A } = q; pool.set([A]);
      const original = pool.admits; let flip = true;
      // Withdraw A between evaluation and publication (the first admits check after evaluate).
      pool.admits = tenant => { if (flip && q.evaluated.includes(A)) { flip = false; pool.set([]); } return original(tenant); };
      await q.runtime.acquire(A);
      assert.equal(q.runtime.last(A), null, 'POOL_CYCLE_FENCED');
    } finally { await q.close(); }
  });
  it('reads membership once per scheduled pass', async function () {
    const pool = fakePool(new Set());
    const q = await protocol(undefined, { pool });
    try {
      const reads = pool.reads();
      for (const timer of q.clinicalTimers) timer.fn();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(pool.reads() - reads, q.clinicalTimers.length);
    } finally { await q.close(); }
  });
});

describe('evaluator partitioning: private contracts', function () {
  const A = '11111111-1111-4111-8111-111111111111';
  const refused = fn => assert.throws(fn, error => error.code === 'INTERNAL_API_SCHEMA_REFUSED');
  it('fixes the evaluator inspection read: configured beside observed, codes and counts only', function () {
    const inspect = contracts.evaluatorInspection.operations.inspectEvaluator;
    validate(inspect.request, {});
    refused(() => validate(inspect.request, { tenant: A }));
    const response = { kind: 'evaluator',
      configured: { mode: 'partitioned', ordinal: 1, rule: 'sha256-modulo-v1', leaseMs: 3000, configuredTenants: 1 },
      observed: { desiredMembers: 3, previousMembers: 2, revision: 2, effectiveMembers: 2, switching: true, liveOrdinals: [0, 1], missingOrdinals: [],
        conflicts: [], reason: null, rows: [{ ordinal: 1, self: true, live: true, appliedMembers: 2, heartbeatAgeMs: 10, leaseRemainingMs: 2990 }] },
      gate: { eligible: true, reason: null, members: 2, reads: 4, refusals: 0, changes: 1, checkedAgeMs: 5, heartbeats: { renewed: 3, failed: 0, lastReason: null } },
      tenants: [{ tenant: A, assignedOrdinal: 1, admitted: true, code: null, ready: true, cycles: 3, outputRevision: 1, inputCheckpoint: 0,
        delivery: { state: 'idle', code: null, passes: 2, repeatAt: null } }] };
    validate(inspect.response, response);
    validate(inspect.response, { ...response, configured: { mode: 'standalone', ordinal: 0, rule: null, leaseMs: null, configuredTenants: 1 },
      observed: null, gate: { ...response.gate, heartbeats: null } });
    refused(() => validate(inspect.response, { ...response, tenants: [{ ...response.tenants[0], endpoint: 'postgres://x' }] }));
    refused(() => validate(inspect.response, { ...response, observed: { ...response.observed, memberId: A } }));
  });
  it('fixes the pool-operations service: a kind and a count, or a denial', function () {
    const ops = contracts.poolOperations.operations;
    validate(ops.setPoolMembers.request, { kind: 'evaluator', members: 3 });
    for (const bad of [{ kind: 'evaluator', members: 0 }, { kind: 'evaluator', members: 1025 }, { kind: 'Evaluator', members: 2 }, { kind: 'evaluator' },
      { kind: 'evaluator', members: 2, ordinal: 1 }]) refused(() => validate(ops.setPoolMembers.request, bad));
    const view = { kind: 'evaluator', desired: { members: 3, previousMembers: 2, rule: 'sha256-modulo-v1', revision: 2 }, effectiveMembers: 2,
      switching: true, liveOrdinals: [0, 1], missingOrdinals: [], conflicts: [], members: [{ ordinal: 0, live: true, appliedMembers: 2, heartbeatAgeMs: 1, leaseRemainingMs: 2 }] };
    validate(ops.setPoolMembers.response, { outcome: 'applied', ...view });
    validate(ops.getPool.response, { outcome: 'observed', ...view });
    validate(ops.getPool.response, { outcome: 'denied', code: 'POOL_KIND_UNKNOWN' });
    refused(() => validate(ops.getPool.response, { outcome: 'observed', ...view, members: [{ ...view.members[0], memberId: A }] }));
  });
});
