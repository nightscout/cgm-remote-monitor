'use strict';

// The evaluator window levers (lib/data/window-levers.js, temporary switch
// NS_EVALUATOR_WINDOW_LEVERS) against the same level evaluator with the
// switch off: every cycle result must be the same text, byte for byte
// (properties, requested and emitted alarms, the browser frame, the due
// instant), warm and after eviction, for each lever alone and for all.
//
// The history is a synthetic looping day built to make the device-status
// window matter (no record from a person): an oref rig reporting every five
// minutes for the whole window, a Loop phone that stopped eight hours ago
// (its ten newest statuses are older than every plugin look-back, and the
// frame still carries them), an uploader that sends uploaderBattery, a pump
// whose clock runs ahead, carbs through the day (the cob plugin's treatment
// model asks for device IOB at each earlier entry's decay time), and
// statuses that are not ordinary (their own mills, an array under openaps, a
// created_at that is not a date).
//
// Controls (levers off): the same evaluator given a window with the older
// statuses dropped, fitted without iob, fitted without the frame's ten per
// device, or fitted below the plugins' six hours must each give a different
// result. So this history detects a window narrower than what is read.
const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const evaluator = require('../lib/data/tenant-projection-evaluator');
const levers = require('../lib/data/window-levers');
const memoryRead = require('../lib/storage/projection-memory-read');
const { canonical } = require('../lib/server/serve/evaluator-runtime');
const environment = require('../lib/server/tenant-app/environment');
const clock = require('./lib/views-replay/clock');

const TENANT = '22222222-2222-4222-8222-222222222222';
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const iso = ms => new Date(ms).toISOString();
const THRESHOLDS = { bgHigh: 200, bgTargetTop: 180, bgTargetBottom: 80, bgLow: 55 };
const ENVS = {
  loop: () => environment({ settings: { enable: ['bgnow', 'delta', 'direction', 'rawbg', 'iob', 'cob', 'profile', 'basal', 'pump',
    'openaps', 'loop', 'timeago', 'simplealarms', 'devicestatus', 'careportal', 'bwp', 'ar2', 'sage', 'cage', 'iage', 'bage', 'upbat'], thresholds: THRESHOLDS } }),
  defaults: () => environment({ settings: { thresholds: THRESHOLDS } })
};

