'use strict';

// Fixtures for the ST-VIEWS equality harness (tests/views-equality.test.js).
//
// Two sources:
//
// 1. Synthetic scenarios, generated here relative to the evaluation instant.
//    No record in them comes from a person. Each scenario is the base history
//    with one change that some view's output depends on.
//
// 2. An optional corpus directory, VIEWS_CORPUS_DIR, holding exports named
//    <name>_entries.json, <name>_treatments.json, <name>_devicestatus.json and
//    <name>_profile.json (the layout of the alignment repo's
//    tools/ns2parquet/fixtures). They are read from where they are, shifted in
//    time so the newest reading is two minutes before the evaluation instant,
//    and never copied into this repository. Reports name them only by
//    position (corpus #1, #2, ...).

const fs = require('fs');
const path = require('path');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function iso (ms) { return new Date(ms).toISOString(); }

function sgvAt (mills, value, direction) {
  return {
    type: 'sgv', sgv: value, date: mills, dateString: iso(mills)
    , sysTime: iso(mills), direction: direction || 'Flat', device: 'views-equality'
    , noise: 1, filtered: value * 1000, unfiltered: value * 1000, rssi: 100
  };
}

function treatment (mills, fields) {
  return Object.assign({ created_at: iso(mills), enteredBy: 'views-equality' }, fields);
}

function profileDoc (now) {
  return {
    defaultProfile: 'Default'
    , startDate: iso(now - 400 * DAY)
    , mills: now - 400 * DAY
    , units: 'mg/dl'
    , created_at: iso(now - 400 * DAY)
    , store: {
      Default: {
        dia: 4
        , carbratio: [{ time: '00:00', value: 10, timeAsSeconds: 0 }]
        , carbs_hr: 30
        , delay: 20
        , sens: [{ time: '00:00', value: 40, timeAsSeconds: 0 }]
        , timezone: 'UTC'
        , basal: [{ time: '00:00', value: 0.8, timeAsSeconds: 0 }, { time: '12:00', value: 1.0, timeAsSeconds: 43200 }]
        , target_low: [{ time: '00:00', value: 100, timeAsSeconds: 0 }]
        , target_high: [{ time: '00:00', value: 120, timeAsSeconds: 0 }]
        , units: 'mg/dl'
      }
    }
  };
}

// The base history: 50 h of readings (two hours more than the resident window
// keeps), 62 h of treatments (two more than the treatment cache keeps), 26 h of
// device status (two more than the default device-status window), the four
// device-change event types at ordinary ages, an old profile switch, and temp
// targets inside and outside the treatment window.
function base (now, opts) {
  opts = opts || {};
  const entries = [];
  const newestAge = opts.newestSgvAgeMins || 2;
  for (let age = newestAge * MIN, i = 0; age <= 50 * HOUR; age += 5 * MIN, i++) {
    const v = Math.round(140 + 40 * Math.sin(i / 20));
    entries.push(sgvAt(now - age, v));
  }
  for (let age = 6 * HOUR; age <= 50 * HOUR; age += 12 * HOUR) {
    entries.push({ type: 'mbg', mbg: 120, date: now - age, dateString: iso(now - age), device: 'views-equality' });
    entries.push({ type: 'cal', scale: 1, intercept: 25000, slope: 900, date: now - age - MIN, dateString: iso(now - age - MIN), device: 'views-equality' });
  }

  const treatments = [];
  for (let age = 2 * HOUR; age <= 62 * HOUR; age += 4 * HOUR) {
    treatments.push(treatment(now - age, { eventType: 'Meal Bolus', insulin: 3, carbs: 30 }));
  }
  for (let age = 25 * MIN; age <= 62 * HOUR; age += 30 * MIN) {
    treatments.push(treatment(now - age, { eventType: 'Temp Basal', rate: 0.5 + (age / HOUR % 3) / 10, absolute: 0.5 + (age / HOUR % 3) / 10, duration: 30 }));
  }
  treatments.push(treatment(now - 30 * HOUR, { eventType: 'Temporary Target', targetTop: 140, targetBottom: 140, duration: 60, units: 'mg/dl' }));
  treatments.push(treatment(now - 70 * HOUR, { eventType: 'Temporary Target', targetTop: 150, targetBottom: 150, duration: 60, units: 'mg/dl' }));
  treatments.push(treatment(now - (opts.siteAgeHours || 30) * HOUR, { eventType: 'Site Change' }));
  treatments.push(treatment(now - (opts.sensorAgeHours || 50) * HOUR, { eventType: 'Sensor Start' }));
  treatments.push(treatment(now - (opts.insulinAgeHours || 20) * HOUR, { eventType: 'Insulin Change' }));
  treatments.push(treatment(now - (opts.batteryAgeHours || 100) * HOUR, { eventType: 'Pump Battery Change' }));
  // older siblings, which only the newest-of-type lookups must skip
  treatments.push(treatment(now - 40 * DAY, { eventType: 'Site Change' }));
  treatments.push(treatment(now - 10 * DAY, { eventType: 'Profile Switch', profile: 'Default', duration: 0 }));

  const devicestatus = [];
  if (!opts.noDeviceStatus) {
    for (let age = 3 * MIN; age <= 26 * HOUR; age += 5 * MIN) {
      const t = now - age;
      devicestatus.push({
        device: 'openaps://views-equality'
        , created_at: iso(t)
        , uploader: { battery: 80 - Math.floor(age / HOUR) % 20 }
        , pump: { clock: iso(t), battery: { voltage: 1.4 }, reservoir: 100 - age / HOUR, status: { status: 'normal', bolusing: false, suspended: false, timestamp: iso(t) } }
        , openaps: {
          iob: { iob: 1.2, basaliob: 0.1, activity: 0.01, timestamp: iso(t) }
          , suggested: { bg: 140, temp: 'absolute', rate: 0.8, duration: 30, reason: 'synthetic', timestamp: iso(t), COB: 10, IOB: 1.2, eventualBG: 120 }
          , enacted: { bg: 140, temp: 'absolute', rate: 0.8, duration: 30, reason: 'synthetic', timestamp: iso(t), received: true, COB: 10, IOB: 1.2 }
        }
      });
    }
  }
  return { entries, treatments, devicestatus, profile: [profileDoc(now)] };
}

