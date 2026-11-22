'use strict';

// Stage lag (M1) and backlog (M2) metrics, and the completion delay control
// (alignment lane mt-plannable-scale-20261121, E3). The actual evaluator
// runtime with in-memory durable hooks, the actual realtime runtime and
// protocol with synthetic sockets, and lib/metrics with NS_METRICS on. No
// PostgreSQL; typed-checkpoint's coveredAt is covered by its integration test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const metrics = require('../lib/metrics');
const startRuntime = require('../lib/server/serve/evaluator-runtime');
const delay = require('../lib/diagnostics/completion-delay');
const scope = require('../lib/storage/tenant-scope');

const A = '11111111-1111-4111-8111-111111111111';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Load a module from source with an optional textual mutation (red controls).
function load (relative, mutate) {
  const file = path.resolve(__dirname, relative), output = { exports: {} };
  const source = fs.readFileSync(file, 'utf8'), changed = mutate ? mutate(source) : source;
  if (mutate && changed === source) throw new Error('Mutation marker must match actual source');
  vm.runInThisContext('(function(require,module,exports,__dirname,__filename){' + changed + '\n})', { filename: file })(
    Module.createRequire(file), output, output.exports, path.dirname(file), file);
  return output.exports;
}
function sample (text, name, labels = {}) {
  for (const line of text.split('\n')) {
    if (!line.startsWith(name + '{') && !line.startsWith(name + ' ')) continue;
    const found = Object.fromEntries([...line.slice(0, line.lastIndexOf(' ')).matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)].map(m => [m[1], m[2]]));
    if (Object.keys(found).length === Object.keys(labels).length && Object.entries(labels).every(([k, v]) => found[k] === v)) return Number(line.slice(line.lastIndexOf(' ') + 1));
  }
  return undefined;
}
const role = 'evaluator+realtime';
const lagCount = (text, stage) => sample(text, stage === 'evaluator' ? 'nightscout_evaluator_completion_lag_seconds_count' : 'nightscout_realtime_frame_lag_seconds_count',
  stage === 'evaluator' ? { role, slice: 'all' } : { role }) || 0;
const lagSum = (text, stage) => sample(text, stage === 'evaluator' ? 'nightscout_evaluator_completion_lag_seconds_sum' : 'nightscout_realtime_frame_lag_seconds_sum',
  stage === 'evaluator' ? { role, slice: 'all' } : { role }) || 0;

// One evaluator with a controllable clock; complete() may report the writer's
// durable mark (coveredAt), refuse, or take real time.
async function evaluator ({ runtimeFactory = startRuntime, coveredAt = () => null, refuse = false, clock, completionDelayMs, realTime = false } = {}) {
  let version = 0;
  const now = realTime ? Date.now : () => clock.now;
  const runtime = await runtimeFactory({ tenants: [A], externalRecovery: true, recoveryIntervalMs: 1000, timeIntervalMs: 60000,
    readCurrent: async tenant => ({ tenant, identity: 'a'.repeat(64) }),
    create: async () => ({ async evaluate () { return { checkpoint: version, properties: {}, emitted: [], requested: [] }; }, close () {} }),
    schedule: () => ({}), cancel () {}, now, ...(completionDelayMs === undefined ? {} : { completionDelayMs }),
    durable: { pendingMs: 600000, async begin () { return { clock: String(version) }; },
      async complete (tenant, { result, identity }) {
        if (refuse) throw new Error('EVALUATOR_COMPLETION_REFUSED_FOR_TEST');
        return { changed: true, pendingAt: null, coveredAt: coveredAt(), output: { tenant, identity, outputRevision: ++version, contentDigest: 'b'.repeat(64), result } };
      } } });
  return runtime;
}

