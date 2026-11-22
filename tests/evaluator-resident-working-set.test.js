'use strict';

// Differential check of the resident working set (switch
// NS_EVAL_RESIDENT_WORKING_SET, lib/data/resident-working-set.js).
//
// Two shipping level components read identical stores through the resident
// window (tests/lib/resident-window/memory-replay.js), one with the switch
// on and one with it off. Every cycle result must be the same text: every
// clinical field, alarm, the browser frame and the due instant.
//
//   - the synthetic views-equality scenarios under two plugin sets, five
//     cycles each (acquisition, three time-only, acquisition with a new
//     reading);
//   - the quiet replay timeline minute by minute (1,201 minutes), with
//     device statuses continuing and, on the way: an edited, a deleted, a
//     back-dated and a re-timed status; back-dated, edited and deleted
//     treatments; a back-dated and a deleted reading; a profile change; a
//     restore (new generation); a settings change; an eviction; a window
//     time that is not canonical; a status the loader's order is not total
//     for; and a wall clock ahead of the instant.
//
// Controls: three deliberately wrong delta steps (a changed status keeps its
// resident copy, a new status is not placed, the placed statuses are not
// ordered) must each be detected by the same comparison.
const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const evaluator = require('../lib/data/tenant-projection-evaluator');
const residentSet = require('../lib/data/resident-working-set');
const environment = require('../lib/server/tenant-app/environment');
const memory = require('./lib/resident-window/memory-replay');
const clock = require('./lib/views-replay/clock');
const brokenModule = require('./lib/clinical-working-set/control');
const { SCENARIOS, MIN, HOUR } = require('./lib/views-equality/fixtures');
const { TIMELINES } = require('./lib/views-replay/timelines');

const TENANT = '11111111-1111-4111-8111-111111111111';
const THRESHOLDS = { bgHigh: 200, bgTargetTop: 180, bgTargetBottom: 80, bgLow: 55 };
const LOOP = ['bgnow', 'delta', 'direction', 'rawbg', 'iob', 'cob', 'profile', 'basal', 'pump', 'openaps', 'loop', 'timeago', 'simplealarms', 'devicestatus',
  'careportal', 'bwp', 'ar2', 'sage', 'cage', 'iage', 'bage', 'upbat'];
const ENVS = {
  loop: (thresholds = THRESHOLDS) => environment({ settings: { enable: LOOP, thresholds } }),
  defaults: (thresholds = THRESHOLDS) => environment({ settings: { thresholds } })
};
const iso = ms => new Date(ms).toISOString();
const copy = value => JSON.parse(JSON.stringify(value));

// Two arms over identical stores: the resident working set on, and off.
function arms (envOf, levers, { factory = evaluator, shape } = {}) {
  const make = residentWorkingSet => {
    const db = memory({ tenant: TENANT, generation: '1', resident: true, checkMs: 86400000, shape });
    const component = () => (residentWorkingSet ? factory : evaluator)({ tenant: TENANT, replay: db.replay, env: envOf(), language: require('../lib/language')(), includeFrame: true, levers, residentWorkingSet,
      connection: { async query () { throw new Error('No SQL: the views read in process'); } }, dbstats: async () => ({}), maxRows: 10000, maxBytes: 8388608 });
    return { db, component: component() };
  };
  const pair = { on: make(true), off: make(false), cycles: 0 };
  pair.each = fn => { for (const arm of [pair.on, pair.off]) fn(arm); };
  pair.write = (changes, options) => pair.each(arm => arm.db.write(changes, options));
  pair.close = () => pair.each(arm => arm.component.close());
  return pair;
}

// One cycle on both arms at one instant; wall: the wall clock, when it is not the instant.
async function cycle (pair, at, { time = false, wall = at, label } = {}) {
  clock.pin(wall);
  const out = [];
  for (const arm of [pair.on, pair.off]) {
    const observed = arm.db.begin();
    out.push(JSON.stringify(await scope.withTenant(TENANT, () => time ? arm.component.evaluateTime({ at }) : arm.component.evaluate({ at }))));
    arm.db.complete(observed);
  }
  pair.cycles += 1;
  assert.equal(out[0], out[1], label + ': the resident working set gives the full rebuild\'s cycle result, byte for byte');
  return JSON.parse(out[0]);
}