function history (now) {
  const entries = [], devicestatus = [], treatments = [];
  for (let t = now - 2 * DAY; t <= now; t += 5 * MIN) {
    const k = (t - now) / (5 * MIN);
    entries.push({ type: 'sgv', sgv: 120 + Math.round(40 * Math.sin(k / 9)), date: t, dateString: iso(t), direction: 'Flat', device: 'window-levers' });
  }
  const pred = (base) => Array.from({ length: 48 }, (_, i) => base - i);
  for (let t = now - 26 * HOUR; t <= now; t += 5 * MIN) {
    const k = Math.round((now - t) / (5 * MIN));
    devicestatus.push({ device: 'openaps://rig', created_at: iso(t), utcOffset: 0,
      uploader: { battery: 40 + (k % 50) },
      pump: { clock: iso(t), reservoir: 100 + (k % 30), battery: { percent: 80 }, status: { status: 'normal', bolusing: false, suspended: false } },
      openaps: { iob: { iob: 1 + (k % 7) / 10, basaliob: 0.3, activity: 0.01 + (k % 5) / 500, time: iso(t) },
        suggested: { bg: 120, eventualBG: 110, COB: k % 40, temp: 'absolute', rate: 0.8, duration: 30, reason: 'synthetic', timestamp: iso(t), predBGs: { IOB: pred(130), ZT: pred(120) } },
        // Enacted only between five and two hours ago: the newest is older than the newest statuses.
        ...(k % 3 === 0 && t <= now - 2 * HOUR && t >= now - 5 * HOUR ? { enacted: { bg: 120, rate: 0.8, duration: 30, received: true, timestamp: iso(t), COB: k % 40, predBGs: { IOB: pred(128) } } } : {}) } });
  }
  // A Loop phone that stopped 8 h ago.
  for (let t = now - 23 * HOUR; t <= now - 8 * HOUR; t += 5 * MIN) {
    devicestatus.push({ device: 'loop://phone', created_at: iso(t + 1000),
      loop: { name: 'Loop', version: '3.4', timestamp: iso(t + 1000), iob: { iob: 0.7, timestamp: iso(t + 1000) }, cob: { cob: 12, timestamp: iso(t + 1000) },
        predicted: { startDate: iso(t + 1000), values: pred(140) }, enacted: { rate: 0.5, duration: 30, timestamp: iso(t + 1000), received: true, bolusVolume: 0 } },
      pump: { clock: iso(t + 1000), pumpID: 'synthetic', reservoir: 90, battery: { percent: 60 }, suspended: false, bolusing: false },
      uploader: { name: 'phone', battery: 77, timestamp: iso(t + 1000) }, override: { active: false, timestamp: iso(t + 1000) },
      radioAdapter: { pumpRSSI: -60, RSSI: -50 } });
  }
  for (let t = now - 25 * HOUR; t <= now; t += 30 * MIN) {
    devicestatus.push({ device: 'xdrip://uploader', created_at: iso(t + 2000), uploaderBattery: 55 });
  }
  devicestatus.push(
    // MiniMed Connect: pump IOB, with connect present.
    { device: 'connect://pump', created_at: iso(now - 15 * HOUR + 3000), connect: { sensorState: 'ok', calibStatus: 'ok' }, pump: { iob: { bolusiob: 2.1, timestamp: iso(now - 15 * HOUR) }, clock: iso(now - 15 * HOUR) } },
    // A pump clock running ahead, on an old status.
    { device: 'openaps://rig', created_at: iso(now - 12 * HOUR + 4000), pump: { clock: iso(now + 20 * MIN), reservoir: 50 } },
    // The loader adds absolute to any object with amount (dataloader.js normalizeTreatments).
    { device: 'openaps://rig', created_at: iso(now - 13 * HOUR + 4000), openaps: { iob: { iob: 0.4, activity: 0.02, time: iso(now - 13 * HOUR), amount: 3 }, note: { amount: 5 } } },
    // Not ordinary: left whole.
    { device: 'openaps://rig', created_at: iso(now - 16 * HOUR + 4000), mills: now - 16 * HOUR + 4000, openaps: { iob: { iob: 0.2, activity: 0.01, time: iso(now - 16 * HOUR) }, suggested: { bg: 99 } } },
    { device: 'openaps://rig', created_at: iso(now - 17 * HOUR + 4000), openaps: [{ iob: 1 }] },
    { device: 'odd://date', created_at: 'not a date', uploader: { battery: 9 }, pump: { clock: iso(now - HOUR) } },
    { device: 42, created_at: iso(now - 18 * HOUR + 4000), uploader: { battery: 9 } },
    { created_at: iso(now - 19 * HOUR + 4000), uploader: { battery: 8 }, xdripjs: { state: 6, timestamp: now - 19 * HOUR } },
    // Dated a few minutes ahead.
    { device: 'openaps://rig', created_at: iso(now + 3 * MIN), uploader: { battery: 33 }, openaps: { iob: { iob: 9, activity: 0.09, time: iso(now + 3 * MIN) } } }
  );
  for (const [hours, carbs, insulin] of [[40, 30, 3], [20, 45, 4], [14, 60, 6], [9, 25, 2.5], [3, 50, 5], [0.7, 20, 2]]) {
    treatments.push({ eventType: 'Meal Bolus', created_at: iso(now - hours * HOUR), carbs, insulin, enteredBy: 'window-levers' });
  }
  for (let t = now - 30 * HOUR; t <= now; t += 30 * MIN) {
    treatments.push({ eventType: 'Temp Basal', created_at: iso(t + 7000), duration: 30, absolute: 0.6 + ((t / (30 * MIN)) % 5) / 10, enteredBy: 'window-levers' });
  }
  treatments.push({ eventType: 'Site Change', created_at: iso(now - 30 * HOUR), enteredBy: 'window-levers' });
  const profile = [{ defaultProfile: 'Default', startDate: iso(now - 400 * DAY), mills: now - 400 * DAY, units: 'mg/dl', created_at: iso(now - 400 * DAY),
    store: { Default: { dia: 4, carbratio: [{ time: '00:00', value: 10, timeAsSeconds: 0 }], carbs_hr: 30, delay: 20,
      sens: [{ time: '00:00', value: 40, timeAsSeconds: 0 }], timezone: 'UTC', basal: [{ time: '00:00', value: 0.8, timeAsSeconds: 0 }],
      target_low: [{ time: '00:00', value: 100, timeAsSeconds: 0 }], target_high: [{ time: '00:00', value: 120, timeAsSeconds: 0 }], units: 'mg/dl' } } }];
  return { entries, treatments, devicestatus, profile };
}

