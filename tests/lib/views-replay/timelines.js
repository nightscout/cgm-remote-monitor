'use strict';

// Synthetic timelines for the ST-VIEWS replay lab (tests/lib/views-replay).
//
// Each timeline is days of uploads, generated here; no record comes from a
// person. The shapes follow tests/lib/views-equality/fixtures.js, which
// follows what the uploaders send (Loop's StoredDosingDecision.deviceStatus,
// AAPS's LoopPlugin.buildAndStoreDeviceStatus). Where the equality fixtures
// hold one instant, a timeline runs the same condition over hours: it starts,
// escalates from WARN to URGENT where the plugin has both levels, and clears.
//
// A record is uploaded at its own time (date, or created_at), or at
// `_uploadAt` when it carries one (a backfill: an uploader that was offline
// and then sends its backlog at once). `_uploadAt` is removed before upload.
//
// A timeline is { name, about, start, end, env, records, acks }:
//   start, end   the first and last replayed minute (ms)
//   env          extra environment for the server (plugin settings)
//   records      { entries, treatments, devicestatus, profile }
//   acks         [{ h, mode: 'active' | 'blind', level, group, mins }]
//                'active' acknowledges the highest alarm the resident path
//                emitted on the minute before (what a person looking at the
//                alarm does); 'blind' acknowledges (level, group) whether or
//                not it is raised. h is hours from T0.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// A fixed origin, so a timeline is the same on every run.
const T0 = Date.UTC(2026, 0, 5, 0, 0, 0);

function iso (ms) { return new Date(ms).toISOString(); }
function hrs (h) { return T0 + Math.round(h * HOUR); }
function inAny (h, ranges) { return ranges.some(r => h >= r[0] && h < r[1]); }

// Piecewise-linear in hours from T0.
function knots (list) {
  return function at (h) {
    if (h <= list[0][0]) return list[0][1];
    for (let i = 1; i < list.length; i++) {
      if (h <= list[i][0]) {
        const [h0, v0] = list[i - 1];
        const [h1, v1] = list[i];
        return v0 + (v1 - v0) * (h - h0) / (h1 - h0);
      }
    }
    return list[list.length - 1][1];
  };
}

function direction (delta) {
  if (delta >= 15) return 'DoubleUp';
  if (delta >= 10) return 'SingleUp';
  if (delta >= 5) return 'FortyFiveUp';
  if (delta > -5) return 'Flat';
  if (delta > -10) return 'FortyFiveDown';
  if (delta > -15) return 'SingleDown';
  return 'DoubleDown';
}

function sgv (t, value, device, prev) {
  const v = Math.max(39, Math.min(400, Math.round(value)));
  return {
    type: 'sgv', sgv: v, date: t, dateString: iso(t), sysTime: iso(t)
    , direction: direction(prev == null ? 0 : v - prev), device: device
    , noise: 1, filtered: v * 1000, unfiltered: v * 1000, rssi: 100
  };
}

// Readings every 5 minutes from `from` to `to` (ms). opts: gaps (hour
// ranges with no reading), backfill ([fromH, toH, uploadH]: readings in the
// range are uploaded at uploadH), offsetMs, device, bump (added to value).
function cgm (from, to, bg, opts) {
  opts = opts || {};
  const out = [];
  let prev = null;
  for (let t = from + (opts.offsetMs || 0); t <= to; t += 5 * MIN) {
    const h = (t - T0) / HOUR;
    if (opts.gaps && inAny(h, opts.gaps)) continue;
    if (opts.only && !inAny(h, opts.only)) continue;
    const v = bg(h) + (opts.bump || 0);
    const e = sgv(t, v, opts.device || 'replay-cgm', prev);
    prev = e.sgv;
    const bf = (opts.backfill || []).find(r => h >= r[0] && h < r[1]);
    if (bf) e._uploadAt = hrs(bf[2]);
    out.push(e);
  }
  return out;
}

