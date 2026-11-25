'use strict';

// The due instant of a time-only evaluator cycle (lib/data/evaluator-due.js),
// checked against the actual plugins: at the due instant the plugin's output
// differs from one millisecond before it. Synthetic data only.
// covers: lib/data/evaluator-due.js
const assert = require('node:assert/strict');
const { nextDue, timeagoNext } = require('../lib/data/evaluator-due');
const levels = require('../lib/levels');

const MIN = 60000, HOUR = 60 * MIN;
const t0 = Date.UTC(2026, 10, 10, 12);
function environment (enable, settings = {}, extendedSettings = {}) {
  const env = require('../lib/server/tenant-app/environment')({ settings: { enable, ...settings } });
  env.extendedSettings = extendedSettings;
  return env;
}
function evaluate (env, ddataFields, at) {
  const view = require('../lib/data/views')(env, { language: require('../lib/language')(), levels, moment: require('moment-timezone') });
  const ddata = require('../lib/data/ddata')(); ddata.lastUpdated = at; Object.assign(ddata, structuredClone(ddataFields));
  const result = view.evaluateCycle({ now: at, ddata });
  return { result, due: nextDue({ ddata, env, result, at }) };
}
const alarms = result => result.requested.filter(r => r.kind === 'notify').map(r => r.plugin?.name + ':' + r.level).sort().join(',');

describe('evaluator due instants follow the plugins\' time comparisons', function () {
  it('timeago: warn and urgent onsets are the first instants the stale-data alarm changes', function () {
    const env = environment(['bgnow', 'delta', 'direction', 'timeago'], { alarmTimeagoWarn: true, alarmTimeagoWarnMins: 15,
      alarmTimeagoUrgent: true, alarmTimeagoUrgentMins: 30 }, { timeago: { enableAlerts: true } });
    const data = { sgvs: [{ _id: 's', mgdl: 120, mills: t0, type: 'sgv', direction: 'Flat' }] };
    const fresh = evaluate(env, data, t0 + MIN);
    assert.equal(fresh.due.dueAt, t0 + 15 * MIN + 1, 'EV_DUE_TIMEAGO_WARN');
    assert.equal(alarms(evaluate(env, data, fresh.due.dueAt - 1).result), '');
    assert.equal(alarms(evaluate(env, data, fresh.due.dueAt).result), 'timeago:1');
    const warn = evaluate(env, data, t0 + 15 * MIN + 1);
    assert.deepEqual(warn.due.slow, ['alarm-message'], 'an active alarm message changes continuously');
    const urgentAt = t0 + 30 * MIN + 1;
    assert.equal(alarms(evaluate(env, data, urgentAt - 1).result), 'timeago:1');
    assert.equal(alarms(evaluate(env, data, urgentAt).result), 'timeago:2', 'EV_DUE_TIMEAGO_URGENT');
    assert.ok(warn.due.dueAt <= urgentAt);
  });
  it('timeago display: the next instant the "Last received" value or label changes', function () {
    assert.equal(timeagoNext(30 * 1000), 90 * 1000, 'round(1.5) = 2 at 90 s');
    assert.equal(timeagoNext(16 * MIN), 16.5 * MIN);
    assert.equal(timeagoNext(59.6 * MIN), HOUR, 'label changes at one hour');
    assert.equal(timeagoNext(3 * HOUR), 3.5 * HOUR);
    assert.equal(timeagoNext(8 * 24 * HOUR), Infinity, 'constant past a week');
  });
  it('cannula age: a notification only in the 20 minutes after each threshold hour', function () {
    const env = environment(['cage'], {}, { cage: { enableAlerts: true, info: 2, warn: 3, urgent: 4 } });
    const change = { _id: 'c', eventType: 'Site Change', mills: t0, created_at: new Date(t0).toISOString() };
    const data = { treatments: [change], sitechangeTreatments: [change] }; // as ddata.processTreatments lists it
    const before = evaluate(env, data, t0 + HOUR);
    assert.equal(before.due.dueAt, t0 + 2 * HOUR);
    assert.equal(alarms(evaluate(env, data, t0 + 2 * HOUR - 1).result), '');
    assert.equal(alarms(evaluate(env, data, t0 + 2 * HOUR).result), 'cage:0', 'EV_DUE_AGE_THRESHOLD');
    const inside = evaluate(env, data, t0 + 2 * HOUR);
    assert.equal(inside.due.dueAt, t0 + 2 * HOUR + 21 * MIN);
    assert.equal(alarms(evaluate(env, data, inside.due.dueAt - 1).result), 'cage:0');
    assert.equal(alarms(evaluate(env, data, inside.due.dueAt).result), '', 'EV_DUE_AGE_WINDOW_END');
  });
  it('simple alarms: a reading stops alarming ten minutes after it was taken', function () {
    const env = environment(['bgnow', 'delta', 'direction', 'simplealarms'], { alarmUrgentLow: true, alarmLow: true,
      thresholds: { bgHigh: 250, bgTargetTop: 180, bgTargetBottom: 80, bgLow: 55 } });
    const data = { sgvs: [{ _id: 's', mgdl: 45, mills: t0, type: 'sgv', direction: 'Flat' }] };
    const low = evaluate(env, data, t0 + MIN);
    assert.equal(alarms(low.result), 'simplealarms:2');
    assert.equal(low.due.dueAt, t0 + 10 * MIN);
    assert.equal(alarms(evaluate(env, data, t0 + 10 * MIN - 1).result), 'simplealarms:2');
    assert.equal(alarms(evaluate(env, data, t0 + 10 * MIN).result), '', 'EV_DUE_SGV_RECENCY');
  });
  it('a quiet tenant with nothing time-dependent has no due instant and no slow timer', function () {
    const env = environment(['bgnow', 'delta', 'direction', 'simplealarms', 'treatmentnotify']);
    const old = { sgvs: [{ _id: 's', mgdl: 120, mills: t0 - 2 * HOUR, type: 'sgv', direction: 'Flat' }] };
    const quiet = evaluate(env, old, t0);
    assert.deepEqual([quiet.due.dueAt, quiet.due.slow], [null, []], 'EV_IDLE_NO_TIMER');
  });
});