// Level-window rows: { domain, document, ordinal }, fresh JSON values per read.
function rowsOf (docs) {
  const rows = [];
  let ordinal = 0;
  for (const domain of ['entries', 'treatments', 'devicestatus', 'profile']) {
    docs[domain].forEach((doc, i) => rows.push({ domain, document: { ...doc, _id: doc._id || domain + '-' + String(i).padStart(5, '0') }, ordinal: ++ordinal }));
  }
  return rows;
}

function component (state, env, names) {
  const replay = { level: true, async reconcile () { throw new Error('A level component reads its window'); },
    async window () {
      const rows = JSON.parse(JSON.stringify(rowsOf(state.docs)));
      return { checkpoint: state.at - 1000, progress: 'level-window', signature: { stamp: state.at - 1000, deleted: 0 }, generation: '3',
        policy: {}, expiresAt: state.at + HOUR, rows: state.narrow ? state.narrow(rows, state.at, env) : rows };
    } };
  return evaluator({ tenant: TENANT, replay, env, language: require('../lib/language')(), includeFrame: true, levers: names,
    connection: { async query () { throw new Error('No SQL: the views read in process'); } },
    dbstats: async () => ({ dataSize: 123456, indexSize: 7890, fileSize: 135000 }), maxRows: 10000, maxBytes: 8388608 });
}

// Acquisition, time-only, a new reading and status, time-only seven hours on
// (the retained window has expired by then, so that cycle reads again).
async function cycles (envName, names, { cold = false, narrow } = {}) {
  const env = ENVS[envName]();
  const state = { at: NOW, docs: history(NOW), narrow };
  const subject = component(state, env, names);
  const out = [];
  const step = async (label, at, run) => {
    clock.pin(at);
    if (cold && out.length && label.startsWith('acquisition')) subject.evict();
    out.push([label, await run(at)]);
  };
  try {
    await scope.withTenant(TENANT, async () => {
      await step('acquisition', NOW, at => subject.evaluate({ at }));
      await step('time-only', NOW + 61000, at => subject.evaluateTime({ at }));
      state.at = NOW + 5 * MIN;
      state.docs.entries.push({ type: 'sgv', sgv: 231, date: state.at - 5000, dateString: iso(state.at - 5000), direction: 'SingleUp', device: 'window-levers' });
      state.docs.devicestatus.push({ device: 'openaps://rig', created_at: iso(state.at - 4000), uploader: { battery: 21 },
        pump: { clock: iso(state.at - 4000), reservoir: 12, battery: { percent: 15 } },
        openaps: { iob: { iob: 2.2, basaliob: 0.4, activity: 0.03, time: iso(state.at - 4000) }, suggested: { bg: 231, eventualBG: 250, COB: 18, timestamp: iso(state.at - 4000) } } });
      await step('acquisition 2', state.at, at => subject.evaluate({ at }));
      await step('time-only 2', state.at + 2 * MIN, at => subject.evaluateTime({ at }));
      state.at = NOW + 7 * HOUR;
      await step('time-only after expiry', state.at, at => subject.evaluateTime({ at }));
      state.at = NOW + 7 * HOUR + 5 * MIN;
      await step('acquisition 3', state.at, at => subject.evaluate({ at }));
    });
  } finally { subject.close(); }
  return out;
}

const text = result => JSON.stringify(result);
function assertSame (subject, reference, label) {
  assert.equal(subject.length, reference.length);
  subject.forEach(([kind, result], i) => {
    assert.equal(text(result), text(reference[i][1]), label + ' ' + kind + ': cycle result text');
    assert.equal(canonical(result), canonical(reference[i][1]), label + ' ' + kind + ': canonical content');
  });
}
function differs (subject, reference) {
  return subject.some(([, result], i) => text(result) !== text(reference[i][1]));
}

