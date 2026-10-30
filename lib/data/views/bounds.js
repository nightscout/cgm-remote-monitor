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
// (devicestatusLookback); `info.pumpWindowMs` is the pump plugin's window
// (pumpWindowMs).
//
// The bounds are the ones the equality harness (tests/views-equality.test.js)
// measured equal to the resident output on its fixtures. They are measured,
// not derived: a bound that is not wide enough for some history would show as
// a difference there, and is not to be widened or narrowed without that
// harness.

const constants = require('../../constants');

const HOUR = constants.ONE_HOUR;
const MINUTE = HOUR / 60;

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
// quiet). The newest treatment within those 60 h makes the view's treatments
// empty exactly when the resident path's are. It adds no IOB, being older
// than the window it is added to.
const TREATMENT_CACHE_HOURS = 60;

// `dias` DIAs of treatments, and the newest treatment within
// TREATMENT_CACHE_HOURS.
function treatmentsWindow (now, info, dias) {
  return [
    treatmentsSince(now - dias * info.diaHours * HOUR)
    , { find: { created_at: { $gte: iso(now - TREATMENT_CACHE_HOURS * HOUR) } }, sort: { created_at: -1 }, count: 1 }
  ];
}

// The alarm window of the execution plan's section 7b (EXP-MT-060 section
// 4.3): the 12 newest readings, the newest meter reading and calibration, a
// DIA of treatments and the newest treatment within the resident treatment
// window (treatmentsWindow above), the device statuses below, the newest of each device
// change event and the newest profile switch (the loader's own count: 1
// lookups), and the active profile.
//
// Device status: the 10 newest, the newest of each kind an alarm-path plugin
// selects by, the newest status that passes each test an alarm counts from,
// and every status within the windows the battery and pump alarms read. The
// 10 newest alone are not enough: a second uploader posting every minute fills
// them, and the loop and pump alarms then see no loop or pump status at all
// (scenario crowdedStatus in the equality harness).
//
// A kind is a top-level field a plugin tests with `'<field>' in status`,
// looked for within the resident device-status window (24 h, or 2 days with
// the devicestatus days=2 extended setting):
//   loop      lib/plugins/loop.js:51
//   openaps   lib/plugins/openaps.js:82
//   pump      lib/plugins/pump.js:70
//   uploader  lib/plugins/upbat.js:41; the loader rewrites a legacy
//             uploaderBattery into uploader (lib/data/dataloader.js:541), so
//             that field is a kind of its own here
//   xdripjs   lib/plugins/xdripjs.js:116
// The device IOB and COB the iob and cob plugins read are inside the openaps,
// loop and pump fields (lib/plugins/iob.js:113-115,
// lib/client-core/devicestatus/cob.js:63,81), within 30 minutes.
const DEVICESTATUS_KINDS = ['loop', 'openaps', 'pump', 'uploader', 'uploaderBattery', 'xdripjs'];

// The "isn't looping" alarms count from a status older than the newest of its
// kind whenever the loop is failing, because Loop and AAPS keep uploading:
//   loopOk           Loop uploads every cycle, with failureReason while
//                    dosing fails; the loop alarm counts from the newest
//                    status without one (lib/client-core/devicestatus/loop.js
//                    lastOkMoment). Scenario loopFailing.
//   openapsSuggested AAPS uploads every cycle, with an empty openaps once its
//   openapsEnacted   last run is over 5 minutes old; the openaps alarm counts
//                    from the newer of the newest suggested and the newest
//                    received enacted (lib/client-core/devicestatus/openaps.js
//                    toMoments, lastLoopMoment). `recieved` is the spelling
//                    some uploaders used. Scenario aapsLoopStopped.
// Each is looked for within the 6 hours those plugins read.
const LOOP_HOURS = 6;
const DEVICESTATUS_TESTS = {
  loopOk: { 'loop.timestamp': { $exists: true }, 'loop.failureReason': { $in: [null, ''] } }
  , openapsSuggested: { $or: [{ 'openaps.suggested.timestamp': { $exists: true } }, { 'openaps.suggested.mills': { $exists: true } }] }
  , openapsEnacted: { 'openaps.enacted.timestamp': { $exists: true }, $or: [{ 'openaps.enacted.received': true }, { 'openaps.enacted.recieved': true }] }
};

// The battery and pump alarms read every status in a window, not one status:
//   upbat  the lowest battery within 10 minutes of each device's newest
//          status, over 30 minutes (lib/plugins/upbat.js analyzeData).
//          Scenarios twoUploaders and batteryDip.
//   pump   the status with the newest pump clock, over twice the pump's
//          urgentClock setting (lib/plugins/pump.js setProperties,
//          lib/client-core/devicestatus/pump.js). Scenario pumpRepost.
// The 30 minutes also cover the iob and cob plugins' recency window.
const UPBAT_MINS = 30;

// As the data loader's first device-status load (lib/data/dataloader.js
// loadDeviceStatus), from the same setting.
function devicestatusLookback (env) {
  const ds = env && env.extendedSettings && env.extendedSettings.devicestatus;
  return ds && ds.days && ds.days == 2 ? constants.TWO_DAYS : constants.ONE_DAY;
}

// As the pump plugin's own window (lib/plugins/pump.js getPrefs, urgentClock).
function pumpWindowMs (env) {
  const p = env && env.extendedSettings && env.extendedSettings.pump;
  return 2 * ((p && p.urgentClock) || 60) * MINUTE;
}

function newestStatusOfKind (kind, since) {
  const find = { created_at: { $gte: iso(since) } };
  find[kind] = { $exists: true };
  return { find: find, sort: { created_at: -1 }, count: 1 };
}

function newestStatusPassing (test, since) {
  return { find: Object.assign({ created_at: { $gte: iso(since) } }, test), sort: { created_at: -1 }, count: 1 };
}

function statusesSince (since, kind) {
  const find = { created_at: { $gte: iso(since) } };
  if (kind) find[kind] = { $exists: true };
  return { find: find, sort: { created_at: -1 } };
}

const alarms = {
  entries: () => [newestOfType('sgv', 12), newestOfType('mbg', 1), newestOfType('cal', 1)]
  , treatments: (now, info) => treatmentsWindow(now, info, 1)
  , profileSwitch: 'loader'
  , latest: 'loader'
  , devicestatus: (now, info) => [{ find: {}, sort: { created_at: -1 }, count: 10 }]
    .concat(DEVICESTATUS_KINDS.map(kind => newestStatusOfKind(kind, now - info.devicestatusMs)))
    .concat(Object.values(DEVICESTATUS_TESTS).map(test => newestStatusPassing(test, now - LOOP_HOURS * HOUR)))
    .concat([statusesSince(now - UPBAT_MINS * MINUTE), statusesSince(now - info.pumpWindowMs, 'pump')])
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

// Every property plugin: the alarm window, plus device status over the
// resident device-status window (24 h by default, as long as the longest
// look-back a property plugin takes, xdripjs's 24 h), treatments over
// PROPERTIES_DIAS (with the newest within the resident window, as above), and readings over the same window and the one reading
// before it, since the loader gives each treatment the glucose of the readings
// either side of it (lib/data/treatmenttocurve.js) and the iob and cob plugins
// report it.
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
  , devicestatus: (now, info) => [{ find: { created_at: { $gte: iso(now - info.devicestatusMs) } }, sort: { created_at: -1 } }]
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

module.exports = { alarms, properties, diaHours, devicestatusLookback, pumpWindowMs, DEVICESTATUS_KINDS, DEVICESTATUS_TESTS, PROPERTIES_DIAS, TREATMENT_CACHE_HOURS };
