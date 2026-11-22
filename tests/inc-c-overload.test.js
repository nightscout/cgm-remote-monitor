'use strict';

// Lane INC-C (#8898 round, 2026-11-22): the overload inputs. Every switch is
// off unless set (lib/server/serve/overload-switches.js). The one-select ACK
// race against actual PostgreSQL is in tenant-notifications.integration.test.js.
// covers: lib/server/serve/overload-switches.js
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const switches = require('../lib/server/serve/overload-switches');
const startRuntime = require('../lib/server/serve/evaluator-runtime');
const scope = require('../lib/storage/tenant-scope');
const metrics = require('../lib/metrics');

const A = '11111111-1111-4111-8111-111111111111';

describe('INC-C overload switches', function () {
  it('every switch is off unless set, and refuses anything but its values', function () {
    assert.equal(switches.oneSelect({}), false); assert.equal(switches.oneSelect({ NS_CONSUMER_ONE_SELECT: ' TRUE ' }), true);
    assert.throws(() => switches.oneSelect({ NS_CONSUMER_ONE_SELECT: '1' }), /NS_CONSUMER_ONE_SELECT/);
    assert.equal(switches.timeOnlyCoalesce({}), false); assert.equal(switches.timeOnlyCoalesce({ NS_EVAL_TIME_ONLY_COALESCE: 'true' }), true);
    assert.throws(() => switches.timeOnlyCoalesce({ NS_EVAL_TIME_ONLY_COALESCE: 'yes' }), /NS_EVAL_TIME_ONLY_COALESCE/);
    assert.equal(switches.evaluationFirst({}), false); assert.equal(switches.evaluationFirst({ NS_EVAL_PRIORITY: 'arrival' }), false);
    assert.equal(switches.evaluationFirst({ NS_EVAL_PRIORITY: 'evaluation-first' }), true);
    assert.throws(() => switches.evaluationFirst({ NS_EVAL_PRIORITY: 'first' }), /NS_EVAL_PRIORITY/);
    assert.equal(switches.outboxPool(2, {}), 2); assert.equal(switches.outboxPool(2, { NS_OUTBOX_POOL: '8' }), 8);
    for (const bad of ['0', '65', '2.5', 'x']) assert.throws(() => switches.outboxPool(2, { NS_OUTBOX_POOL: bad }), /NS_OUTBOX_POOL/);
  });
});

