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
// measured equal to the resident output on its fixtures. They are measured,
// not derived: a bound that is not wide enough for some history would show as
// a difference there, and is not to be widened or narrowed without that
// harness.

const constants = require('../../constants');

const HOUR = constants.ONE_HOUR;

function iso (ms) { return new Date(ms).toISOString(); }

function newestOfType (type, n) {
  return { find: { type: type }, sort: { date: -1 }, count: n };
}

function treatmentsSince (ms) {
  return { find: { created_at: { $gte: iso(ms) } }, sort: { created_at: 1 } };
}

// The alarm window of the execution plan's section 7b (EXP-MT-060 section
// 4.3): the 12 newest readings, the newest meter reading and calibration, a
// DIA of treatments, the device statuses below, the newest of each device
// change event and the newest profile switch (the loader's own count: 1
// lookups), and the active profile.
//
// Device status: the 10 newest, and the newest of each kind an alarm-path
// plugin selects by, within the resident device-status window (24 h, or 2 days
// with the devicestatus days=2 extended setting). The 10 newest alone are not
// enough: a second uploader posting every minute fills them, and the loop and
// pump alarms then see no loop or pump status at all (scenario crowdedStatus
// in the equality harness).
//
// A kind is a top-level field a plugin tests with `'<field>' in status`:
//   loop      lib/plugins/loop.js:51
//   openaps   lib/plugins/openaps.js:82
//   pump      lib/plugins/pump.js:70
//   uploader  lib/plugins/upbat.js:41; the loader rewrites a legacy
//             uploaderBattery into uploader (lib/data/dataloader.js:541), so
//             that field is a kind of its own here
//   xdripjs   lib/plugins/xdripjs.js:116
// The device IOB and COB the iob and cob plugins read are inside the openaps,
// loop and pump fields (lib/plugins/iob.js:113-115,
// lib/client-core/devicestatus/cob.js:63,81).
const DEVICESTATUS_KINDS = ['loop', 'openaps', 'pump', 'uploader', 'uploaderBattery', 'xdripjs'];

// As the data loader's first device-status load (lib/data/dataloader.js
// loadDeviceStatus), from the same setting.
function devicestatusLookback (env) {
  const ds = env && env.extendedSettings && env.extendedSettings.devicestatus;
  return ds && ds.days && ds.days == 2 ? constants.TWO_DAYS : constants.ONE_DAY;
}

function newestStatusOfKind (kind, since) {
  const find = { created_at: { $gte: iso(since) } };
  find[kind] = { $exists: true };
  return { find: find, sort: { created_at: -1 }, count: 1 };
}

const alarms = {
  entries: () => [newestOfType('sgv', 12), newestOfType('mbg', 1), newestOfType('cal', 1)]
  , treatments: (now, info) => [treatmentsSince(now - info.diaHours * HOUR)]
  , profileSwitch: 'loader'
  , latest: 'loader'
  , devicestatus: (now, info) => [{ find: {}, sort: { created_at: -1 }, count: 10 }]
    .concat(DEVICESTATUS_KINDS.map(kind => newestStatusOfKind(kind, now - info.devicestatusMs)))
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
// PROPERTIES_DIAS, and readings over the same window and the one reading
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
  , treatments: (now, info) => [treatmentsSince(now - PROPERTIES_DIAS * info.diaHours * HOUR)]
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

module.exports = { alarms, properties, diaHours, devicestatusLookback, DEVICESTATUS_KINDS, PROPERTIES_DIAS };
