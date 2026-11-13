'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { AsyncLocalStorage } = require('node:async_hooks');
const cold = require('../lib/server/serve/cold-start-admission');
const startup = require('../lib/server/serve/tenant-startup');
const scope = require('../lib/storage/tenant-scope');
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function clock () {
  let serial = 0; const tasks = new Map(), delays = [];
  return { schedule (fn, delay) { const id = ++serial; tasks.set(id, fn); delays.push(delay); return id; },
    cancel: id => tasks.delete(id), async next () { const [id, fn] = tasks.entries().next().value || []; assert(id, 'scheduled task expected'); tasks.delete(id); fn(); await turn(); },
    get size () { return tasks.size; }, delays };
}
function gate (c, activeLimit = 1, pendingLimit = 3) {
  let random = 0;
  return cold.create({ activeLimit, pendingLimit, minDelayMs: 10, maxDelayMs: 20,
    random: () => (random++ % 10) / 10, schedule: c.schedule, cancel: c.cancel });
}
function options (g, extra = {}) { return { coldAdmission: g, coldAlertMs: false, alert () {}, drainedLog () {}, ...extra }; }
function isolated (mocks, mutate = x => x) {
  const name = path.resolve(__dirname, '../lib/server/serve/tenant-startup.js'), m = new Module(name, module);
  m.filename = name; m.paths = Module._nodeModulePaths(path.dirname(name)); const original = m.require.bind(m);
  m.require = key => Object.hasOwn(mocks, key) ? mocks[key] : original(key);
  m._compile(mutate(fs.readFileSync(name, 'utf8')), name); return m.exports;
}