// A narrower window for the controls: fit the device statuses with a broken rule.
function narrowed (rule) {
  return (rows, at, env) => {
    const statuses = rows.filter(row => row.domain === 'devicestatus').map(row => ({ ...row, doc: row.document }));
    const fitted = rule(statuses, at, env).map(row => ({ domain: 'devicestatus', document: row.doc, ordinal: row.ordinal }));
    return [...rows.filter(row => row.domain !== 'devicestatus'), ...fitted];
  };
}
const older = (row, at, hours) => Date.parse(row.doc.created_at) < at - hours * HOUR;

describe('evaluator window levers', function () {
  this.timeout(180000);
  let previousMode;
  before(() => clock.install());
  after(() => clock.uninstall());
  beforeEach(() => { previousMode = scope.getTenancyMode(); scope.setTenancyMode('multi'); clock.pin(NOW); });
  afterEach(() => scope.setTenancyMode(previousMode));

  describe('the switch', function () {
    it('is off unless named, and refuses a lever it does not know', function () {
      for (const off of [undefined, null, '', '0', 'off', ' OFF ']) assert.deepEqual(levers.parse(off), { copies: false, statuses: false });
      for (const all of ['1', 'all', ' ALL ']) assert.deepEqual(levers.parse(all), { copies: true, statuses: true });
      assert.deepEqual(levers.parse('copies'), { copies: true, statuses: false });
      assert.deepEqual(levers.parse('statuses, copies'), { copies: true, statuses: true });
      for (const bad of ['true', 'yes', 'copy', 'copies,window', ',']) assert.throws(() => levers.parse(bad), /unknown levers/);
    });
    it('does nothing outside the level evaluator', async function () {
      const env = ENVS.defaults();
      const docs = history(NOW);
      const make = names => evaluator({ tenant: TENANT, env, language: require('../lib/language')(), includeFrame: true, levers: names,
        replay: { async reconcile () { return { checkpoint: 1, progress: 'p', signature: null, rows: JSON.parse(JSON.stringify(rowsOf(docs))) }; } },
        connection: { async query () { throw new Error('No SQL'); } }, dbstats: async () => ({}), maxRows: 10000, maxBytes: 8388608 });
      const results = [];
      for (const names of [undefined, '1']) {
        const subject = make(names);
        try { results.push(text(await scope.withTenant(TENANT, () => subject.evaluate({ at: NOW })))); } finally { subject.close(); }
      }
      assert.equal(results[0], results[1]);
    });
  });

  describe('fitStatuses', function () {
    const env = ENVS.loop();
    const row = (doc, i) => ({ domain: 'devicestatus', id_kind: 'string', doc: { _id: 'd' + i, ...doc }, ordinal: i + 1 });
    const status = (device, minutesAgo, extra = {}) => ({ device, created_at: iso(NOW - minutesAgo * MIN),
      uploader: { battery: 50, name: 'x' }, pump: { clock: iso(NOW - minutesAgo * MIN), reservoir: 10, iob: { bolusiob: 1 } },
      openaps: { iob: { iob: 1, activity: 0.1 }, suggested: { bg: 100 } }, loop: { iob: { iob: 2 }, predicted: { values: [1, 2] } }, extraField: 1, ...extra });

    it('keeps every row, in order, and leaves recent rows as given', function () {
      const rows = Array.from({ length: 200 }, (_, i) => row(status('openaps://a', i * 5), i));
      const out = levers.fitStatuses(rows, { at: NOW, env, now: NOW });
      assert.equal(out.length, rows.length);
      out.forEach((r, i) => { assert.equal(r.doc._id, rows[i].doc._id); assert.equal(r.ordinal, rows[i].ordinal); });
      const cut = NOW - 7 * HOUR; // 6 h and the margin
      const wholeOld = [];
      out.forEach((r, i) => {
        const mills = Date.parse(rows[i].doc.created_at);
        if (mills >= cut) assert.equal(r, rows[i], 'a recent row is the row given');
        else if (r === rows[i]) wholeOld.push(i);
        else assert.deepEqual(r.doc, { _id: rows[i].doc._id, device: 'openaps://a', created_at: rows[i].doc.created_at, uploader: {},
          pump: { clock: rows[i].doc.pump.clock, iob: { bolusiob: 1 } }, openaps: { iob: { iob: 1, activity: 0.1 } }, loop: { iob: { iob: 2 } } });
      });
      // The ten newest older rows of the device stay whole (the frame's ten per device and type).
      assert.deepEqual(wholeOld, Array.from({ length: 10 }, (_, k) => 85 + k));
    });
    it('keeps the ten newest older rows of each device and type, and ties with the tenth', function () {
      const rows = [];
      for (let i = 0; i < 30; i++) rows.push(row(status('openaps://a', 600 + i * 5), rows.length));
      for (let i = 0; i < 30; i++) rows.push(row({ device: 'loop://b', created_at: iso(NOW - (600 + i * 5) * MIN - 1), loop: { iob: { iob: 1 }, big: 'x' } }, rows.length));
      // Twelve statuses of a third device at one instant: all tie.
      for (let i = 0; i < 12; i++) rows.push(row({ device: 'tie://c', created_at: iso(NOW - 900 * MIN), uploader: { battery: i } }, rows.length));
      // uploaderBattery makes an uploader status (dataloader.js eachStatus).
      for (let i = 0; i < 14; i++) rows.push(row({ device: 'xdrip://d', created_at: iso(NOW - (700 + i) * MIN), uploaderBattery: i, junk: { a: 1 } }, rows.length));
      const out = levers.fitStatuses(rows, { at: NOW, env, now: NOW });
      const whole = name => out.filter((r, i) => r === rows[i] && rows[i].doc.device === name).length;
      assert.equal(whole('openaps://a'), 10);
      assert.equal(whole('loop://b'), 10);
      assert.equal(whole('tie://c'), 12);
      assert.equal(whole('xdrip://d'), 10);
      const fittedD = out.find((r, i) => r !== rows[i] && rows[i].doc.device === 'xdrip://d');
      assert.deepEqual(Object.keys(fittedD.doc), ['_id', 'device', 'created_at', 'uploaderBattery']);
    });
    it('leaves a status whole when it is not ordinary', function () {
      const old = 900;
      const odd = [
        status('a', old, { mills: 5 }), status('a', old, { sysTime: iso(NOW) }), status('a', old, { date: 5 }), status('a', old, { duration: 5 }),
        status('a', old, { durationInMilliseconds: 5 }), status('a', old, { endmills: 5 }), status(7, old), status('a', old, { openaps: [1] }),
        status('a', old, { created_at: 'not a date' }), status('a', old, { created_at: 5 }), status('a', old, { created_at: [iso(NOW - DAY)] })
      ];
      // Eleven ordinary newer ones first, so none of the odd rows is whole by rank alone.
      const rows = [...Array.from({ length: 11 }, (_, i) => status('a', 800 + i)), ...odd].map(row);
      const out = levers.fitStatuses(rows, { at: NOW, env, now: NOW });
      odd.forEach((_, k) => assert.equal(out[11 + k], rows[11 + k], 'odd status ' + k + ' is the row given'));
      assert.notEqual(out[10], rows[10]);
    });
    it('keeps values that are not objects, and connect, as they are', function () {
      const rows = [...Array.from({ length: 11 }, (_, i) => status('a', 800 + i)),
        { device: 'a', created_at: iso(NOW - 900 * MIN), pump: null, openaps: 'text', loop: 3, uploader: false, connect: { any: [1] }, other: 1 }].map(row);
      const out = levers.fitStatuses(rows, { at: NOW, env, now: NOW });
      assert.deepEqual(out[11].doc, { _id: 'd11', device: 'a', created_at: rows[11].doc.created_at, pump: null, openaps: 'text', loop: 3, uploader: false, connect: { any: [1] } });
    });
    it('looks back as far as the longest plugin window', function () {
      assert.equal(levers.recentLookback(ENVS.loop()), 6 * HOUR);
      assert.equal(levers.recentLookback({ settings: { enable: ['pump'] }, extendedSettings: { pump: { urgentClock: 300 } } }), 10 * HOUR);
      assert.equal(levers.recentLookback({ settings: { enable: ['xdripjs'] }, extendedSettings: {} }), DAY);
      assert.equal(levers.recentLookback({}), DAY, 'an unknown plugin set takes the longest');
      // The earlier of the instant and the wall clock.
      const rows = Array.from({ length: 200 }, (_, i) => row(status('openaps://a', i * 5), i));
      const behind = levers.fitStatuses(rows, { at: NOW, env, now: NOW - 3 * HOUR });
      assert.ok(behind.every((r, i) => r === rows[i] || Date.parse(rows[i].doc.created_at) < NOW - 10 * HOUR));
    });
  });

  describe('shared read documents', function () {
    it('shares the retained children only with a caller that asked, and never the top level', function () {
      const rows = memoryRead.rowsOf([{ id_kind: 'string', doc: { _id: 'a', created_at: iso(NOW), nested: { deep: [1, 2] } }, ordinal: 1 }]);
      const ast = require('../lib/storage/filter').fromMongo({});
      const read = async options => {
        const documentSources = new WeakMap();
        const reader = memoryRead({ rows, documentSources, ...options });
        const [doc] = await reader.findFiltered(ast, { sort: { created_at: 1 }, options: { normalize: false } });
        return { doc, source: documentSources.get(doc) };
      };
      return Promise.all([read({}), read({ shareDocuments: true })]).then(([copied, shared]) => {
        assert.equal(copied.source, rows[0].doc);
        assert.notEqual(copied.doc.nested, rows[0].doc.nested);
        assert.equal(Object.isFrozen(copied.doc.nested), false);
        assert.equal(shared.source, rows[0].doc);
        assert.equal(shared.doc.nested, rows[0].doc.nested);
        assert.notEqual(shared.doc, rows[0].doc);
        assert.equal(Object.isFrozen(shared.doc), false);
        assert.deepEqual(shared.doc, copied.doc);
      });
    });
  });

  for (const envName of ['loop', 'defaults']) {
    describe('against the switch off, ' + envName + ' plugins', function () {
      let reference;
      before(async function () {
        scope.setTenancyMode('multi');
        reference = { warm: await cycles(envName, undefined), cold: await cycles(envName, undefined, { cold: true }) };
      });
      it('the history exercises the plugins and the frame', function () {
        const first = reference.warm[0][1];
        assert.ok(first.frame.devicestatus.some(status => status.device === 'loop://phone'), 'the stopped phone is in the frame');
        assert.ok(first.frame.devicestatus.length >= 20);
        if (envName === 'loop') {
          assert.ok(first.properties.cob && first.properties.cob.treatmentCOB !== undefined, 'the treatment model ran beside device COB');
          assert.ok(first.properties.openaps && first.properties.openaps.lastSuggested && first.properties.openaps.lastEnacted);
          assert.equal(first.due.reason !== null, true);
        }
      });
      for (const names of ['copies', 'statuses', '1']) {
        it('gives the same cycles with ' + names + ', warm', async function () {
          assertSame(await cycles(envName, names), reference.warm, names + ' warm');
        });
        it('gives the same cycles with ' + names + ', after eviction', async function () {
          assertSame(await cycles(envName, names, { cold: true }), reference.cold, names + ' cold');
        });
      }

      const controls = {
        'the older statuses dropped': rows => rows.filter(row => !older(row, NOW, 7)),
        'fitted without iob': (rows, at, env) => levers.fitStatuses(rows, { at, env, now: at }).map((row, i) => {
          if (row === rows[i]) return row;
          const doc = JSON.parse(JSON.stringify(row.doc));
          for (const key of ['openaps', 'loop', 'pump']) if (doc[key] && typeof doc[key] === 'object') delete doc[key].iob;
          return { ...row, doc };
        }),
        'fitted without the frame\'s ten per device': (rows, at) => rows.map(row => (older(row, at, 7) && Number.isFinite(levers.ordinaryMills(row.doc)) ? { ...row, doc: levers.fitted(row.doc) } : row)),
        'fitted below the plugins\' six hours': (rows, at, env) => levers.fitStatuses(rows, { at, env, now: at, lookback: 0 - levers.MARGIN_MS + 20 * MIN })
      };
      // The default plugin set has no iob, cob, openaps or loop: only the frame
      // and upbat's half hour read its statuses.
      for (const [name, rule] of Object.entries(controls)) {
        if (envName === 'defaults' && /iob|six hours/.test(name)) continue;
        it('control: ' + name + ' gives a different result', async function () {
          const narrow = await cycles(envName, undefined, { narrow: narrowed(rule) });
          assert.equal(differs(narrow, reference.warm), true);
        });
      }
    });
  }
});
