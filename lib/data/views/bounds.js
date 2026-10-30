'use strict';

// The bounded reads of each computed view (ST-VIEWS): what a view reads
// instead of the resident ddata, written as storage-interface queries (newest
// n of a type, or everything of a type within a time bound).
//
// The data loader (lib/data/dataloader.js) issues nine kinds of read. A view
// answers each kind with one of:
//
//   'loader'   run the loader's own query, unchanged (its count: 1 lookups,
//              the profile, the database statistics)
//   'none'     answer nothing
//   fn(now, info) -> [query, ...]
//              run these queries instead and answer with the union of their
//              results by _id
//
// `info.diaHours` is the largest insulin duration in the profile document;
// `info.devicestatusMs` is the resident device-status window
// (devicestatusLookback).
//
// The bounds are the ones the equality harness (tests/views-equality.test.js)
// measured equal to the resident output on its fixtures, and the replay lab
// (tests/lib/views-replay) minute by minute over days of uploads. They are
// measured, not derived: a bound that is not wide enough for some history
// would show as a difference there, and is not to be widened or narrowed
// without those two.

const constants = require('../../constants');

const HOUR = constants.ONE_HOUR;

function iso (ms) { return new Date(ms).toISOString(); }

function newestOfType (type, n) {
  return { find: { type: type }, sort: { date: -1 }, count: n };
}

function treatmentsSince (ms) {
  return { find: { created_at: { $gte: iso(ms) } }, sort: { created_at: 1 } };
}

// The resident path holds every treatment of its cache's 60 h
// (lib/server/cache.js retentionPeriods; lib/data/dataloader.js
// loadTreatments loads 2.5 days into an empty cache). The iob plugin shows
// "IOB: 0U" from treatments whenever it is given any treatment at all, and no
// line when it is given none (lib/plugins/iob.js calcTotal); cob likewise
// (lib/plugins/cob.js cobTotal), and the alarm messages carry both lines
// (lib/sandbox.js buildDefaultMessage). So the resident path shows the zero
// lines until its newest treatment is 60 h old, while a view that reads only
// DIAs of treatments drops them once the newest is older than that (the
// replay lab: corpus sets #1, #2, #3 and #6, and the synthetic timeline
// quiet). The alarm view reads the whole 60 h (below). The properties view
// reads PROPERTIES_DIAS of treatments and the newest treatment within those
// 60 h, which makes its treatments empty exactly when the resident path's
// are; that one record adds no IOB, being older than the window it is added
// to.
const TREATMENT_CACHE_HOURS = 60;

// `dias` DIAs of treatments, and the newest treatment within
// TREATMENT_CACHE_HOURS.
function treatmentsWindow (now, info, dias) {
  return [
    treatmentsSince(now - dias * info.diaHours * HOUR)
    , { find: { created_at: { $gte: iso(now - TREATMENT_CACHE_HOURS * HOUR) } }, sort: { created_at: -1 }, count: 1 }
  ];
}

// As the data loader's first device-status load (lib/data/dataloader.js
// loadDeviceStatus), from the same setting: 24 h, or 2 days with the
// devicestatus days=2 extended setting.
function devicestatusLookback (env) {
  const ds = env && env.extendedSettings && env.extendedSettings.devicestatus;
  return ds && ds.days && ds.days == 2 ? constants.TWO_DAYS : constants.ONE_DAY;
}

function statusesSince (since) {
  return { find: { created_at: { $gte: iso(since) } }, sort: { created_at: -1 } };
}

// The alarm window of the execution plan's section 7b (EXP-MT-060 section
// 4.3): the 12 newest readings, the newest meter reading and calibration, the
// resident path's treatment and device-status windows, the newest of each
// device change event and the newest profile switch (the loader's own
// count: 1 lookups), and the active profile.
//
// Treatments over the resident cache's 60 h and device status over the
// resident look-back (devicestatusLookback) are not the narrowest windows the
// alarm plugins' own look-backs need; they are what the alarm messages need.
// Each message carries the iob and cob lines (lib/sandbox.js
// buildDefaultMessage), and with no current device COB the cob plugin derives
// COB from treatments (lib/plugins/cob.js fromTreatments): it chains carb
// absorption across every carb entry it is given, and at each earlier
// entry's decay time it takes IOB from a device status within 30 minutes of
// that time when there is one (lib/plugins/iob.js calcTotal). The result
// depends on every treatment and device status the resident path holds. The
// replay lab (tests/lib/views-replay/RESULTS.md, rounds 1 to 3) measured
// narrower bounds: a DIA of treatments drops the "IOB: 0U" and "COB: 0g"
// lines once the newest treatment is older than the DIA, and lowers COB on
// real history; up to 3 DIAs, or 60 h of treatments with device status near
// now only, still change the COB shown. These two windows were exact on
// every timeline and corpus set there.
//
// They also contain what each alarm plugin's own look-back reads: loop and
// openaps 6 h, upbat 30 minutes, pump twice its urgentClock setting, xdripjs
// 24 h, iob and cob 30 minutes. The alarm view reads no narrower targeted
// device-status queries.
const alarms = {
  entries: () => [newestOfType('sgv', 12), newestOfType('mbg', 1), newestOfType('cal', 1)]
  , treatments: (now) => [treatmentsSince(now - TREATMENT_CACHE_HOURS * HOUR)]
  , profileSwitch: 'loader'
  , latest: 'loader'
  , devicestatus: (now, info) => [statusesSince(now - info.devicestatusMs)]
  , profile: 'loader'
  , food: 'none'
  , activity: 'none'
  , dbstats: 'loader'
};

// The treatment window of the properties view, in DIAs. COB from treatments
// (cob.fromTreatments) evaluates insulin activity at the time the previous
// carbs finished decaying, which needs a DIA of treatments before that time;
// on the harness's corpus 1 DIA differs on four fixtures and 2 DIAs on one,
// and 3, 4, 6 and 15 DIAs on none.
const PROPERTIES_DIAS = 3;

// Every property plugin: the alarm window, except treatments over
// PROPERTIES_DIAS (with the newest within the resident window, as above), and
// readings over the same window and the one reading before it, since the
// loader gives each treatment the glucose of the readings either side of it
// (lib/data/treatmenttocurve.js) and the iob and cob plugins report it. The
// equality harness measured this window; the replay lab has not run the
// properties view.
const properties = Object.assign({}, alarms, {
  entries: (now, info) => {
    const since = now - PROPERTIES_DIAS * info.diaHours * HOUR;
    return [
      newestOfType('sgv', 12)
      , { find: { type: 'sgv', date: { $gte: since } }, sort: { date: -1 } }
      , { find: { type: 'sgv', date: { $lt: since } }, sort: { date: -1 }, count: 1 }
      , newestOfType('mbg', 1)
      , newestOfType('cal', 1)
    ];
  }
  , treatments: (now, info) => treatmentsWindow(now, info, PROPERTIES_DIAS)
});

// The largest `dia` in any store of the profile documents, and never less
// than the 3 h the plugins assume when a profile has none.
function diaHours (profileDocs) {
  let dia = 3;
  (profileDocs || []).forEach(function eachProfile (p) {
    Object.values((p && p.store) || {}).forEach(function eachStore (s) {
      const d = Number(s && s.dia);
      if (d > dia) dia = d;
    });
  });
  return dia;
}

module.exports = { alarms, properties, diaHours, devicestatusLookback, PROPERTIES_DIAS, TREATMENT_CACHE_HOURS };