const row = (domain, doc) => ({ domain, id_kind: 'string', doc });
const gone = (domain, id) => ({ domain, id_kind: 'string', _id: id, remove: true });
const reading = (id, sgv, date) => row('entries', { _id: id, type: 'sgv', sgv, date, dateString: iso(date), direction: 'Flat', device: 'synthetic' });
const status = (id, at, battery = 70) => row('devicestatus', { _id: id, device: 'openaps://synthetic', created_at: iso(at), uploaderBattery: battery,
  pump: { clock: iso(at), reservoir: 80, battery: { percent: 60 }, status: { status: 'normal', bolusing: false } },
  openaps: { iob: { iob: 1.2, basaliob: 0.4, activity: 0.01, time: iso(at) },
    suggested: { bg: 140, eventualBG: 150, temp: 'absolute', rate: 0.8, duration: 30, reason: 'synthetic', timestamp: iso(at) },
    enacted: { bg: 140, temp: 'absolute', rate: 0.8, duration: 30, received: true, reason: 'synthetic', timestamp: iso(at) } } });

// The replay with its mutations; returns the cycles compared.
async function replay ({ minutes, levers }) {
  const timeline = TIMELINES.quiet();
  let thresholds = THRESHOLDS;
  const pair = arms(() => ENVS.loop(thresholds), levers);
  const uploadedAt = (domain, d) => d._uploadAt != null ? Number(d._uploadAt)
    : domain === 'entries' ? Number(d.date) : Date.parse(d.created_at) || Date.parse(d.startDate) || timeline.start;
  const queue = Object.entries(timeline.records).flatMap(([domain, records]) => records.map((value, i) => {
    const doc = copy(value), at = uploadedAt(domain, doc);
    delete doc._uploadAt;
    doc._id = domain + '-' + i;
    return { at: Number.isFinite(at) ? at : timeline.start, change: row(domain, doc) };
  })).sort((a, b) => a.at - b.at);
  const t0 = timeline.start, m = n => t0 + n * MIN;
  // What changes on the way, by minute. Device statuses continue every 5 minutes for 16 h.
  const plan = new Map();
  const on = (minute, changes, how) => plan.set(minute, (plan.get(minute) || []).concat([{ changes, how }]));
  for (let n = 5; n <= 960; n += 5) on(n, () => [status('s-' + n, m(n))]);
  on(200, () => [status('s-195', m(195), 12)]); // edited: same id and time, other content
  on(232, () => [gone('devicestatus', 's-225')]);
  on(261, () => [gone('devicestatus', 's-260')]); // the newest
  on(300, () => [row('treatments', { _id: 't-late-meal', eventType: 'Meal Bolus', created_at: iso(m(300) - 3 * HOUR), carbs: 40, insulin: 4 }),
    row('treatments', { _id: 't-late-basal', eventType: 'Temp Basal', created_at: iso(m(300) - 90 * MIN), duration: 60, absolute: 1.4 })]);
  on(360, () => [row('treatments', { _id: 't-late-meal', eventType: 'Meal Bolus', created_at: iso(m(300) - 3 * HOUR), carbs: 25, insulin: 2.5 })]);
  on(420, () => [gone('treatments', 't-late-meal')]);
  on(440, () => [row('treatments', { _id: 't-site', eventType: 'Site Change', created_at: iso(m(440) - 20 * HOUR) })]);
  on(481, () => [status('s-late', m(481) - 2 * HOUR, 55), reading('e-late', 91, m(481) - 40 * MIN)]);
  on(520, () => [status('s-515', m(430))]); // re-timed: same id, an earlier time
  on(541, () => [gone('entries', 'e-late'), gone('treatments', 't-site')]);
  on(560, () => [row('profile', { ...copy(timeline.records.profile[0]), _id: 'profile-2', startDate: iso(m(560)), created_at: iso(m(560)) })]);
  on(600, null, 'restore');
  on(700, null, 'settings');
  on(760, null, 'evict');
  on(820, () => [row('devicestatus', { ...status('s-odd', m(820)).doc, created_at: iso(m(820)).replace('.000Z', 'Z') })]); // not canonical
  on(850, () => [gone('devicestatus', 's-odd')]);
  on(870, () => [row('devicestatus', { ...status('s-unordered', m(870)).doc, mills: 'x' })]); // no total order: every status is prepared again
  on(890, () => [gone('devicestatus', 's-unordered')]);
  try {
    let cursor = 0;
    for (let n = 0; n <= minutes; n++) {
      const at = m(n);
      let changed = n === 0;
      const changes = [];
      while (cursor < queue.length && queue[cursor].at <= at) changes.push(queue[cursor++].change);
      for (const step of plan.get(n) || []) {
        if (step.how === 'restore') {
          // A restore: the generation moves and the data is replaced without a window mark.
          pair.each(arm => { arm.db.state.generation = '2'; arm.db.write([gone('devicestatus', 's-590'), status('s-585', m(585), 33)], { at, aware: false });
            arm.db.work.version = String(BigInt(arm.db.work.version || 0) + 1n); });
          changed = true;
        } else if (step.how === 'settings') {
          thresholds = { ...THRESHOLDS, bgHigh: 220, bgLow: 65 };
          for (const arm of [pair.on, pair.off]) await scope.withTenant(TENANT, async () => arm.component.reconfigure({ env: ENVS.loop(thresholds) }));
          changed = true;
        } else if (step.how === 'evict') {
          for (const arm of [pair.on, pair.off]) await scope.withTenant(TENANT, async () => arm.component.evict());
          changed = true;
        } else changes.push(...step.changes());
      }
      if (changes.length) { pair.write(changes, { at, exact: n !== 0 }); changed = true; }
      // From 16 h 40 min the wall clock runs 90 s ahead of the instant (the cache's retention is by the wall clock).
      await cycle(pair, at, { time: !changed, wall: n >= 1000 && n < 1060 ? at + 90000 : at, label: 'minute ' + n });
    }
  } finally { pair.close(); }
  return pair.cycles;
}