// NS_EVAL_TIME_ONLY_COALESCE over the shipping level component and the quiet
// (stale-data) and aaps (device ages) replay timelines. At a minute with new
// input a due tick and an acquisition are both queued; at every other minute
// only the tick. The published content (evaluator-runtime CONTENT) after every
// minute is compared byte for byte between the switch off and on.
describe('INC-C time-only coalescing: differential at time-only instants', function () {
  this.timeout(600000);
  const { TIMELINES, MIN, HOUR } = require('./lib/views-replay/timelines');
  const clock = require('./lib/views-replay/clock');
  const policy = require('../lib/storage/clinical-working-set-policy');
  const { decodeDocument } = require('../lib/storage/postgres-identity');
  const makeEvaluator = require('../lib/data/tenant-projection-evaluator');
  const makeEnv = require('../lib/server/tenant-app/environment');
  const identity = 'e'.repeat(64);
  const AGES = ['sage', 'cage', 'iage', 'bage'];
  const env = () => makeEnv({ settings: { enable: ['bgnow', 'delta', 'direction', 'rawbg', 'iob', 'cob', 'profile', 'basal', 'pump', 'openaps', 'loop', 'timeago',
    'simplealarms', 'devicestatus', 'careportal', 'bwp', 'ar2', ...AGES, 'upbat'], thresholds: { bgHigh: 200, bgTargetTop: 180, bgTargetBottom: 80, bgLow: 55 } },
  extendedSettings: Object.fromEntries(['timeago', ...AGES].map(name => [name, { enableAlerts: true }])) });
  function uploadedAt (domain, d) {
    if (d._uploadAt != null) return Number(d._uploadAt);
    if (domain === 'entries') return Number(d.date) || Date.parse(d.dateString);
    if (domain === 'profile') return Date.parse(d.created_at) || Date.parse(d.startDate) || Number(d.mills);
    return Date.parse(d.created_at) || Number(d.mills);
  }
  // One arm: its own store, component and runtime.
  async function arm (timeline, coalesce, runtimeFactory = startRuntime) {
    const queue = Object.entries(timeline.records).flatMap(([domain, records]) => records.map((value, i) => {
      const doc = JSON.parse(JSON.stringify(value)), at = uploadedAt(domain, doc); delete doc._uploadAt; doc._id = domain + '-' + i;
      return { at: Number.isFinite(at) ? at : timeline.start, domain, id_kind: 'string', doc };
    })).sort((a, b) => a.at - b.at);
    const rows = []; let cursor = 0, stamp = 0;
    const replay = { level: true, async reconcile () { throw new Error('Expected level snapshot'); }, async window (options) {
      const selected = policy.select(rows, options.policy);
      return { checkpoint: stamp, progress: 'level-window', signature: { stamp, deleted: 0 }, generation: '1', policy: options.policy,
        expiresAt: policy.nextExpiry(selected, options.policy),
        rows: selected.map(r => ({ domain: r.domain, ordinal: r.ordinal, document: decodeDocument({ id_kind: r.id_kind, doc: structuredClone(r.doc) }) })) };
    } };
    const advance = at => { const prior = cursor; while (cursor < queue.length && queue[cursor].at <= at) { const { domain, doc, id_kind } = queue[cursor++]; rows.push({ domain, doc, id_kind, ordinal: cursor }); } if (cursor !== prior) stamp = at; return cursor !== prior; };
    advance(timeline.start);
    const runtime = await runtimeFactory({ tenants: [A], readCurrent: async () => ({ tenant: A, identity, env: env() }),
      create: async () => makeEvaluator({ tenant: A, env: env(), language: require('../lib/language')(), maxRows: 10000, maxBytes: 8388608, includeFrame: true,
        dbstats: async () => ({}), connection: { async query () { throw new Error('Expected in-process reads'); } }, replay }),
      recoveryIntervalMs: 3600000, timeIntervalMs: 60000, schedule: () => ({}), cancel () {}, setTimer: () => ({}), clearTimer () {}, now: () => Date.now(),
      coalesceTimeOnly: coalesce });
    return { runtime, advance };
  }
  const content = runtime => JSON.stringify(startRuntime.canonical(Object.fromEntries(startRuntime.CONTENT.map(key => [key, runtime.last(A)?.result?.[key]]))));
  async function differential (timeline, { end = timeline.end, factory } = {}) {
    clock.install(); const mode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    const arms = [];
    try {
      clock.pin(timeline.start);
      const off = await arm(timeline, false), on = await arm(timeline, true, factory); arms.push(off, on);
      let minutes = 0, changed = 0, differing = 0; const plugins = new Set(), firstDifference = [];
      for (let at = timeline.start + MIN; at <= end; at += MIN) {
        clock.pin(at); minutes++;
        const fresh = [off, on].map(a => a.advance(at))[0];
        if (fresh) changed++;
        // Both queued before the drain enters: the tick, then the acquisition.
        await Promise.all([off, on].map(a => fresh ? Promise.all([a.runtime.tick(A), a.runtime.acquire(A)]) : a.runtime.tick(A)));
        const left = content(off.runtime), right = content(on.runtime);
        if (left !== right) { differing++; if (firstDifference.length < 3) firstDifference.push(at - timeline.start); }
        for (const row of [...(off.runtime.last(A)?.result?.requested || []), ...(off.runtime.last(A)?.result?.emitted || [])]) if (row?.plugin?.name) plugins.add(row.plugin.name);
      }
      const health = [off, on].map(a => a.runtime.health([A]));
      return { minutes, changed, differing, firstDifference, plugins, cycles: health.map(h => h.tenants[0].cycles), coalesced: health.map(h => h.wake.coalescedTime) };
    } finally {
      for (const a of arms) await a.runtime.close();
      scope.setTenancyMode(mode); clock.uninstall();
    }
  }
  const timeOnlyDropped = () => {
    const file = require.resolve('../lib/server/serve/evaluator-runtime'), module = { exports: {} };
    const text = fs.readFileSync(file, 'utf8');
    const needle = "if (coalesceTimeOnly && !acquisition && state[acquireKey]?.parent === parent) {\n      counters.coalescedTime++; pump(state, parent); return state[acquireKey].promise;";
    assert(text.includes(needle));
    vm.runInThisContext('(function(require,module,exports){' + text.replace(needle, 'if (coalesceTimeOnly && !acquisition) {\n      counters.coalescedTime++; return state[acquireKey]?.promise || Promise.resolve();') + '\n})', { filename: file })(createRequire(file), module, module.exports);
    return module.exports;
  };

  it('quiet: identical content at every minute; stale-data alarms covered; only queued-beside-acquisition ticks skipped', async function () {
    const r = await differential(TIMELINES.quiet());
    assert.equal(r.differing, 0, 'COALESCED_CONTENT_DIFFERS at minutes ' + r.firstDifference.map(ms => ms / MIN).join(','));
    assert(r.plugins.has('timeago'), 'STALE_DATA_ALARM_COVERED');
    assert.equal(r.cycles[0] - r.cycles[1], r.coalesced[1], 'one cycle fewer per coalesced tick');
    assert(r.coalesced[1] > 0 && r.coalesced[1] <= r.changed, 'ticks skipped only beside a queued acquisition');
    assert.equal(r.coalesced[0], 0, 'SWITCH_OFF_UNCHANGED');
    assert.equal(r.cycles[1], r.minutes + 1, 'every minute ran exactly one cycle with the switch on (plus boot)');
    this.test.title += ' [' + JSON.stringify({ minutes: r.minutes, changed: r.changed, cycles: r.cycles, coalesced: r.coalesced[1] }) + ']';
  });

  it('aaps (first 16 h): identical content at every minute; device-age alarms covered', async function () {
    const timeline = TIMELINES.aaps();
    const r = await differential(timeline, { end: timeline.start + 16 * HOUR });
    assert.equal(r.differing, 0, 'COALESCED_CONTENT_DIFFERS at minutes ' + r.firstDifference.map(ms => ms / MIN).join(','));
    assert(AGES.some(name => r.plugins.has(name)), 'DEVICE_AGE_ALARM_COVERED: ' + [...r.plugins].join(','));
    assert(r.coalesced[1] > 0);
    this.test.title += ' [' + JSON.stringify({ minutes: r.minutes, changed: r.changed, cycles: r.cycles, coalesced: r.coalesced[1], plugins: [...r.plugins].sort() }) + ']';
  });

  it('control: dropping a tick with no acquisition queued is red (stale-data alarm late)', async function () {
    const r = await differential(TIMELINES.quiet(), { factory: timeOnlyDropped() });
    assert(r.differing > 0, 'CONTROL_BLIND');
  });
});

