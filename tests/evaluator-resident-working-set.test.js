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
//
// What a cycle shares with the resident set: the same comparison with a test
// plugin that writes a field no cycle has a copy of (caught: that cycle runs
// on a whole copy; and detected by the comparison when the refused write goes
// unnoticed), and four deliberately missing copies, each noticed as a write
// into what is shared.
const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const evaluator = require('../lib/data/tenant-projection-evaluator');
const residentSet = require('../lib/data/resident-working-set');
const memory = require('./lib/resident-window/memory-replay');
const clock = require('./lib/views-replay/clock');
const brokenModule = require('./lib/clinical-working-set/control');
const { SCENARIOS, MIN, HOUR } = require('./lib/views-equality/fixtures');

const { TENANT, ENVS, iso, copy, arms, cycle, row, reading, status, replay } = require('./lib/resident-window/differential');

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
      assert.ok(did.reused > 0 && did.placed > 0 && did.rebuilt > 0 && did.shared > 0, 'the resident paths ran: ' + JSON.stringify(did));
      assert.equal(did.tripped, 0, 'no plugin pass wrote into what a cycle shares with the resident set');
    });
  }

  it('gives the full rebuild\'s result on every minute of the replay with edits, deletes, back-dated records, a restore and a settings change', async function () {
    assert.equal(await replay({ minutes: 1200, levers: 'all' }), 1201);
    const did = since();
    assert.ok(did.reused > 300 && did.placed > 150 && did.rebuilt >= 4 && did.statusesPrepared > 150 && did.statusesResident > 10000, 'the resident paths ran: ' + JSON.stringify(did));
    assert.equal(did.plain, 0);
    assert.ok(did.shared > 300, 'cycles were handed the resident set shared: ' + JSON.stringify(did));
    assert.deepEqual([did.whole, did.tripped], [0, 0], 'none needed a whole copy, and no plugin pass wrote into what is shared');
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
    assert.equal(since().reused, 2, 'the second and third time-only cycles inside the window were handed the resident set, the one after them was not');
  });
  it('control: a hold to the reported expiry is detected', async function () {
    const broken = brokenModule('../lib/data/tenant-projection-evaluator',
      'if (residentUntil !== null && Number.isSafeInteger(input.expiresAt) && input.expiresAt < residentUntil) residentUntil = input.expiresAt;',
      'if (residentUntil !== null && Number.isSafeInteger(input.expiresAt)) residentUntil = input.expiresAt;');
    await assert.rejects(lateExpiry(broken), assert.AssertionError);
  });

  // ---- What a cycle shares with the resident set (resident-working-set.js handOut).
  // One input with openaps statuses, readings and temp basals: an acquisition,
  // three time-only cycles (the last two are handed the resident set), then
  // another acquisition and two more time-only cycles.
  async function sharedCycles () {
    const now = Math.floor(clock.RealDate.now() / MIN) * MIN;
    const pair = arms(ENVS.loop, 'all');
    try {
      const fx = SCENARIOS.steady(now), seed = [status('s-shared-1', now - 11 * MIN), status('s-shared-2', now - 6 * MIN), status('s-shared-3', now - MIN),
        row('devicestatus', { ...status('s-oref0', now - 2 * MIN).doc, openaps: { iob: [{ iob: 1.1, basaliob: 0.3, activity: 0.01, time: iso(now - 2 * MIN) }, { iob: 1.0 }],
          suggested: { bg: 140, temp: 'absolute', rate: 0.8, duration: 30, timestamp: iso(now - 2 * MIN), predBGs: { IOB: [140, 138, 135], ZT: [140, 130, 120] } } } }),
        row('treatments', { _id: 't-shared-basal', eventType: 'Temp Basal', created_at: iso(now - 20 * MIN), duration: 30, absolute: 0.6 }),
        row('treatments', { _id: 't-shared-meal', eventType: 'Meal Bolus', created_at: iso(now - 50 * MIN), carbs: 30, insulin: 3 })];
      for (const domain of ['entries', 'treatments', 'devicestatus', 'profile']) for (const [i, doc] of fx[domain].entries()) seed.push(row(domain, { ...copy(doc), _id: domain + '-' + i }));
      pair.write(seed, { exact: false, at: now });
      await cycle(pair, now, { label: 'acquisition' });
      for (const [i, seconds] of [20, 40, 61].entries()) await cycle(pair, now + seconds * 1000, { time: true, label: 'time-only ' + (i + 1) });
      pair.write([reading('shared-reading', 141, now + 2 * MIN - 5000)], { at: now + 2 * MIN });
      await cycle(pair, now + 2 * MIN, { label: 'second acquisition' });
      for (const [i, seconds] of [140, 160].entries()) await cycle(pair, now + seconds * 1000, { time: true, label: 'later time-only ' + (i + 1) });
    } finally { pair.close(); }
    return since();
  }
  // A test plugin: the shipping timeago plugin, writing first. plugins/index.js
  // takes the module's export when a views instance registers its plugins.
  function withMutant (write, body) {
    const file = require.resolve('../lib/plugins/timeago');
    require(file);
    const real = require.cache[file].exports;
    require.cache[file].exports = function init (ctx) {
      const plugin = real(ctx), setProperties = plugin.setProperties;
      plugin.setProperties = function mutant (sbx) { write(sbx); return setProperties.call(this, sbx); };
      return plugin;
    };
    return Promise.resolve().then(body).finally(() => { require.cache[file].exports = real; });
  }
  // Writes a field no cycle is given a copy of (a treatment), and reports what it then reads.
  const writesTreatment = sbx => {
    const treatment = sbx.data.treatments[0];
    treatment.mutantNote = 'written at ' + sbx.time;
    sbx.offerProperty('mutant', () => ({ notes: sbx.data.treatments.map(t => t.mutantNote).filter(Boolean) }));
  };

  it('hands a cycle the resident set shared, with its own copy of what the plugin pass writes', async function () {
    const did = await sharedCycles();
    assert.deepEqual([did.shared, did.whole, did.tripped], [5, 0, 0], JSON.stringify(did));
  });
  it('shares only a set whose copied objects are each held once', function () {
    const basal = { eventType: 'Temp Basal', mills: 1, duration: 30 };
    const set = () => ({ sgvs: [{ mgdl: 100 }], treatments: [{ eventType: 'Note', mills: 2 }], devicestatus: [{ _id: 's', openaps: { iob: [{ iob: 1 }], suggested: { predBGs: { IOB: [1, 2] } } } }], tempbasalTreatments: [{ ...basal }] });
    assert.equal(residentSet.shareable(residentSet.own(set())), true);
    const aliased = set(); aliased.treatments.push(aliased.tempbasalTreatments[0]);
    assert.equal(residentSet.shareable(residentSet.own(aliased)), false, 'a temp basal also among the treatments');
    const twice = set(); twice.cals = [twice.devicestatus[0].openaps.suggested];
    assert.equal(residentSet.shareable(residentSet.own(twice)), false, 'a status part held elsewhere');
    const data = residentSet.own(set()), out = residentSet.handOut(data, () => ({}));
    assert.deepEqual(out, data);
    out.devicestatus[0].openaps.iob[0].moment = 1; out.devicestatus[0].openaps.suggested.predBGs.moment = 1; out.sgvs[0].scaled = 5; out.tempbasalTreatments[0].endmills = 9; out.treatments.push(1);
    assert.ok(out.treatments[0] === data.treatments[0] && out.devicestatus[0].openaps.suggested.predBGs.IOB === data.devicestatus[0].openaps.suggested.predBGs.IOB, 'the rest is the resident set\'s');
    assert.throws(() => { out.treatments[0].mills = 3; }, residentSet.frozenWrite);
    assert.throws(() => { out.devicestatus[0].openaps.suggested.predBGs.IOB.push(3); }, residentSet.frozenWrite);
    assert.deepEqual(data, residentSet.own(set()), 'the resident set is as it was');
  });
  it('catches a plugin that writes a field no cycle has a copy of: that cycle runs on a whole copy, and nothing is shared afterwards', async function () {
    const did = await withMutant(writesTreatment, sharedCycles);
    assert.deepEqual([did.shared, did.tripped], [1, 1], JSON.stringify(did));
    assert.ok(did.whole >= 2, 'whole copies afterwards: ' + JSON.stringify(did));
  });
  it('control: the same plugin is detected by the comparison when the refused write goes unnoticed', async function () {
    const real = residentSet.frozenWrite;
    residentSet.frozenWrite = () => false;
    try {
      await assert.rejects(withMutant(writesTreatment, sharedCycles), assert.AssertionError);
    } finally { residentSet.frozenWrite = real; }
  });
  const copies = [
    ['a reading not copied', "    else if (COPIED[key] === 'record') ddata[key] = value.map(shallow);", "    else if (COPIED[key] === 'record') ddata[key] = key === 'sgvs' ? value.slice() : value.map(shallow);"],
    ['a temp basal not copied', "    else if (COPIED[key] === 'record') ddata[key] = value.map(shallow);", "    else if (COPIED[key] === 'record') ddata[key] = key === 'sgvs' ? value.map(shallow) : value.slice();"],
    ['a status copied one level short', 'const STATUS_OBJECT_DEPTH = 4;', 'const STATUS_OBJECT_DEPTH = 3;'],
    ['a status list not copied', 'const STATUS_ARRAY_DEPTH = 3;', 'const STATUS_ARRAY_DEPTH = 2;']
  ];
  for (const [name, needle, replacement] of copies) {
    it('control: ' + name + ' is noticed as a write into what is shared', async function () {
      const broken = brokenModule('../lib/data/resident-working-set', needle, replacement);
      const real = residentSet.handOut;
      residentSet.handOut = broken.handOut;
      try {
        const did = await sharedCycles();
        assert.deepEqual([did.shared, did.tripped], [1, 1], name + ': ' + JSON.stringify(did));
      } finally { residentSet.handOut = real; }
    });
  }
  it('runs the plugin pass in strict code only, where a frozen object refuses a write aloud', function () {
    const fs = require('node:fs'), path = require('node:path'), root = path.join(__dirname, '../lib');
    const files = ['sandbox.js', 'profilefunctions.js', 'notifications.js', 'data/evaluator-due.js', 'data/ddata.js', 'plugins/index.js']
      .concat(...['plugins', 'client-core/devicestatus'].map(dir => fs.readdirSync(path.join(root, dir)).filter(name => name.endsWith('.js')).map(name => dir + '/' + name)));
    const first = name => fs.readFileSync(path.join(root, name), 'utf8').split('\n').map(line => line.trim()).find(line => line && !line.startsWith('//'));
    const sloppy = files.filter(name => !["'use strict';", '"use strict";', "'use strict'"].includes(first(name)));
    // The two voice-assistant plugins take no part in the plugin pass.
    assert.deepEqual(sloppy, ['plugins/alexa.js', 'plugins/googlehome.js']);
    for (const name of sloppy) assert.doesNotMatch(fs.readFileSync(path.join(root, name), 'utf8'), /setProperties|checkNotifications/);
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