describe('resident working set (differential against the full rebuild)', function () {
  this.timeout(300000);
  let previous, before;
  beforeEach(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); clock.install(); before = { ...residentSet.counters }; });
  afterEach(() => { clock.uninstall(); scope.setTenancyMode(previous); });
  const since = () => Object.fromEntries(Object.keys(before).map(key => [key, residentSet.counters[key] - before[key]]));

  it('reads its switch strictly', function () {
    for (const off of [undefined, null, '', '0', 'off', false]) assert.equal(residentSet.parse(off), false);
    for (const on of ['1', 'on', true]) assert.equal(residentSet.parse(on), true);
    assert.throws(() => residentSet.parse('yes'), /NS_EVAL_RESIDENT_WORKING_SET is 1 or 0/);
    const replayOf = () => memory({ tenant: TENANT }).replay;
    assert.throws(() => evaluator({ tenant: TENANT, replay: replayOf(), env: ENVS.loop(), language: require('../lib/language')(), includeFrame: true, residentWorkingSet: 'true',
      connection: { async query () {} }, dbstats: async () => ({}), maxRows: 10, maxBytes: 1000 }), /is 1 or 0/);
  });

  it('holds an input only while every window time is canonical, until the first row leaves a window', function () {
    const policy = require('../lib/storage/clinical-working-set-policy').create(ENVS.loop(), 1800000000000);
    const frozen = doc => ({ doc: Object.freeze(doc) });
    const at = policy.at;
    assert.equal(residentSet.until({ entries: [], treatments: [], devicestatus: [] }, policy), Infinity);
    assert.equal(residentSet.until({ entries: [frozen({ date: at - HOUR })], treatments: [frozen({ created_at: iso(at - 59 * HOUR) })],
      devicestatus: [frozen({ created_at: iso(at - 23 * HOUR - 30 * MIN) })] }, policy), at + 30 * MIN + 1);
    assert.equal(residentSet.until({ entries: [frozen({ date: at - 48 * HOUR })] }, policy), at + 1, 'a reading at the window edge leaves on the next millisecond');
    for (const odd of [{ entries: [frozen({ date: at - 0.5 })] }, { entries: [frozen({ date: String(at) })] }, { entries: [frozen({ date: [at] })] },
      { treatments: [frozen({ created_at: iso(at).replace('.000Z', 'Z') })] }, { devicestatus: [frozen({ created_at: [iso(at)] })] }, { devicestatus: [frozen({})] }]) {
      assert.equal(residentSet.until(odd, policy), null, JSON.stringify(odd));
    }
  });

  it('owns only plain data', function () {
    const set = { sgvs: [{ mgdl: 100, nested: { a: [1, undefined, NaN] } }], lastUpdated: 5, clone () {} };
    const data = residentSet.own(set);
    assert.deepEqual(Object.keys(data), ['sgvs', 'lastUpdated']);
    assert.ok(Object.isFrozen(data.sgvs[0].nested.a) && data.sgvs === set.sgvs);
    for (const odd of [new Date(0), new Map(), () => 1, Object.create({ inherited: 1 }), Object.defineProperty({}, 'hidden', { value: 1 }), Object.assign([1], { extra: 1 }), [1, , 3]]) { // eslint-disable-line no-sparse-arrays
      assert.equal(residentSet.own({ sgvs: [{ odd }] }), null);
    }
  });

  for (const [name, levers] of [['window levers on', 'all'], ['window levers off', '0']]) {
    it('gives the full rebuild\'s result for every synthetic scenario under two plugin sets (' + name + ')', async function () {
      const now = Math.floor(clock.RealDate.now() / MIN) * MIN;
      let cycles = 0;
      for (const scenario of Object.keys(SCENARIOS)) {
        for (const envName of ['loop', 'defaults']) {
          const pair = arms(ENVS[envName], levers), fx = SCENARIOS[scenario](now), label = scenario + ' ' + envName + ' ';
          try {
            const seed = [];
            for (const domain of ['entries', 'treatments', 'devicestatus', 'profile']) for (const [i, doc] of fx[domain].entries()) seed.push(row(domain, { ...copy(doc), _id: domain + '-' + i }));
            pair.write(seed, { exact: false, at: now });
            const first = await cycle(pair, now, { label: label + 'acquisition' });
            assert.ok(first.frame && Array.isArray(first.frame.sgvs), label + 'a frame');
            await cycle(pair, now + 61000, { time: true, label: label + 'time-only' });
            await cycle(pair, now + 90000, { time: true, label: label + 'second time-only' });
            await cycle(pair, now + 100000, { time: true, label: label + 'third time-only' });
            pair.write([reading('new-reading', 222, now + 2 * MIN - 5000)], { at: now + 2 * MIN });
            await cycle(pair, now + 2 * MIN, { label: label + 'second acquisition' });
            cycles += pair.cycles;
          } finally { pair.close(); }
        }
      }
      assert.equal(cycles, Object.keys(SCENARIOS).length * 2 * 5);
      const did = since();
      assert.ok(did.reused > 0 && did.placed > 0 && did.rebuilt > 0, 'the resident paths ran: ' + JSON.stringify(did));
    });
  }

  it('gives the full rebuild\'s result on every minute of the replay with edits, deletes, back-dated records, a restore and a settings change', async function () {
    assert.equal(await replay({ minutes: 1200, levers: 'all' }), 1201);
    const did = since();
    assert.ok(did.reused > 300 && did.placed > 150 && did.rebuilt >= 4 && did.statusesPrepared > 150 && did.statusesResident > 10000, 'the resident paths ran: ' + JSON.stringify(did));
    assert.equal(did.plain, 0);
  });

  it('gives the full rebuild\'s result over the mutations with the window levers off', async function () {
    assert.equal(await replay({ minutes: 620, levers: '0' }), 621);
  });

  // A read that reports a later expiry than the window's own (or none) does
  // not lengthen the hold: the bound is the policy's, from the rows. The wall
  // clock stays behind the instant here, so the cache's wall-clock retention
  // edge (which coincides with the window edge when the two clocks agree)
  // does not end the hold by itself.
  async function lateExpiry (factory) {
    const now = Math.floor(clock.RealDate.now() / MIN) * MIN;
    const pair = arms(ENVS.loop, 'all', { factory, shape: ({ policy, state }) => ({ checkpoint: state.stamp, progress: 'level-window',
      signature: { stamp: state.stamp, deleted: 0 }, generation: state.generation, policy, expiresAt: state.stamp + HOUR }) });
    try {
      const fx = SCENARIOS.steady(now), seed = [reading('edge-reading', 133, now - 48 * HOUR + 30000)];
      for (const domain of ['entries', 'treatments', 'devicestatus', 'profile']) for (const [i, doc] of fx[domain].entries()) seed.push(row(domain, { ...copy(doc), _id: domain + '-' + i }));
      pair.write(seed, { exact: false, at: now });
      const first = await cycle(pair, now, { label: 'acquisition' });
      assert.ok(first.frame.sgvs.some(sgv => sgv.mills === now - 48 * HOUR + 30000), 'the edge reading is in the window');
      await cycle(pair, now + 5000, { time: true, wall: now, label: 'time-only inside the window' });
      await cycle(pair, now + 10000, { time: true, wall: now, label: 'second time-only inside the window' });
      await cycle(pair, now + 20000, { time: true, wall: now, label: 'third time-only inside the window' });
      const later = await cycle(pair, now + 61000, { time: true, wall: now, label: 'time-only after the edge reading left' });
      assert.ok(!later.frame.sgvs.some(sgv => sgv.mills === now - 48 * HOUR + 30000), 'the edge reading has left');
    } finally { pair.close(); }
  }
  it('does not hold past a row leaving its window when the read reports a later expiry', async function () {
    await lateExpiry(evaluator);
    assert.equal(since().reused, 1, 'the third time-only cycle inside the window was handed the resident set, the one after it was not');
  });
  it('control: a hold to the reported expiry is detected', async function () {
    const broken = brokenModule('../lib/data/tenant-projection-evaluator',
      'if (residentUntil !== null && Number.isSafeInteger(input.expiresAt) && input.expiresAt < residentUntil) residentUntil = input.expiresAt;',
      'if (residentUntil !== null && Number.isSafeInteger(input.expiresAt)) residentUntil = input.expiresAt;');
    await assert.rejects(lateExpiry(broken), assert.AssertionError);
  });

  // Controls: each deliberately wrong delta step must be detected by the comparison above.
  const controls = [
    ['a changed status keeps its resident copy', 'plan', '    const prepared = memo.get(source);',
      '    const prepared = memo.get(source) || ([...memo].find(([known]) => known._id === source._id) || [])[1];'],
    ['a new status is not placed', 'place', '    ids.add(status._id); memo.set(source, deepFreeze(status)); list.push(status);',
      '    ids.add(status._id); memo.set(source, deepFreeze(status));'],
    ['the placed statuses are not ordered', 'place', '  return { list: list.sort(byMillsThenId), memo };', '  return { list, memo };']
  ];
  for (const [name, method, needle, replacement] of controls) {
    it('control: ' + name + ' is detected', async function () {
      const broken = brokenModule('../lib/data/resident-working-set', needle, replacement);
      const real = residentSet[method];
      residentSet[method] = broken[method];
      try {
        await assert.rejects(replay({ minutes: 620, levers: 'all' }), assert.AssertionError, name + ' must be detected');
      } finally { residentSet[method] = real; }
    });
  }
});
