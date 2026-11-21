'use strict';

// When can the evaluator's output change with no new data? (decision
// cost-proportional-to-activity, perf lane EV.) The evaluator runs a time-only
// cycle at the earliest instant returned here instead of every second.
//
// Each rule is the time comparison of a server plugin (lib/plugins/*.js),
// evaluated against the cycle's working set (the same ddata the plugins saw).
// An instant is "the first millisecond at which the comparison can flip": a
// strict `>`/`isAfter`/`isBefore` flips one millisecond after the threshold,
// a `<` flips at it. A candidate at or before `at` is ignored.
//
// Some output changes continuously with time and has no exact next instant:
// the IOB/COB lines and humanized durations in every alarm message
// (lib/sandbox.js buildDefaultMessage, ar2/loop/openaps `from`/formatAgo on
// the wall clock), the bolus wizard preview while insulin decays, xDrip-js
// state notices kept on the wall clock and pump quiet-night hours in the
// profile's time zone. Those set `slow`, and the runtime re-evaluates the
// tenant on its bounded slow timer (timeIntervalMs) while the condition holds.
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR, WEEK = 7 * DAY;

// lib/plugins/{cannulaage,sensorage,insulinage,batteryage}.js getPrefs: info,
// warn, urgent hours. A notification is requested only while the age in whole
// hours equals a threshold and the minutes past that hour are <= 20.
// Each reads its ddata list (lib/data/ddata.js processTreatments: an
// eventType substring filter); sage also matches the event exactly.
const AGES = Object.freeze({
  cage: { list: 'sitechangeTreatments', match: 'Site Change', events: null, hours: [44, 48, 72] },
  sage: { list: 'sensorTreatments', match: 'Sensor', events: ['Sensor Change', 'Sensor Start'], hours: [6 * 24, 7 * 24 - 4, 7 * 24 - 2] },
  iage: { list: 'insulinchangeTreatments', match: 'Insulin Change', events: null, hours: [44, 48, 72] },
  bage: { list: 'batteryTreatments', match: 'Pump Battery Change', events: null, hours: [312, 336, 360] }
});

// lib/plugins/timeago.js resolvers: [limit, divisor]; value is
// max(1, round(timeSince / divisor)), so within a range it changes at each
// half divisor; the label changes at each limit. Past a week it is constant.
const TIMEAGO_RANGES = Object.freeze([[2 * MIN, MIN], [HOUR, MIN], [2 * HOUR, HOUR], [DAY, HOUR], [2 * DAY, DAY], [WEEK, DAY]]);
function timeagoNext (since) {
  for (const [limit, divisor] of TIMEAGO_RANGES) {
    if (since < limit) return Math.min(limit, (Math.floor(since / divisor - 0.5) + 1.5) * divisor);
  }
  return Infinity;
}

const mills = row => {
  if (!row) return NaN;
  if (Number.isFinite(row.mills)) return row.mills;
  const parsed = Date.parse(row.created_at);
  return Number.isFinite(parsed) ? parsed : NaN;
};
const moment = value => (value === null || value === undefined ? NaN : Number(value.valueOf ? value.valueOf() : value));
const list = value => (Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : []);