describe('stage lag and backlog metrics (M1, M2) and the completion delay control', function () {
  this.timeout(20000);
  beforeEach(() => metrics.configure(['evaluator', 'realtime'], { NS_METRICS: 'true' }));
  afterEach(() => metrics.reset());

  it('buckets resolve 1 s and 30 s and reach past the 120 s deadline', function () {
    for (const edge of [1, 30, 120]) assert.ok(metrics.LAG_BUCKETS.includes(edge), 'BUCKET ' + edge);
    assert.ok(Math.max(...metrics.LAG_BUCKETS) > 120);
  });

  it('M1 evaluator: one observation of completion minus the oldest covered input, per covering completion', async function () {
    const clock = { now: 10000 };
    const runtime = await evaluator({ clock });
    try {
      await runtime.acquire(A); // first acquisition: nothing pending, nothing observed
      let text = await metrics.current.text();
      assert.equal(lagCount(text, 'evaluator'), 0, 'OBSERVED_WITHOUT_PENDING_INPUT');
      runtime.markPending(A, clock.now); clock.now += 1000; runtime.markPending(A, clock.now); clock.now += 1500;
      await runtime.acquire(A);
      text = await metrics.current.text();
      assert.equal(lagCount(text, 'evaluator'), 1);
      assert.equal(lagSum(text, 'evaluator'), 2.5, 'LAG_IS_COMPLETION_MINUS_OLDEST_MARK');
      assert.equal(sample(text, 'nightscout_evaluator_completion_lag_seconds_bucket', { role, slice: 'all', le: '2' }), 0);
      assert.equal(sample(text, 'nightscout_evaluator_completion_lag_seconds_bucket', { role, slice: 'all', le: '5' }), 1);
      assert.equal(sample(text, 'nightscout_stage_lag_negative_total', { role, stage: 'evaluator' }) || 0, 0);
    } finally { await runtime.close(); }
  });

  it('M1 evaluator: the writer\'s older durable mark (coveredAt) wins over the hint receipt', async function () {
    const clock = { now: 50000 };
    const runtime = await evaluator({ clock, coveredAt: () => 20000 });
    try {
      await runtime.acquire(A);
      runtime.markPending(A, 45000);
      await runtime.acquire(A);
      const text = await metrics.current.text();
      // The first acquisition covered nothing in memory but reported the durable mark too.
      assert.equal(lagCount(text, 'evaluator'), 2);
      assert.equal(lagSum(text, 'evaluator'), 60, 'DURABLE_MARK_IGNORED');
    } finally { await runtime.close(); }
  });

  it('red control: no observation when the completion is refused', async function () {
    const clock = { now: 10000 };
    const runtime = await evaluator({ clock, refuse: true });
    try {
      runtime.markPending(A, clock.now); clock.now += 3000;
      await runtime.acquire(A).catch(() => {});
      const text = await metrics.current.text();
      assert.equal(lagCount(text, 'evaluator'), 0, 'OBSERVED_WITHOUT_COMPLETION');
      assert.equal(runtime.pendingSummary().pending, 1, 'REFUSED_COMPLETION_STAYS_PENDING');
    } finally { await runtime.close(); }
  });

  it('red control: a reversed sign is caught (observed as 0 and counted, sum wrong)', async function () {
    const broken = load('../lib/server/serve/evaluator-runtime.js', source => source.replace("metrics.lag('evaluator',now()-covered)", "metrics.lag('evaluator',covered-now())"));
    const clock = { now: 10000 };
    const runtime = await evaluator({ runtimeFactory: broken, clock });
    try {
      runtime.markPending(A, clock.now); clock.now += 2500;
      await runtime.acquire(A);
      const text = await metrics.current.text();
      assert.equal(lagCount(text, 'evaluator'), 1);
      assert.notEqual(lagSum(text, 'evaluator'), 2.5, 'SIGN_CONTROL_BLIND');
      assert.equal(sample(text, 'nightscout_stage_lag_negative_total', { role, stage: 'evaluator' }), 1, 'NEGATIVE_NOT_COUNTED');
    } finally { await runtime.close(); }
  });

  it('is off by default: the runtime observes nothing and the hook is a no-op', async function () {
    metrics.reset();
    assert.equal(metrics.current.enabled, false);
    assert.equal(metrics.current.lag, metrics.current.realtime, 'off hooks are the shared no-op');
    const clock = { now: 10000 };
    const runtime = await evaluator({ clock });
    try { runtime.markPending(A, clock.now); clock.now += 1000; await runtime.acquire(A); } finally { await runtime.close(); }
    assert.equal(await metrics.current.text(), '');
  });

  it('no tenant label on the new series; control: a tenant label is caught by the guard', async function () {
    const instance = metrics.create({ roles: ['evaluator', 'realtime'] });
    instance.lag('evaluator', 1500); instance.lag('realtime', 200); instance.lag('evaluator', -5);
    instance.realtimePending(() => ({ pending: 1, oldestAgeMs: 10 }));
    const clean = await instance.text();
    instance.register.clear();
    assert.match(clean, /^nightscout_evaluator_completion_lag_seconds_bucket\{/m);
    assert.match(clean, /^nightscout_realtime_frame_lag_seconds_bucket\{/m);
    assert.match(clean, /^nightscout_realtime_pending_oldest_age_seconds\{/m);
    assert.equal(clean.includes(A), false, 'TENANT_ID_IN_LABEL');
    assert.equal(clean.split('\n').some(line => /tenant="/.test(line)), false, 'TENANT_LABEL');
    const broken = load('../lib/metrics/index.js', source => source
      .replace("labelNames: ['slice'], buckets: LAG_BUCKETS })", "labelNames: ['slice', 'tenant'], buckets: LAG_BUCKETS })")
      .replace("series.evaluator.labels(slice).observe(", "series.evaluator.labels(slice, '" + A + "').observe("));
    const leaky = broken.create({ roles: ['evaluator'] });
    leaky.lag('evaluator', 1500);
    const text = await leaky.text();
    leaky.register.clear();
    assert.ok(text.split('\n').some(line => /tenant="/.test(line)) && metrics.tenantLike(A), 'GUARD_BLIND');
  });

  it('M1 realtime: drain notice to frame sent, only when a frame is sent; M2 realtime backlog while publishing', async function () {
    const mode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    const protocolFactory = require('../lib/server/realtime/protocol');
    const runtimeFactory = require('../lib/server/realtime/runtime');
    class Socket extends EventEmitter {
      constructor () { super(); this.request = { headers: { host: 'a.test' }, rawHeaders: ['Host', 'a.test'], socket: {} }; this.sent = []; this.rooms = new Set(['self']); this.id = 'self'; }
      emit (event, value) { this.sent.push({ event, value }); return true; }
      async receive (event, ...args) { return Promise.all(this.listeners(event).map(fn => fn(...args))); }
      join (name) { this.rooms.add(name); } leave (name) { this.rooms.delete(name); }
      disconnect () { super.emit('disconnect'); }
    }
    const env = require('../lib/server/tenant-app/environment')({ settings: { enable: ['bgnow'] } });
    let writes = 0, visible = 0, acquireMs = 0, runtime, watched = true, backlog = null;
    const readCurrent = async tenant => ({ tenant, identity: 'same', env });
    const protocol = protocolFactory.create({ admission: { resolve: async () => A }, readCurrent, runtime: () => runtime, domains: ['entries'],
      api: { executeSocketMutation: async () => ({}), authorizeSocket: async () => ({ permissions: { read: true, write: false, write_treatment: false, ack: false }, collections: ['entries'] }) },
      authorizationRecheckMs: 60000, retry: { minMs: 5, maxMs: 40 } });
    runtime = await runtimeFactory({ tenants: [A], readCurrent, retryMs: 60000, concurrency: 2, schedule: () => 1, cancel () {},
      watchedTenants: () => watched ? [A] : [],
      detect: async list => new Map(list.map(t => [t, { stamp: String(writes), identity: 'same' }])),
      create: () => ({ async acquire () {
        if (acquireMs) { backlog = runtime.pendingSummary(); await sleep(acquireMs); }
        return { tenant: A, checkpoint: writes, rows: [], frame: { delta: false, lastUpdated: Date.now(), sgvs: Array.from({ length: visible }, (_, i) => ({ mgdl: 100 + i, mills: 1000 + i })) } };
      } }), fanout: protocol.fanout });
    try {
      const socket = new Socket(); await protocol.prepare(socket); protocol.bind(socket, '/');
      await socket.receive('authorize', { secret: 'synthetic' });
      for (let i = 0; i < 100 && !socket.sent.some(r => r.event === 'dataUpdate'); i++) await sleep(5);
      let text = await metrics.current.text();
      assert.equal(lagCount(text, 'realtime'), 0, 'PRIMING_FRAME_HAS_NO_NOTICE');
      writes++; visible++; acquireMs = 200;
      await runtime.check([A]);
      text = await metrics.current.text();
      assert.equal(lagCount(text, 'realtime'), 1, 'FRAME_SENT_NOT_OBSERVED');
      assert.ok(lagSum(text, 'realtime') >= 0.19 && lagSum(text, 'realtime') < 5, 'LAG ' + lagSum(text, 'realtime'));
      assert.equal(backlog.pending, 1, 'PUBLISHING_NOTICE_IS_BACKLOG');
      assert.equal(runtime.pendingSummary().pending, 0, 'PUBLISHED_NOTICE_SETTLED');
      // A new stamp whose view is unchanged: the fanout runs, sends no frame, observes nothing.
      acquireMs = 0; writes++; await runtime.check([A]);
      text = await metrics.current.text();
      assert.equal(lagCount(text, 'realtime'), 1, 'OBSERVED_WITHOUT_FRAME');
      assert.equal(runtime.pendingSummary().pending, 0, 'UNCHANGED_NOTICE_STUCK');
      // No viewer: the notice settles without a frame.
      watched = false; writes++; await runtime.check([A]);
      assert.equal(runtime.pendingSummary().pending, 0, 'UNWATCHED_NOTICE_STUCK');
    } finally { protocol.close(); await runtime.close(); scope.setTenancyMode(mode); }
  });

  it('control: a fixed completion delay shows in M1 and raises M2 while it holds', async function () {
    assert.equal(delay.fromEnvironment({}), 0);
    assert.equal(delay.fromEnvironment({ [delay.KEY]: '0' }), 0);
    for (const bad of ['-1', '1.5', 'x', '120001']) assert.throws(() => delay.fromEnvironment({ [delay.KEY]: bad }), /must be an integer/);
    await assert.rejects(evaluator({ realTime: true, completionDelayMs: -1 }), /completion delay/);
    const runtime = await evaluator({ realTime: true, completionDelayMs: 400 });
    try {
      runtime.markPending(A, Date.now());
      const cycle = runtime.acquire(A);
      await sleep(250);
      const during = runtime.pendingSummary();
      assert.equal(during.pending, 1, 'M2_PENDING_DURING_DELAY');
      assert.ok(during.oldestAgeMs >= 200, 'M2_AGE_RISES ' + during.oldestAgeMs);
      await cycle;
      const text = await metrics.current.text();
      assert.equal(lagCount(text, 'evaluator'), 1);
      assert.ok(lagSum(text, 'evaluator') >= 0.38, 'M1_SHOWS_DELAY ' + lagSum(text, 'evaluator'));
      assert.equal(runtime.pendingSummary().pending, 0);
    } finally { await runtime.close(); }
  });
});
