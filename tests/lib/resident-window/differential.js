'use strict';

// The on/off differential of the level evaluator's temporary switches, over
// the resident window stand-in (memory-replay.js): two shipping components
// read identical stores, each cycle result compared as text. Shared by
// tests/evaluator-resident-working-set.test.js (which describes the replay's
// mutations) and tests/evaluator-acquisition-delta.test.js.
const assert = require('node:assert/strict');
const scope = require('../../../lib/storage/tenant-scope');
const evaluator = require('../../../lib/data/tenant-projection-evaluator');
const environment = require('../../../lib/server/tenant-app/environment');
const memory = require('./memory-replay');
const clock = require('../views-replay/clock');
const { MIN, HOUR } = require('../views-equality/fixtures');
const { TIMELINES } = require('../views-replay/timelines');

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

// Two arms over identical stores. on, off: the switches each arm's component
// is given (by default the resident working set on, and off); factory makes
// the on arm's component.
function arms (envOf, levers, { factory = evaluator, shape, on = { residentWorkingSet: true }, off = { residentWorkingSet: false }, what = 'the resident working set gives the full rebuild\'s cycle result' } = {}) {
  const make = (switches, made) => {
    const db = memory({ tenant: TENANT, generation: '1', resident: true, checkMs: 86400000, shape });
    const component = () => made({ tenant: TENANT, replay: db.replay, env: envOf(), language: require('../../../lib/language')(), includeFrame: true, levers, ...switches,
      connection: { async query () { throw new Error('No SQL: the views read in process'); } }, dbstats: async () => ({}), maxRows: 10000, maxBytes: 8388608 });
    return { db, component: component() };
  };
  const pair = { on: make(on, factory), off: make(off, evaluator), cycles: 0, what };
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
  assert.equal(out[0], out[1], label + ': ' + pair.what + ', byte for byte');
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
async function replay ({ minutes, levers, on: armOn, off: armOff, what }) {
  const timeline = TIMELINES.quiet();
  let thresholds = THRESHOLDS;
  const pair = arms(() => ENVS.loop(thresholds), levers, { on: armOn, off: armOff, what });
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

module.exports = { TENANT, THRESHOLDS, LOOP, ENVS, iso, copy, arms, cycle, row, gone, reading, status, replay };