describe('opt-in cold initialization queue', function () {
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));
  it('declares queued readiness only as an optional source schema field', function () {
    const schema = require('../lib/server/internal-api/contracts/evaluator-inspection.json');
    function find (value) {
      if (!value || typeof value !== 'object') return null;
      if (value.properties?.startup) return value.properties.startup;
      for (const child of Object.values(value)) { const result = find(child); if (result) return result; }
      return null;
    }
    const node = find(schema); assert(node); assert.deepEqual(node.properties.queued.type, 'integer');
    assert.equal(node.required.includes('queued'), false); assert.equal(node.additionalProperties, false);
  });
  it('requires explicit finite limits/jitter and preserves typed overload/close', async function () {
    assert.throws(() => cold.create({}), /Explicit bounded/);
    const c = clock(), g = gate(c, 1, 1), held = deferred();
    const one = g.run({}, () => held.promise), two = g.run({}, async () => 2);
    await assert.rejects(g.run({}, async () => 3), { code: 'COLD_START_OVERLOADED' });
    assert.equal(g.tryRun({}, async () => 4), null);
    const cancelled = assert.rejects(two, { code: 'COLD_START_CLOSED' });
    await c.next(); let closed = false; const closing = g.close().then(() => { closed = true; });
    await cancelled; await turn(); assert.equal(closed, false); held.resolve(1); assert.equal(await one, 1); await closing;
    await assert.rejects(g.run({}, async () => 5), { code: 'COLD_START_CLOSED' }); assert.equal(c.size, 0);
  });
  it('preserves FIFO and caller job/tenant scope; fresh arrivals cannot jump waiting work', async function () {
    const c = clock(), g = gate(c, 1, 2), jobs = new AsyncLocalStorage(), seen = [], held = deferred();
    const A = '00000000-0000-0000-0000-000000000001', B = '00000000-0000-0000-0000-000000000002';
    const submit = (id, tenant, wait) => scope.withTenant(tenant, () => jobs.run(id, () => g.run({}, async () => {
      assert.equal(jobs.getStore(), id); assert.equal(scope.currentTenant(), tenant); seen.push(id); if (wait) await held.promise;
    })));
    const calls = [submit(0, A, true), submit(1, B), submit(2, A)]; await c.next(); assert.deepEqual(seen, [0]);
    held.resolve(); await calls[0]; await turn(); calls.push(submit(3, B));
    await c.next(); await c.next(); await c.next(); await Promise.all(calls); assert.deepEqual(seen, [0, 1, 2, 3]);
    assert(c.delays.every(n => n >= 10 && n <= 20)); assert(new Set(c.delays).size > 1); await g.close();
  });
  it('removing FIFO or enqueue context is red, with restored order and scope', async function () {
    async function observe (mutation) {
      const filename = path.resolve(__dirname, '../lib/server/serve/cold-start-admission.js'), m = new Module(filename, module);
      m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
      let source = fs.readFileSync(filename, 'utf8');
      if (mutation === 'fifo') source = source.replace('waiting.shift()', 'waiting.pop()');
      if (mutation === 'context') source = source.replace('AsyncResource.bind(fn)', 'fn');
      m._compile(source, filename);
      const c = clock(), g = m.exports.create({ activeLimit: 1, pendingLimit: 3, minDelayMs: 0, maxDelayMs: 0, random: () => 0, schedule: c.schedule, cancel: c.cancel });
      const jobs = new AsyncLocalStorage(), seen = [];
      const calls = [0, 1, 2].map(id => jobs.run(id, () => scope.withTenant('00000000-0000-0000-0000-000000000001', () => g.run({}, async () => { seen.push([id, jobs.getStore(), scope.currentTenant()]); }))));
      await c.next(); await c.next(); await c.next(); await Promise.all(calls); await g.close(); return seen;
    }
    const expected = [0, 1, 2].map(id => [id, id, '00000000-0000-0000-0000-000000000001']);
    for (const mutation of ['fifo', 'context']) { const value = await observe(mutation); assert.throws(() => assert.deepEqual(value, expected), { code: 'ERR_ASSERTION' }); }
    assert.deepEqual(await observe(null), expected);
  });
  it('bounds direct ensure and the old bypass is red; ready tenant stays outside saturated cold work', async function () {
    async function peak (bypass) {
      const selected = isolated({}, source => bypass ? source.replace('if (coldAdmission) return ensureCold(tenant);', '') : source);
      const c = clock(), g = gate(c, 2, 4), held = deferred(); let active = 0, peak = 0;
      const s = selected.create(['ready', 'a', 'b', 'c', 'd', 'e'], undefined, async tenant => { if (tenant === 'ready') return; active++; peak = Math.max(peak, active); await held.promise; active--; }, options(g));
      const ready = s.ensure('ready'); if (!bypass) await c.next(); await ready;
      const calls = ['a', 'b', 'c', 'd', 'e'].map(t => s.ensure(t).then(() => 'ready', error => { assert.equal(error.code, 'TENANT_WARMING'); return 'queued'; }));
      if (!bypass) { await c.next(); await c.next(); }
      await turn(); const seen = peak; assert.equal(s.isReady('ready'), true); await s.ensure('ready');
      held.resolve(); await Promise.all(calls); await s.close(); await g.close(); return seen;
    }
    const old = await peak(true); assert.equal(old, 5); assert.throws(() => assert.ok(old <= 2), { code: 'ERR_ASSERTION' });
    assert.equal(await peak(false), 2);
  });
  it('gates eligibility and the whole background warm before its window and reports queued/ready honestly', async function () {
    const c = clock(), g = gate(c, 1, 3), held = deferred(); let eligible = 0, initialized = 0;
    const s = startup.create(['a', 'b'], undefined, async () => { initialized++; await held.promise; }, options(g, { concurrency: 2, readiness: 'serve', eligible: async () => { eligible++; return true; } }));
    await s.warm(); await turn(); assert.equal(s.health().queued, 2); assert.equal(eligible, 0); assert.equal(initialized, 0); assert.equal(s.isReady('a'), false);
    await c.next(); assert.equal(eligible, 1); assert.equal(initialized, 1); assert.equal(s.health().warming, 1);
    held.resolve(); await turn(); await c.next(); await s.drained(); assert.equal(eligible, 2); assert.equal(s.health().ready, true); assert.equal(s.health().queued, 0); await s.close(); await g.close();
  });
  it('direct ensure never waits for queued background work needing its already-held window; removing that guard is red', async function () {
    async function observe (broken) {
      const lane = deferred(), c = clock(), g = gate(c), window = {}, entered = deferred(); let initialized = 0;
      const api = isolated({ '../../tenant-lifecycle/operation-window': { isWindow: x => x === window, isSuspension: () => false } }, source => broken ? source.replace("if (cell.pending && cell.state !== 'warming') throw refusal('TENANT_WARMING', retryAfterSeconds);", '') : source);
      window.ready = async () => {}; window.assertCurrent = () => {}; window.run = async (_tenant, fn) => { entered.resolve(); await lane.promise; return fn(); };
      const s = api.create(['a'], window, async () => { initialized++; }, options(g, { readiness: 'serve' }));
      await s.warm(); await c.next(); await entered.promise; let directSettled = false;
      const direct = s.ensure('a').then(() => { directSettled = true; }, error => { assert.equal(error.code, 'TENANT_WARMING'); directSettled = true; });
      await turn(); const safe = directSettled; assert.equal(initialized, 0);
      lane.resolve(); await direct; await s.drained(); await s.close(); await g.close(); return safe;
    }
    assert.equal(await observe(true), false, 'mutant holds the caller lane waiting for itself');
    assert.equal(await observe(false), true, 'restored direct caller refuses before awaiting that lane');
  });
  it('withdraws queued work, preserves active lifetime, cancels close queue and never reopens', async function () {
    const c = clock(), g = gate(c, 1, 3), held = deferred(), seen = [];
    const s = startup.create(['a', 'b'], undefined, async tenant => { seen.push(tenant); if (tenant === 'a') await held.promise; }, options(g, { dynamic: true, readiness: 'serve', concurrency: 2 }));
    await s.warm(); await c.next(); await s.removeTenant('b'); assert.deepEqual(seen, ['a']);
    let stopped = false; const closing = s.close().then(() => { stopped = true; }); await turn(); assert.equal(stopped, false);
    held.resolve(); await closing; assert.deepEqual(seen, ['a']); await assert.rejects(s.ensure('a'), { code: 'COLD_START_CLOSED' }); await g.close(); assert.equal(c.size, 0);
  });
  it('invalidates queued generations without running stale initialization, then resumes fairly', async function () {
    const c = clock(), g = gate(c, 1, 3), held = deferred(), seen = [];
    const s = startup.create(['a', 'b'], undefined, async tenant => { seen.push(tenant); if (tenant === 'a') await held.promise; }, options(g, { readiness: 'serve', concurrency: 2 }));
    await s.warm(); await c.next(); s.invalidateTenant('b'); await turn(); held.resolve(); await turn(); await c.next(); await s.drained();
    assert.deepEqual(seen, ['a', 'b']); assert.equal(s.isReady('b'), true); await s.close(); await g.close();
  });
  it('retains actual window suspension semantics and rejects application code lookalikes in opt-in mode', async function () {
    const fixture = require('./fixtures/operation-window-runtime-protocol');
    const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
    const f = fixture({ phases: { [A]: 'suspended' } }), c = clock(), g = gate(c, 2, 2), seen = [];
    const s = startup.create([A, B], f.window, async tenant => { f.window.assertCurrent(tenant); seen.push(tenant); }, options(g));
    try {
      const warming = s.warm(); await c.next(); await c.next(); assert.deepEqual(await warming, [false, true]);
      assert.deepEqual(seen, [B]); assert.equal(s.isReady(A), false); assert.equal(s.isReady(B), true); assert.equal(s.health().deferred, 1);
    } finally { await s.close(); await g.close(); await f.window.close(); }
    const actual = fixture(), otherClock = clock(), otherGate = gate(otherClock), fake = Object.assign(Error('application failure'), { code: 'LIFECYCLE_WINDOW_SUSPENDED' });
    const refusing = startup.create([A], actual.window, async () => { throw fake; }, options(otherGate));
    try { const warming = assert.rejects(refusing.warm(), error => error === fake); await otherClock.next(); await warming; assert.equal(refusing.isReady(A), false); }
    finally { await refusing.close(); await otherGate.close(); await actual.window.close(); }
  });
  it('passes authority failure unchanged, stays unready and introduces no retry', async function () {
    const c = clock(), g = gate(c), authority = Object.assign(Error('synthetic authority'), { code: 'AUTHORITY_REFUSED' }); let calls = 0;
    const s = startup.create(['a'], undefined, async () => { calls++; throw authority; }, options(g));
    const promise = assert.rejects(s.ensure('a'), error => error === authority); await c.next(); await promise;
    assert.equal(calls, 1); assert.equal(s.isReady('a'), false); assert.equal(s.health().failed, 1); await s.close(); await g.close();
  });
});