function nextDue ({ ddata, env, result, at }) {
  const enabled = new Set(env?.settings?.enable || []);
  const settings = env?.settings || {};
  const ext = name => (env?.extendedSettings && env.extendedSettings[name]) || {};
  let dueAt = Infinity, reason = null;
  const add = (instant, why) => { if (Number.isFinite(instant) && instant > at && instant < dueAt) { dueAt = instant; reason = why; } };
  const slow = [];

  const sgvs = list(ddata?.sgvs), treatments = list(ddata?.treatments), statuses = list(ddata?.devicestatus);
  // A record dated in the future enters every "<= sbx.time" filter
  // (lib/sandbox.js lastEntry, the plugins' recent-data filters) when its time comes.
  for (const row of [...sgvs, ...treatments, ...statuses, ...list(ddata?.mbgs), ...list(ddata?.cals)]) add(mills(row), 'record-reaches-now');

  // lib/sandbox.js lastSGVEntry: the last reading in array order not in the future.
  const last = sgvs.slice().reverse().find(row => mills(row) <= at);
  const L = mills(last);
  if (Number.isFinite(L)) {
    if (enabled.has('timeago') && ext('timeago').enableAlerts) {
      // timeago.checkStatus isStale: sbx.time - mills > mins
      const warnMins = settings.alarmTimeagoWarnMins || 15, urgentMins = settings.alarmTimeagoUrgentMins || 30;
      if (settings.alarmTimeagoWarn) add(L + warnMins * MIN + 1, 'timeago-warn');
      if (settings.alarmTimeagoUrgent) add(L + urgentMins * MIN + 1, 'timeago-urgent');
      const stale = (settings.alarmTimeagoWarn && at - L > warnMins * MIN) || (settings.alarmTimeagoUrgent && at - L > urgentMins * MIN);
      // The alarm message carries "Last received: <calcDisplay>".
      if (stale) add(L + timeagoNext(at - L), 'timeago-display');
    }
    // simplealarms.js and errorcodes.js: sbx.time - mills < 10 min; ar2.js: > 10 min stops forecasting.
    if (['simplealarms', 'errorcodes', 'ar2'].some(name => enabled.has(name))) { add(L + 10 * MIN, 'sgv-recent-10'); add(L + 10 * MIN + 1, 'sgv-recent-10'); }
    // lib/sandbox.js isCurrent: sbx.time - mills <= 15 min (boluswizardpreview).
    if (enabled.has('bwp')) {
      add(L + 15 * MIN + 1, 'sgv-current-15');
      if (at - L <= 15 * MIN) slow.push('bwp-current');
    }
  }

  for (const [name, { list: key, match, events, hours }] of Object.entries(AGES)) {
    const prefs = ext(name);
    if (!enabled.has(name) || !prefs.enableAlerts) continue;
    const thresholds = [prefs.info || hours[0], prefs.warn || hours[1], prefs.urgent || hours[2]];
    const rows = Array.isArray(ddata?.[key]) ? ddata[key] : treatments.filter(row => String(row.eventType || '').indexOf(match) > -1);
    for (const event of events || [null]) {
      const latest = rows.filter(row => (event === null || row.eventType === event) && mills(row) <= at).reduce((max, row) => Math.max(max, mills(row)), -Infinity);
      if (!Number.isFinite(latest)) continue;
      for (const h of thresholds) { add(latest + h * HOUR, name + '-threshold'); add(latest + h * HOUR + 21 * MIN, name + '-window-end'); }
    }
  }

  if (enabled.has('treatmentnotify')) {
    // treatmentnotify.js isCurrent: now - mills < 10 min (on the wall clock),
    // for the last non-automated treatment and the last meter reading; every
    // record is a candidate (a superset costs a wake, never a missed change).
    for (const row of [...treatments, ...list(ddata?.mbgs)]) add(mills(row) + 10 * MIN, 'treatmentnotify-recent');
  }
  if (enabled.has('bwp')) {
    // boluswizardpreview.js recentCarbs: sbx.time - mills < 60 min.
    for (const row of treatments) if (row.carbs) add(mills(row) + 60 * MIN, 'bwp-recent-carbs');
  }
  if (enabled.has('openaps')) {
    // openaps.js findOfflineMarker: eventEnd >= sbx.time.
    for (const row of treatments) if (row.eventType === 'OpenAPS Offline') add(mills(row) + (row.duration ? row.duration * MIN : 0) + 1, 'openaps-offline-end');
  }
  // lib/data/views/bounds.js: treatments within the resident cache's 60 h.
  for (const row of treatments) add(mills(row) + 60 * HOUR + 1, 'treatment-window');

  // Device status: the view's look-back and each plugin's recent filter
  // (`>= sbx.time - window` leaves one millisecond after the window).
  const lookback = ext('devicestatus').days == 2 ? 2 * DAY : DAY;
  const loop = ext('loop'), openaps = ext('openaps'), pump = ext('pump');
  const loopWarn = loop.warn || 30, loopUrgent = loop.urgent || 60, apsWarn = openaps.warn || 30, apsUrgent = openaps.urgent || 60;
  const warnClock = pump.warnClock || 30, urgentClock = pump.urgentClock || 60;
  let pumpClock = -Infinity;
  for (const row of statuses) {
    const t = mills(row);
    if (!(t <= at)) continue;
    add(t + lookback + 1, 'devicestatus-window');
    if (enabled.has('upbat') && 'uploader' in row) add(t + 30 * MIN + 1, 'upbat-recent');
    if (enabled.has('loop') && 'loop' in row) { add(t + loopWarn / 2 * MIN + 1, 'loop-recent'); add(t + 6 * HOUR + 1, 'loop-window'); }
    if (enabled.has('openaps') && 'openaps' in row) { add(t + apsWarn / 2 * MIN + 1, 'openaps-recent'); add(t + 6 * HOUR + 1, 'openaps-window'); }
    if (enabled.has('pump') && 'pump' in row) {
      add(t + 2 * urgentClock * MIN + 1, 'pump-recent');
      const clock = Date.parse(row.pump?.clock);
      if (Number.isFinite(clock)) pumpClock = Math.max(pumpClock, clock);
    }
    if (enabled.has('xdripjs') && 'xdripjs' in row) { add(t + DAY + 1, 'xdripjs-window'); slow.push('xdripjs-state'); }
  }
  // pump.js updateClock: moment(sbx.time).subtract(mins).isAfter(clock).
  if (Number.isFinite(pumpClock)) { add(pumpClock + warnClock * MIN + 1, 'pump-clock-warn'); add(pumpClock + urgentClock * MIN + 1, 'pump-clock-urgent'); }
  if (enabled.has('pump') && pump.warnBattQuietNight) slow.push('pump-quiet-night');
  // loop.js / openaps.js statusLevel: last OK + mins isBefore(now).
  const props = result?.properties || {};
  const loopOk = moment(props.loop?.lastOkMoment), apsOk = moment(props.openaps?.lastLoopMoment);
  if (enabled.has('loop') && loop.enableAlerts && Number.isFinite(loopOk)) { add(loopOk + loopWarn * MIN + 1, 'loop-warn'); add(loopOk + loopUrgent * MIN + 1, 'loop-urgent'); }
  if (enabled.has('openaps') && openaps.enableAlerts && Number.isFinite(apsOk)) { add(apsOk + apsWarn * MIN + 1, 'openaps-warn'); add(apsOk + apsUrgent * MIN + 1, 'openaps-urgent'); }

  // Every alarm message carries continuously changing lines.
  if (Array.isArray(result?.requested) && result.requested.some(row => row?.kind === 'notify')) slow.push('alarm-message');

  return Object.freeze({ dueAt: Number.isFinite(dueAt) ? dueAt : null, reason, slow: Object.freeze([...new Set(slow)]) });
}

module.exports = { nextDue, timeagoNext, AGES };
