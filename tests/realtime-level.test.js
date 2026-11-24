'use strict';

// Level-triggered realtime delivery (lib/server/realtime/runtime.js): the
// actual runtime with a recording revision reader, output reader and fanout.
const assert = require('node:assert/strict');
const runtimeFactory = require('../lib/server/realtime/runtime');
const A = '66666666-6666-4666-8666-00000000000a', B = '66666666-6666-4666-8666-00000000000b', C = '66666666-6666-4666-8666-00000000000c';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function lab (options = {}) {
  const state = { revision: new Map([[A, 1], [B, 1], [C, 1]]), watched: new Set([A, B]), refused: new Set(), failing: new Set(), hung: new Set(),
    asked: [], reads: [], sent: [], ineligible: [], revisionsFail: false };
  const runtime = await runtimeFactory({ levelMs: 60000, flushMs: 5, concurrency: 2, readCurrent: async tenant => ({ tenant, identity: 'same' }),
    watched: () => [...state.watched], isWatched: tenant => state.watched.has(tenant), onIneligible: tenant => state.ineligible.push(tenant),
    async readRevisions (list) {
      state.asked.push([...list]);
      if (state.revisionsFail) throw new Error('synthetic revision read unavailable');
      return new Map(list.map(tenant => [tenant, state.refused.has(tenant) ? { eligible: false } : { eligible: true, revision: String(state.revision.get(tenant)) }]));
    },
    create: current => ({ async acquire () {
      state.reads.push(current.tenant);
      if (state.hung.has(current.tenant)) await new Promise(() => {});
      if (state.failing.has(current.tenant)) throw new Error('synthetic output read unavailable');
      return { tenant: current.tenant, checkpoint: state.revision.get(current.tenant), frame: {} };
    } }),
    fanout: async ({ tenant, next }) => { state.sent.push([tenant, next.checkpoint]); }, ...options });
  return { state, runtime };
}
describe('level-triggered realtime delivery', function () {
  it('LEVEL_CONVERGES: with no hint, a pass reads every watched tenant that is behind and no tenant nobody watches', async function () {
    const { state, runtime } = await lab();
    try {
      await runtime.tick();
      assert.deepEqual(state.asked, [[A, B]], 'one batched revision read, for the watched tenants only');
      assert.deepEqual(state.sent.sort(), [[A, 1], [B, 1]]);
      state.revision.set(A, 4); state.revision.set(C, 9);
      await runtime.tick(); await runtime.tick();
      assert.deepEqual(state.sent.slice(2), [[A, 4]], 'the latest revision is sent once; a current tenant is not read again');
      assert.equal(state.reads.includes(C), false, 'LEVEL_WATCHED_ONLY');
      runtime.wake([C]); await runtime.tick();
      assert.equal(state.asked.flat().includes(C), false, 'a hint for a tenant nobody watches reads nothing');
    } finally { await runtime.close(); }
  });
  it('LEVEL_WAKE: a hint reads the tenant at once, and demand during a read is checked again after it', async function () {
    const { state, runtime } = await lab();
    try {
      await runtime.tick(); state.asked.length = 0;
      state.revision.set(B, 2); runtime.wake(B); runtime.wake([B]);
      await sleep(40);
      assert.deepEqual(state.asked, [[B]], 'coalesced demand is one revision read of the hinted tenant');
      assert.deepEqual(state.sent.at(-1), [B, 2]);
    } finally { await runtime.close(); }
  });
  it('LEVEL_ERROR_WITHHOLDS: a failed read sends nothing, keeps the frame held, and the next pass converges to the latest revision', async function () {
    const { state, runtime } = await lab();
    try {
      await runtime.tick();
      const held = runtime.last(A);
      state.failing.add(A); state.revision.set(A, 2);
      await runtime.tick();
      state.revision.set(A, 3); state.revisionsFail = true;
      await runtime.tick();
      assert.equal(runtime.last(A), held, 'an error drops nothing'); assert.deepEqual(state.ineligible, [], 'an error is never a refusal');
      assert.equal(state.sent.some(([tenant, revision]) => tenant === A && revision !== 1), false);
      assert.equal(runtime.pendingSummary().pending, 1, 'the tenant behind is the backlog');
      state.failing.clear(); state.revisionsFail = false;
      await runtime.tick(); await runtime.tick();
      assert.deepEqual(state.sent.at(-1), [A, 3], 'the skipped revision is not sent');
      assert.equal(runtime.pendingSummary().pending, 0);
    } finally { await runtime.close(); }
  });
  it('LEVEL_REFUSAL: only a completed read that refuses the tenant drops its frame', async function () {
    const { state, runtime } = await lab();
    try {
      await runtime.tick();
      state.refused.add(A);
      await runtime.tick();
      assert.deepEqual(state.ineligible, [A]); assert.equal(runtime.last(A), null); assert.notEqual(runtime.last(B), null);
    } finally { await runtime.close(); }
  });
  it('LEVEL_SINGLE_FLIGHT: a tenant whose read never answers delays no other tenant, is locatable by stage, and is released at its deadline', async function () {
    const { state, runtime } = await lab({ fetchDeadlineMs: 150 });
    const keep = setInterval(() => {}, 1000);
    try {
      state.hung.add(A);
      const pass = runtime.tick();
      await sleep(40);
      assert.deepEqual(state.sent, [[B, 1]], 'B is sent while A hangs');
      assert.deepEqual(runtime.stageOf(A), { stage: 'fetch', at: runtime.stageOf(A).at, active: true });
      assert.equal(runtime.progress().inflight.fetch, 1); assert.equal(runtime.stageOf(B).stage, 'send'); assert.equal(runtime.stageOf(B).active, false);
      runtime.wake(A); runtime.wake(A); await sleep(30);
      assert.equal(state.reads.filter(tenant => tenant === A).length, 1, 'one read in flight per tenant, whatever demand arrives');
      await pass;
      assert.ok(runtime.progress().deadlines >= 1); assert.equal(runtime.progress().inflight.fetch, 0);
      assert.equal(state.reads.filter(tenant => tenant === A).length, 2, 'the demand that arrived during the read is served after it');
      state.hung.clear();
      await runtime.tick();
      assert.deepEqual(state.sent.at(-1), [A, 1], 'the tenant is read again after its deadline');
    } finally { clearInterval(keep); await runtime.close(); }
  });
  it('LEVEL_READ: the revision reader is one control read and one checkpoint read per batch, and reads no settings or frame', async function () {
    const statements = [], scans = [];
    const read = require('../lib/pgstream/realtime-output').revisions({ config: { completedOutput: { namespace: 'synthetic_completed', consumer: 'evaluator-test' } },
      connection: { async readOnly (text, values) { statements.push(text); assert.deepEqual(values, ['evaluator-test-completed', [A, B, C]]);
        return { rows: [{ tenant: A, revision: '7', work_enabled: true }, { tenant: B, revision: '3', work_enabled: false }] }; } },
      trusted: { scan: async tenants => { scans.push(tenants); return new Map([[A, { activity: { state: 'active' } }], [B, { activity: { state: 'active' } }], [C, { activity: { state: 'paused' } }]]); } },
      owner: () => {} });
    assert.deepEqual([...await read([A, B, C])], [[A, { eligible: true, revision: '7' }], [B, { eligible: false }], [C, { eligible: false }]]);
    assert.equal(statements.length, 1); assert.equal(scans.length, 1);
    assert.match(statements[0], /^SELECT tenant_id::text AS tenant,output_revision::text AS revision,work_enabled FROM "synthetic_completed"\.tenant_consumer_checkpoint WHERE consumer=\$1 AND tenant_id=ANY\(\$2::uuid\[\]\)$/);
    assert.deepEqual(read.stats(), { polls: 1, failures: 0 });
  });
});