function treatment (t, fields, by) {
  return Object.assign({ created_at: iso(t), enteredBy: by || 'views-replay' }, fields);
}

function profileDoc () {
  const at = T0 - 400 * DAY;
  return {
    defaultProfile: 'Default', startDate: iso(at), mills: at, units: 'mg/dl', created_at: iso(at)
    , store: {
      Default: {
        dia: 4
        , carbratio: [{ time: '00:00', value: 10, timeAsSeconds: 0 }]
        , carbs_hr: 30, delay: 20
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

// Temp basals every `everyMins`, at an offset, except in `skip` hour ranges.
function tempBasals (from, to, everyMins, skip, by) {
  const out = [];
  for (let t = from + 25 * MIN; t <= to; t += everyMins * MIN) {
    const h = (t - T0) / HOUR;
    if (inAny(h, skip || [])) continue;
    const rate = Math.round((0.5 + ((t / MIN) % 7) / 10) * 100) / 100;
    out.push(treatment(t, { eventType: 'Temp Basal', rate: rate, absolute: rate, duration: Math.max(everyMins, 30) }, by));
  }
  return out;
}

// A burst of events within seconds of each other (several taps on a phone, or
// an uploader that posts one event several times with fresh times).
function burst (t, offsetsSec, fields) {
  return offsetsSec.map(s => treatment(t + s * 1000, fields));
}

function changeEvents (list) {
  return list.map(([h, eventType, extra]) => treatment(hrs(h), Object.assign({ eventType }, extra || {})));
}

// ------------------------------------------------------------ uploaders

// AAPS: a status every 5 minutes. While its loop has not run for 5 minutes
// it still uploads, with an empty openaps (LoopPlugin.buildAndStoreDeviceStatus).
// AAPS reports the phone battery as the legacy top-level uploaderBattery.
function aapsStatus (t, s) {
  const out = { device: s.device || 'openaps://replay-aaps', created_at: iso(t) };
  if (s.uploaderBattery != null) out.uploaderBattery = s.uploaderBattery;
  if (s.pump) out.pump = s.pump;
  if (s.stopped) {
    out.openaps = {};
    return out;
  }
  const oa = { iob: { iob: 1.1, basaliob: 0.2, activity: 0.01, timestamp: iso(t) } };
  if (!s.noSuggested) oa.suggested = { bg: s.bg, temp: 'absolute', rate: 0.8, duration: 30, reason: 'replay', timestamp: iso(t), COB: 8, IOB: 1.1, eventualBG: s.bg - 10 };
  if (!s.noEnacted) {
    oa.enacted = { bg: s.bg, temp: 'absolute', rate: 0.8, duration: 30, reason: 'replay', timestamp: iso(t), COB: 8, IOB: 1.1 };
    if (!s.pending) oa.enacted.received = true;
  }
  out.openaps = oa;
  return out;
}

// Loop: a status every cycle; with failureReason and no enacted while dosing
// fails (StoredDosingDecision.deviceStatus).
function loopStatus (t, s) {
  const loop = {
    name: 'Loop', version: 'views-replay', timestamp: iso(t)
    , iob: { iob: 1.2, timestamp: iso(t) }
    , cob: { cob: 10, timestamp: iso(t) }
    , predicted: { startDate: iso(t), values: [s.bg, s.bg - 2, s.bg - 4, s.bg - 6] }
  };
  if (s.failing) loop.failureReason = 'replay pump communication error';
  else loop.enacted = { rate: 0.8, duration: 1800, timestamp: iso(t), received: true, bolusVolume: 0 };
  const out = { device: s.device || 'loop://replay-loop', created_at: iso(t), loop: loop };
  if (s.pump) out.pump = s.pump;
  if (s.uploader) out.uploader = s.uploader;
  if (s.override) out.override = s.override;
  return out;
}

function pumpState (clockMs, reservoir, battery) {
  return { clock: iso(clockMs), reservoir: Math.round(reservoir * 10) / 10, battery: battery, status: { status: 'normal', bolusing: false, suspended: false, timestamp: iso(clockMs) } };
}

function xdripjsStatus (t, state) {
  return {
    device: 'xdripjs://replay-logger', created_at: iso(t)
    , xdripjs: { state: state, stateString: state === 6 ? 'OK' : 'Needs Calibration', stateStringShort: state === 6 ? 'OK' : 'Needs Cal', txId: '8XXXXX', txStatus: 0, txStatusString: 'OK', txStatusStringShort: 'OK', txActivation: T0 - 30 * DAY, mode: 'not expired', timestamp: t, rssi: -60, unfiltered: 120000, filtered: 120000, noise: 1, noiseString: 'Clean', slope: 1000, intercept: 0, calType: 'BG', lastCalibrationDate: T0 - DAY, sessionStart: T0 - 3 * DAY, batteryTimestamp: t, voltagea: 310, voltageb: 300, temperature: 30, resistance: 1000 }
  };
}

function every (from, to, stepMs, offsetMs, fn) {
  const out = [];
  for (let t = from + (offsetMs || 0); t <= to; t += stepMs) {
    const r = fn(t, (t - T0) / HOUR);
    if (r) out.push(r);
  }
  return out;
}

// Acknowledgements of whatever the resident path raised the minute before,
// at varied times, with varied silences; plus a few blind ones.
function acksAt (hours, silences, blind) {
  return hours.map((h, i) => ({ h, mode: 'active', mins: silences[i % silences.length] })).concat(blind || []);
}

// ------------------------------------------------------------ timelines

// AAPS (OpenAPS-style status) over two days: the loop stops for 150 minutes
// and for 7 hours (past the 6 h the openaps plugin reads); enacted-only and
// suggested-only stretches before stops; a command pending; the reservoir,
// pump battery and phone battery run down and are replaced; a battery dip;
// two phones; the pump's own uploader stops and a second device re-posts a
// stale pump state every 10 seconds; CGM gaps and a backfill; meals,
// corrections in alarms (treatmentnotify snoozes), an announcement; cannula,
// sensor, insulin and pump-battery ages crossing WARN and URGENT, and a burst
// of Sensor Starts.
function aaps () {
  const start = T0;
  const end = hrs(48);
  const bg = knots([[-50, 120], [-30, 160], [-20, 100], [0, 120], [2, 150], [3, 200], [3.5, 230], [4, 270], [4.5, 285], [5.5, 170],
    [8, 110], [9, 85], [9.5, 75], [10, 60], [10.3, 50], [10.8, 52], [11.5, 90], [14, 140], [20, 250], [21, 300], [22, 200], [24, 120],
    [30, 70], [31, 45], [32, 110], [37, 180], [38, 330], [39, 260], [40, 150], [44, 140], [45, 100], [46, 70], [47, 120], [48, 120]]);
  const stopped = [[6, 8.5], [22, 29], [36, 38.5], [42, 44.5]];
  const res = knots([[-50, 60], [10, 20], [15, 10], [17.5, 5], [17.99, 4], [18, 200], [48, 170]]);
  const pumpBatt = knots([[-50, 80], [30, 32], [33, 28], [36, 18], [36.49, 18], [36.5, 100], [48, 95]]);
  const phoneBatt = knots([[-50, 60], [24, 27], [26, 27], [26.1, 90], [48, 60]]);

  const entries = cgm(hrs(-50), end, bg, { gaps: [[13, 13 + 20 / 60], [16, 16.75]], backfill: [[27, 27 + 40 / 60, 27 + 41 / 60]] });
  const devicestatus = every(hrs(-26), end, 5 * MIN, 30 * 1000, function (t, h) {
    const s = { bg: Math.round(bg(h)), stopped: inAny(h, stopped), noSuggested: inAny(h, [[34, 36]]), noEnacted: inAny(h, [[40, 42]]), pending: inAny(h, [[12, 12.5]]) };
    let batt = Math.round(phoneBatt(h));
    if (Math.abs(h - (25 + 10 / 60)) < 2 / 60) batt = 19;
    if (Math.abs(h - (25 + 20 / 60)) < 2 / 60) batt = 15;
    s.uploaderBattery = batt;
    return aapsStatus(t, s);
  });
  // the pump reports through its own uploader, which stops at 44 h
  devicestatus.push(...every(hrs(-26), hrs(44), 5 * MIN, 40 * 1000, (t, h) => ({ device: 'pump-uploader', created_at: iso(t), pump: pumpState(t, res(h), { percent: Math.round(pumpBatt(h)) }) })));
  // a second device re-posts a pump state 70 minutes older than 44 h every 10 s
  devicestatus.push(...every(hrs(44.5), hrs(46.5), 10 * 1000, 0, (t) => ({ device: 'reposter', created_at: iso(t), pump: pumpState(hrs(44) - 70 * MIN, 50, { voltage: 1.4 }) })));
  // two phones: one posting every minute, one low phone twice
  devicestatus.push(...every(hrs(30), hrs(31), MIN, 5 * 1000, (t) => ({ device: 'phone-1', created_at: iso(t), uploader: { battery: 70 } })));
  devicestatus.push({ device: 'phone-2', created_at: iso(hrs(30) + 5 * MIN), uploader: { battery: 15 } });
  devicestatus.push({ device: 'phone-2', created_at: iso(hrs(31) + 10 * MIN), uploader: { battery: 15 } });

  const treatments = tempBasals(hrs(-62), end, 30, stopped)
    .concat([[2, 40, 4], [8.9, 20, 1], [14, 50, 5], [26, 30, 3], [33, 60, 6], [46, 20, 2]].map(([h, c, i]) => treatment(hrs(h), { eventType: 'Meal Bolus', carbs: c, insulin: i })))
    .concat([[4.6, 2], [21.3, 1.5], [38.3, 2]].map(([h, i]) => treatment(hrs(h), { eventType: 'Correction Bolus', insulin: i })))
    .concat([[10.6, 15], [31.4, 20], [46.2, 10]].map(([h, c]) => treatment(hrs(h), { eventType: 'Carb Correction', carbs: c })))
    .concat([treatment(hrs(18.5), { eventType: 'Announcement', notes: 'replay announcement', isAnnouncement: true })])
    .concat(changeEvents([[-46, 'Site Change'], [30, 'Site Change'], [-160, 'Sensor Start'], [-40, 'Insulin Change'], [18, 'Insulin Change'], [-330, 'Pump Battery Change'], [36.5, 'Pump Battery Change'], [-40 * 24, 'Site Change']]))
    .concat(burst(hrs(12), [0, 4, 9], { eventType: 'Sensor Start' }))
    .concat([treatment(hrs(-240), { eventType: 'Profile Switch', profile: 'Default', duration: 0 }), treatment(hrs(20), { eventType: 'Profile Switch', profile: 'Default', duration: 0 })])
    .concat([treatment(hrs(25), { eventType: 'Temporary Target', targetTop: 140, targetBottom: 140, duration: 60, units: 'mg/dl' }), treatment(hrs(40), { eventType: 'Temporary Target', targetTop: 150, targetBottom: 150, duration: 120, units: 'mg/dl' })]);

  return {
    name: 'aaps', start, end, env: {}
    , about: 'AAPS uploader, two days: loop stopped 150 min and 7 h, enacted-only and suggested-only stretches, command pending, reservoir/pump battery/phone battery run-down and replacement, battery dip, two phones, pump uploader stops and a stale pump state is re-posted every 10 s, CGM gaps and a backfill, meals and corrections inside alarms, an announcement, device ages crossing WARN and URGENT, a Sensor Start burst'
    , records: { entries, treatments, devicestatus, profile: [profileDoc()] }
    , acks: acksAt([3.7, 4.2, 10.4, 13.3, 16.4, 21.1, 26.5, 31.3, 35.2, 38.2, 45.5, 46.9], [15, 30, 60, 120, 5, 45], [
      { h: 8, mode: 'blind', level: 2, group: 'default', mins: 30 }, { h: 23, mode: 'blind', level: 1, group: 'OpenAPS', mins: 240 }])
  };
}

// Loop over two days: dosing fails for 150 minutes, for 7 hours (past the
// 6 h the loop plugin reads, with the pump clock frozen) and for 20 minutes;
// an override; the phone and pump batteries run down; CGM gap with a backfill;
// a burst of Sensor Starts 150 h old, so sage crosses WARN and URGENT from a
// burst; a Sensor Change later.
function loop () {
  const start = T0;
  const end = hrs(48);
  const bg = knots([[-50, 110], [-25, 180], [-15, 90], [0, 130], [1, 190], [2, 240], [2.5, 275], [3.5, 200], [5, 150], [7, 95], [8, 70], [8.5, 52],
    [9.5, 100], [12, 140], [15, 210], [18, 120], [23, 60], [24, 48], [25, 90], [30, 160], [33, 300], [34, 250], [36, 120], [41, 75], [42, 58], [44, 110], [48, 130]]);
  const failing = [[5, 7.5], [20, 27], [35, 35 + 20 / 60]];
  const pumpBatt = knots([[-50, 90], [10, 40], [14, 25], [18, 15], [18.5, 100], [48, 90]]);
  const phoneBatt = knots([[-50, 80], [28, 35], [30, 25], [32, 18], [32.5, 100], [48, 80]]);
  const res = knots([[-50, 120], [48, 40]]);

  const entries = cgm(hrs(-50), end, bg, { device: 'loop://replay-loop', gaps: [], backfill: [[10, 10.5, 10.5 + 1 / 60]] });
  let frozen = null;
  const devicestatus = every(hrs(-26), end, 5 * MIN, 20 * 1000, function (t, h) {
    const fail = inAny(h, failing);
    let clock = t;
    if (inAny(h, [[20, 27]])) { frozen = frozen || t; clock = frozen; } else { frozen = null; }
    return loopStatus(t, {
      bg: Math.round(bg(h)), failing: fail
      , pump: pumpState(clock, res(h), { percent: Math.round(pumpBatt(h)) })
      , uploader: { name: 'replay-phone', timestamp: iso(t), battery: Math.round(phoneBatt(h)) }
      , override: inAny(h, [[12, 14]]) ? { active: true, name: 'Exercise', timestamp: iso(t), duration: 7200, currentCorrectionRange: { minValue: 140, maxValue: 160 } } : undefined
    });
  });

  const treatments = tempBasals(hrs(-62), end, 5, failing, 'loop://replay-loop')
    .concat([[1.5, 45, 4.5], [11, 30, 3], [16, 60, 5], [29, 40, 4], [40, 20, 2]].map(([h, c, i]) => treatment(hrs(h), { eventType: 'Meal Bolus', carbs: c, insulin: i })))
    .concat([[2.6, 1.5], [33.2, 2.5]].map(([h, i]) => treatment(hrs(h), { eventType: 'Correction Bolus', insulin: i })))
    .concat([[8.6, 16], [24.1, 20], [42.1, 12]].map(([h, c]) => treatment(hrs(h), { eventType: 'Carb Correction', carbs: c })))
    .concat(changeEvents([[-30, 'Site Change'], [45, 'Site Change'], [-50, 'Insulin Change'], [-200, 'Pump Battery Change'], [18.5, 'Pump Battery Change'], [40, 'Sensor Change']]))
    .concat(burst(hrs(-150) - 4 * 1000, [0, 3, 6, 9], { eventType: 'Sensor Start' }))
    .concat([treatment(hrs(-100), { eventType: 'Profile Switch', profile: 'Default', duration: 0 })]);

  return {
    name: 'loop', start, end, env: {}
    , about: 'Loop uploader, two days: dosing fails 150 min, 7 h (pump clock frozen) and 20 min; an override; phone and pump batteries run down and are replaced; CGM gap backfilled; a Sensor Start burst straddling a whole hour crosses sage WARN and URGENT; a Sensor Change'
    , records: { entries, treatments, devicestatus, profile: [profileDoc()] }
    , acks: acksAt([2.9, 6.1, 8.8, 14.2, 16.3, 21.5, 24.2, 26.9, 31.7, 33.6, 42.3], [30, 15, 120, 60, 10, 90], [
      { h: 19, mode: 'blind', level: 2, group: 'Loop', mins: 60 }, { h: 30, mode: 'blind', level: 1, group: 'default', mins: 30 }])
  };
}

// Two uploaders for two days: AAPS and xDrip upload the same CGM readings
// (same time and deduplicated; 3 s apart; interleaved 2.5 min apart; then
// xDrip alone); a follower re-uploads every AAPS status and treatment (first
// with the same created_at, then with its own); xDrip phones crowd the newest
// statuses every minute while the AAPS loop is stopped; an xdripjs Logger
// changes state and then stops, crossing the 24 h device-status window.
function twoUploaders () {
  const start = T0;
  const end = hrs(48);
  const bg = knots([[-50, 140], [-10, 90], [0, 110], [3, 220], [4, 280], [6, 150], [9, 80], [10, 52], [11, 100], [16, 190], [18, 120],
    [26, 60], [27, 50], [28, 120], [33, 270], [35, 140], [40, 75], [41, 54], [43, 130], [48, 120]]);
  const stopped = [[30, 32.5], [14, 16.5]];

  const aapsCgm = cgm(hrs(-50), hrs(36), bg, { device: 'AndroidAPS-DexcomG6' });
  const xdrip = cgm(hrs(-50), end, bg, { device: 'xDrip-DexcomG6', only: [[-50, 12], [36, 48.1]] })
    .concat(cgm(hrs(-50), end, bg, { device: 'xDrip-DexcomG6', only: [[12, 24]], offsetMs: 3000 }))
    .concat(cgm(hrs(-50), end, bg, { device: 'xDrip-DexcomG6', only: [[24, 36]], offsetMs: 150 * 1000, bump: 3 }));

  const core = every(hrs(-26), end, 5 * MIN, 30 * 1000, (t, h) => aapsStatus(t, { bg: Math.round(bg(h)), stopped: inAny(h, stopped), uploaderBattery: 55, pump: pumpState(t, 80, { percent: 60 }) }));
  const follower = core.map(function (d) {
    const t = Date.parse(d.created_at);
    const h = (t - T0) / HOUR;
    const copy = JSON.parse(JSON.stringify(d));
    copy._uploadAt = t + 20 * 1000;
    if (h >= 24) copy.created_at = iso(t + 20 * 1000);
    return copy;
  });
  const crowd = every(hrs(6), hrs(8), MIN, 10 * 1000, (t) => ({ device: 'xdrip-phone', created_at: iso(t), uploader: { battery: 64 } }))
    .concat(every(hrs(29.5), hrs(33), MIN, 10 * 1000, (t) => ({ device: 'xdrip-phone', created_at: iso(t), uploader: { battery: 63 } })));
  const lowPhone = [hrs(7) + 3 * MIN, hrs(31) + 7 * MIN, hrs(31) + 40 * MIN].map(t => ({ device: 'old-phone', created_at: iso(t), uploader: { battery: 12 } }));
  const xdripjs = every(hrs(-26), hrs(20), 5 * MIN, 50 * 1000, (t, h) => xdripjsStatus(t, inAny(h, [[2, 4], [15, 15.5]]) ? 7 : 6));

  const aapsTreatments = tempBasals(hrs(-62), end, 30, stopped, 'AndroidAPS')
    .concat([[3.5, 1.5], [33.5, 2]].map(([h, i]) => treatment(hrs(h), { eventType: 'Correction Bolus', insulin: i }, 'AndroidAPS')))
    .concat([[1, 30, 3], [12, 45, 4.5], [22, 40, 4], [38, 30, 3]].map(([h, c, i]) => treatment(hrs(h), { eventType: 'Meal Bolus', carbs: c, insulin: i }, 'AndroidAPS')))
    .concat([[10.2, 15], [27.2, 20], [41.2, 15]].map(([h, c]) => treatment(hrs(h), { eventType: 'Carb Correction', carbs: c }, 'AndroidAPS')));
  const followerTreatments = aapsTreatments.filter(tr => tr.eventType !== 'Temp Basal').map(tr => Object.assign({}, tr, { enteredBy: 'follower', _uploadAt: Date.parse(tr.created_at) + 20 * 1000 }));

  const treatments = aapsTreatments.concat(followerTreatments)
    .concat(changeEvents([[-60, 'Site Change'], [20, 'Site Change'], [-100, 'Sensor Start'], [-70, 'Insulin Change'], [10, 'Insulin Change'], [-340, 'Pump Battery Change'], [44, 'Pump Battery Change']]));

  return {
    name: 'twoUploaders', start, end, env: { XDRIPJS_ENABLE_ALERTS: 'true' }
    , about: 'AAPS and xDrip upload the same readings (deduplicated, 3 s apart, interleaved 2.5 min apart, then xDrip alone); a follower re-uploads every status and treatment; phones crowd the newest statuses every minute while the loop is stopped; an xdripjs Logger changes state and stops, crossing the 24 h window'
    , records: { entries: aapsCgm.concat(xdrip), treatments, devicestatus: core.concat(follower, crowd, lowPhone, xdripjs), profile: [profileDoc()] }
    , acks: acksAt([3.2, 4.1, 7.2, 10.3, 15.1, 26.4, 31.2, 32.1, 41.3], [20, 60, 5, 30, 120], [{ h: 27, mode: 'blind', level: 2, group: 'Uploader Battery', mins: 60 }])
  };
}

// Every device-status kind stops at its own time while CGM continues, so the
// replay crosses each window the bounds name at a known minute: 30 min after
// a phone stops (upbat), twice urgentClock after the pump stops, 6 h after
// the last loop and openaps statuses that pass the alarm tests, and the
// device-status look-back (24 h, or 48 h with DEVICESTATUS_DAYS=2) after each
// kind's last status.
function edges (variant) {
  const two = variant === 'days2';
  const start = T0;
  const end = hrs(two ? 52 : 28);
  const from = hrs(two ? -50 : -26);
  const bg = knots([[-50, 120], [-20, 150], [0, 130], [4, 75], [5, 52], [6, 110], [12, 200], [13, 265], [15, 140], [26, 60], [27, 100], [40, 270], [42, 120], [52, 120]]);
  const entries = cgm(hrs(two ? -74 : -50), end, bg, {});
  const ds = []
    .concat(every(from, hrs(0.5), 5 * MIN, 10 * 1000, (t, h) => xdripjsStatus(t, inAny(h, [[-2, -1]]) ? 7 : 6)))
    .concat(every(from, hrs(1), 5 * MIN, 40 * 1000, (t, h) => ({ device: 'pump-uploader', created_at: iso(t), pump: pumpState(t, 40 - h / 10, { voltage: 1.4 }) })))
    .concat(every(from, hrs(1.5), 5 * MIN, 20 * 1000, (t, h) => loopStatus(t, { bg: Math.round(bg(h)), failing: h >= 1, uploader: { battery: 60 } })))
    .concat(every(from, hrs(3), 5 * MIN, 30 * 1000, (t, h) => aapsStatus(t, { device: 'openaps://edge', bg: Math.round(bg(h)), stopped: h >= 2 })))
    .concat(every(from, hrs(2.5), 5 * MIN, 50 * 1000, (t) => ({ device: 'legacy-uploader', created_at: iso(t), uploaderBattery: 25 })))
    .concat(every(hrs(-2), hrs(3), 5 * MIN, 55 * 1000, (t) => ({ device: 'phone', created_at: iso(t), uploader: { battery: 18 } })));
  const treatments = tempBasals(hrs(two ? -86 : -62), end, 30, [])
    .concat([[4.6, 15], [26.3, 15]].map(([h, c]) => treatment(hrs(h), { eventType: 'Carb Correction', carbs: c })))
    .concat(changeEvents([[-10, 'Site Change'], [-24, 'Sensor Start'], [-20, 'Insulin Change'], [-100, 'Pump Battery Change']]));
  return {
    name: two ? 'edgesDays2' : 'edges', start, end
    , env: two ? { DEVICESTATUS_DAYS: '2', PUMP_URGENT_CLOCK: '45', PUMP_WARN_CLOCK: '20' } : {}
    , about: (two ? 'DEVICESTATUS_DAYS=2, PUMP_URGENT_CLOCK=45, PUMP_WARN_CLOCK=20: ' : 'default settings: ') + 'xdripjs, pump, loop (failing from 1 h), openaps (stopped from 2 h), legacy uploaderBattery and uploader statuses stop at 0.5, 1, 1.5, 3, 2.5 and 3 h while CGM continues; the replay crosses the 30 min, 2 x urgentClock, 6 h and ' + (two ? '48 h' : '24 h') + ' windows for each'
    , records: { entries, treatments, devicestatus: ds, profile: [profileDoc()] }
    , acks: acksAt([1.2, 3.6, 5.1, 7.4, 13.2, 26.2], [30, 60, 15], [{ h: 9, mode: 'blind', level: 2, group: 'Pump', mins: 30 }])
  };
}

// The loop app and the careportal go quiet while CGM continues, then CGM
// stops too: no device status after 0 h and no treatment after 0.5 h, while
// readings cross the high and low alarms until 10 h and stop. Reproduces,
// without corpus data, the difference corpus #2 and #3 showed: once the last
// treatment is a DIA old and no device status is within 30 minutes, the alarm
// message's IOB and COB lines (zero) are in the resident path's message and
// not in the view's. Only when no device-change event (62 days) and no
// profile switch (a year) is stored, as in those two sets.
function quiet () {
  const start = T0;
  const end = hrs(20);
  const bg = knots([[-50, 120], [-10, 160], [0, 140], [2, 200], [3, 270], [4, 290], [5, 200], [6, 120], [7, 70], [7.5, 50], [8.5, 90], [10, 130]]);
  const entries = cgm(hrs(-50), hrs(10), bg, {});
  const devicestatus = every(hrs(-26), hrs(0), 5 * MIN, 30 * 1000, (t, h) => aapsStatus(t, { bg: Math.round(bg(h)), uploaderBattery: 60, pump: pumpState(t, 80, { percent: 60 }) }));
  const treatments = tempBasals(hrs(-62), hrs(0.5), 30, [])
    .concat([[-3, 30, 3], [0.4, 20, 2]].map(([h, c, i]) => treatment(hrs(h), { eventType: 'Meal Bolus', carbs: c, insulin: i })));
  // No device-change event and no profile switch: the view's newest-of-type
  // lookups (lib/data/views/bounds.js 'loader') would otherwise put one in its
  // treatments, and the iob plugin then reports a zero from treatments as the
  // resident path does. The two corpus sets that differed have none.
  return {
    name: 'quiet', start, end, env: {}
    , about: 'device status stops at 0 h and treatments at 0.5 h while CGM continues through high and low alarms, then CGM stops at 10 h (stale-data alarms)'
    , records: { entries, treatments, devicestatus, profile: [profileDoc()] }
    , acks: acksAt([3.5, 7.8, 11.5], [30, 15, 60])
  };
}

const TIMELINES = {
  quiet: quiet,
  aaps: aaps
  , loop: loop
  , twoUploaders: twoUploaders
  , edges: () => edges('default')
  , edgesDays2: () => edges('days2')
};

module.exports = { TIMELINES, T0, MIN, HOUR, DAY };