describe('INC-C evaluation-first consumer passes', function () {
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));
  const consumers = require('../lib/server/serve/evaluator-consumers');
  const fixture = require('./fixtures/tenant-notifications');
  // Manual turns: `delay` records the turn callback; the test runs it.
  function coordinator ({ evaluationFirst, backlog }) {
    const f = fixture(), turns = [];
    const value = consumers.coordinate({ tenants: [f.A, f.B], route: 'incc', current: async () => null, currentConfig: async tenant => ({ tenant, identity: 'config' }),
      isCurrent: async () => true, store: f.store, reader: { read: async () => [], allows: async () => true },
      adapter: { id: 'incc', send: (row, callback) => callback(null, { accepted: true }) }, schedule: () => 0, cancel: () => {},
      delay: fn => { turns.push(fn); return turns.length; }, undelay: () => {},
      pollIntervalMs: 1000, retryIntervalMs: 1000, maxRows: 10, maxBytes: 65536, maxPayloadBytes: 10000, maxInflight: 1, attemptTimeoutMs: 1000, retryDelayMs: 1,
      maxConcurrentTenants: 1, evaluationFirst, evaluatorBacklog: () => backlog.value });
    return { f, value, turns };
  }
  const settle = () => new Promise(resolve => setImmediate(resolve));

  it('off: passes run at once whatever the evaluator owes', async function () {
    const backlog = { value: 5 }; const { f, value, turns } = coordinator({ evaluationFirst: false, backlog });
    try { value.start(); await value.flush(f.A); await value.flush(f.B); assert.equal(value.health().tenants.every(t => t.passes === 1), true); assert.equal(turns.length, 0); assert.equal('passesHeld' in value.health(), false); }
    finally { await value.close(); }
  });
  it('on: with a backlog, passes wait; each turn admits a bounded share; none is dropped; with no backlog a turn admits all', async function () {
    const backlog = { value: 5 }; const { f, value, turns } = coordinator({ evaluationFirst: true, backlog });
    try {
      value.start(); await settle(); await settle();
      const passes = () => value.health().tenants.map(t => t.passes);
      assert.deepEqual(passes(), [0, 0], 'EVALUATION_FIRST_HOLDS_PASSES');
      // One turn under backlog: maxConcurrentTenants (1) admitted.
      turns.shift()(); await settle(); await settle();
      assert.equal(passes().reduce((a, b) => a + b), 1, 'BOUNDED_SHARE_PER_TURN');
      // A hint for a held tenant coalesces into its held pass; nothing is dropped.
      const held = value.health().tenants.find(t => t.passes === 0).tenant;
      const hinted = value.hint(held);
      backlog.value = 0; while (turns.length) { turns.shift()(); await settle(); await settle(); }
      await hinted; await value.flush(f.A); await value.flush(f.B);
      assert.deepEqual(passes().map(n => n >= 1), [true, true], 'NO_PASS_DROPPED');
      assert(value.health().passesHeld >= 2);
    } finally { await value.close(); }
  });
});

