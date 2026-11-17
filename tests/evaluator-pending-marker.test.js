'use strict';
// Pending-age witness under steady input. A clinical receipt marks a tenant
// pending after its durable COMMIT; a cycle may complete while newer input
// arrives. Readiness must follow the oldest input that is still unprocessed,
// not an input the durable completion already covered. A mark that arrives
// during a cycle must still fence the tenant until a later completion.
const assert = require('node:assert/strict');
const start = require('../lib/server/serve/evaluator-runtime');
const A = '11111111-1111-4111-8111-111111111111';

function lab ({ pendingAt }) {
  let now = 100, version = 0, during = null;
  const runtime = start({ tenants: [A], externalRecovery: true, recoveryIntervalMs: 1000, timeIntervalMs: 60000,
    readCurrent: async tenant => ({ tenant, identity: 'a'.repeat(64) }),
    create: async () => ({ async evaluate () { if (during) await during(); return { checkpoint: version, properties: {}, emitted: [], requested: [] }; }, close () {} }),
    schedule: () => ({}), cancel () {}, now: () => now,
    durable: { pendingMs: 1000,
      async begin () { return { clock: String(version) }; },
      async complete (tenant, { result, identity }) {
        return { changed: true, pendingAt: pendingAt(), output: { tenant, identity, outputRevision: version, contentDigest: 'b'.repeat(64), result } };
      } } });
  return { runtime, set: fn => { during = fn; }, clock: { get now () { return now; }, set now (v) { now = v; } }, bump: () => ++version };
}

describe('evaluator pending marker under steady input', function () {
  it('does not report a stall while every cycle completes and newer input keeps arriving', async function () {
    let newest = null;
    const l = lab({ pendingAt: () => newest });
    const runtime = await l.runtime;
    try {
      await runtime.acquire(A);
      runtime.markPending(A, l.clock.now);
      // Each cycle covers the input pending at its start; one newer input
      // arrives while it runs. The durable row reports only that newer input.
      l.set(async () => { l.clock.now += 400; l.bump(); newest = l.clock.now; runtime.markPending(A, newest); });
      for (let i = 0; i < 4; i++) await runtime.acquire(A);
      const row = runtime.health([A]).tenants[0];
      assert.equal(row.code, null, 'STEADY_INPUT_FALSE_STALL ' + JSON.stringify(row));
      assert.equal(row.ready, true);
      const witness = runtime.pendingWitness([A])[0].memory;
      assert.equal(witness.pendingSince, newest, 'pending age follows the oldest unprocessed input');
    } finally { await runtime.close(); }
  });

  it('keeps a mark from during the cycle pending when the durable read did not see it (newer-input fence)', async function () {
    let marked = null;
    const l = lab({ pendingAt: () => null });
    const runtime = await l.runtime;
    try {
      await runtime.acquire(A);
      runtime.markPending(A, l.clock.now);
      l.set(async () => { l.clock.now += 400; marked = l.clock.now; runtime.markPending(A, marked); });
      await runtime.acquire(A);
      l.set(null);
      assert.equal(runtime.pendingWitness([A])[0].memory.pendingSince, marked, 'MARK_DURING_CYCLE_LOST');
      l.clock.now = marked + 1000;
      assert.equal(runtime.health([A]).tenants[0].code, 'EVALUATOR_CLINICAL_PROGRESS_STALLED', 'an unprocessed mark still ages into a stall');
      await runtime.acquire(A);
      assert.equal(runtime.pendingWitness([A])[0].memory.pendingSince, null, 'a later completion with nothing pending clears it');
      assert.equal(runtime.health([A]).tenants[0].code, null);
    } finally { await runtime.close(); }
  });

  it('still reports a stall when completions stop', async function () {
    const l = lab({ pendingAt: () => null });
    const runtime = await l.runtime;
    try {
      await runtime.acquire(A);
      runtime.markPending(A, l.clock.now);
      l.clock.now += 1000;
      assert.equal(runtime.health([A]).tenants[0].code, 'EVALUATOR_CLINICAL_PROGRESS_STALLED');
    } finally { await runtime.close(); }
  });
});