function setNewestSgv (fx, value) {
  const newest = fx.entries.filter(e => e.type === 'sgv').sort((a, b) => b.date - a.date)[0];
  newest.sgv = value;
  newest.filtered = newest.unfiltered = value * 1000;
  return fx;
}

function crowdedStatus (now) {
  const fx = base(now);
  fx.devicestatus = fx.devicestatus.filter(d => Date.parse(d.created_at) <= now - 70 * MIN);
  for (let age = MIN; age < 60 * MIN; age += MIN) {
    fx.devicestatus.push({ device: 'uploader-only', created_at: iso(now - age), uploader: { battery: 70 } });
  }
  return fx;
}

// Scenario name -> builder(now). Each one moves one thing a view depends on.
const SCENARIOS = {
  steady: (now) => base(now)
  , urgentLow: (now) => setNewestSgv(base(now), 48)
  // the newest treatment is 4 minutes old, so treatmentnotify snoozes alarms
  , recentTreatment: (now) => {
    const fx = setNewestSgv(base(now), 48);
    fx.treatments.push(treatment(now - 4 * MIN, { eventType: 'Correction Bolus', insulin: 0.5 }));
    return fx;
  }
  , warnHigh: (now) => setNewestSgv(base(now), 205)
  , stale: (now) => base(now, { newestSgvAgeMins: 45 })
  // IOB and COB come from treatments when no device reports them
  , noDeviceStatus: (now) => setNewestSgv(base(now, { noDeviceStatus: true }), 205)
  // the loop's newest status is 70 min old, and a second uploader has posted a
  // battery-only status every minute since: the 10 newest statuses are all the
  // second uploader's, while the loop and pump alarms read the loop's
  , crowdedStatus: (now) => crowdedStatus(now)
  // as crowdedStatus, with the loop's state and the pump's in separate
  // statuses from separate devices (an uploader that reports the pump on its
  // own), so each is found only by its own kind's query
  , crowdedSeparateKinds: (now) => {
    const fx = crowdedStatus(now);
    fx.devicestatus = fx.devicestatus.map(function (d) {
      if (!d.pump) return d;
      const pumpOnly = { device: 'pump-uploader', created_at: d.created_at, pump: d.pump };
      const loopOnly = Object.assign({}, d);
      delete loopOnly.pump;
      return [loopOnly, pumpOnly];
    }).flat();
    return fx;
  }
  // each change event at or past its urgent age
  , deviceAged: (now) => base(now, { siteAgeHours: 72 + 1 / 6, sensorAgeHours: 7 * 24 - 2 + 1 / 6, insulinAgeHours: 72 + 1 / 6, batteryAgeHours: 312 + 1 / 6 })
};

// ---------------------------------------------------------------- corpus

const TIME_KEYS = new Set(['date', 'mills', 'timestamp', 'deliverAt', 'clock']);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function shiftDeep (value, delta) {
  if (Array.isArray(value)) return value.map(v => shiftDeep(v, delta));
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach(k => {
      const v = value[k];
      if (typeof v === 'number' && TIME_KEYS.has(k) && v > 1e12) out[k] = v + delta;
      else if (typeof v === 'string' && ISO_RE.test(v) && !isNaN(Date.parse(v))) out[k] = new Date(Date.parse(v) + delta).toISOString();
      else out[k] = shiftDeep(v, delta);
    });
    return out;
  }
  return value;
}

function stripIds (doc) {
  const out = Object.assign({}, doc);
  delete out._id;
  return out;
}

function readJson (file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
}

// Corpus sets in VIEWS_CORPUS_DIR, by position. Returns [] when unset.
function corpusNames (dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('_entries.json'))
    .map(f => f.slice(0, -'_entries.json'.length))
    .sort();
}

function loadCorpus (dir, name, now) {
  const raw = {
    entries: readJson(path.join(dir, name + '_entries.json'))
    , treatments: readJson(path.join(dir, name + '_treatments.json'))
    , devicestatus: readJson(path.join(dir, name + '_devicestatus.json'))
    , profile: readJson(path.join(dir, name + '_profile.json'))
  };
  const newest = raw.entries.reduce((m, e) => Math.max(m, Number(e.date) || 0), 0);
  const delta = (now - 2 * MIN) - newest;
  const shifted = {};
  Object.keys(raw).forEach(k => {
    shifted[k] = shiftDeep(raw[k].map(stripIds), delta);
  });
  // A profile document whose startDate falls after the shifted evaluation
  // instant would never be selected; the newest one is what profile.last reads.
  return shifted;
}

module.exports = { SCENARIOS, corpusNames, loadCorpus, MIN, HOUR, DAY };