describe('INC-C instruments', function () {
  it('notification-delivery and time-driven alarm lag carry no tenant label', async function () {
    const instance = metrics.create({ roles: ['evaluator'] });
    instance.evaluator(() => ({ tenants: 1, pending: 0, queued: 0, oldestAgeMs: 0, residents: 1 }));
    instance.lag('notification', 2500); instance.lag('alarm', 800); instance.lag('alarm', -3);
    const text = await instance.text(); instance.register.clear();
    assert.match(text, /^nightscout_notification_delivery_lag_seconds_bucket\{.*slice=/m);
    assert.match(text, /^nightscout_alarm_time_lag_seconds_count\{.*slice="all"\} 2$/m);
    assert.equal(text.split('\n').some(line => /tenant="/.test(line)), false, 'TENANT_LABEL');
  });
  it('the runtime observes alarm lag once per due instant, not for the slow timer', async function () {
    const observed = [];
    let at = 1000000; const due = { reason: 'timeago', slow: [] };
    const runtime = await startRuntime({ tenants: [A], readCurrent: async () => ({ tenant: A, identity: 'f'.repeat(64) }),
      create: async () => ({ evaluate: async ({ at: now }) => ({ checkpoint: 1, progress: null, now, emitted: [], requested: [], properties: {}, due: { ...due, dueAt: now + 60000 } }),
        evaluateTime: async ({ at: now }) => ({ checkpoint: 1, progress: null, now, emitted: [], requested: [], properties: {}, due: { reason: 'slow', slow: ['x'], dueAt: Infinity } }), close () {} }),
      recoveryIntervalMs: 1000, timeIntervalMs: 120000, schedule: () => ({}), cancel () {}, setTimer: () => ({}), clearTimer () {}, now: () => at });
    const lagged = require('../lib/metrics');
    const saved = Object.getOwnPropertyDescriptor(lagged, 'lag');
    Object.defineProperty(lagged, 'lag', { configurable: true, writable: true, value: (stage, ms) => observed.push([stage, ms]) });
    try {
      at += 61000; await runtime.tick(A); // 1 s after the due instant
      at += 1000; await runtime.tick(A); // armed on the slow timer now: no observation
      assert.deepEqual(observed.filter(([stage]) => stage === 'alarm'), [['alarm', 1000]]);
    } finally { Object.defineProperty(lagged, 'lag', saved); await runtime.close(); }
  });
});
