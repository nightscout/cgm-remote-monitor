'use strict';

// A pump status whose reservoir level comes from reservoir_level_override
// raises the pump alarm at that level (BF-213). Synthetic values only.
//
// Loop's NightscoutService sends reservoir_display_override and
// reservoir_level_override together, from its pump status highlight
// (NightscoutKit PumpStatus: urgent = 2, warn = 1), for states such as
// 'No Insulin', 'No Pod' or 'Signal Loss', with or without a reservoir
// value. The override set the reservoir level but left its message unset,
// so the pump result had no title and requestNotify refused the request
// as incomplete: no alarm was raised.

var should = require('should');
const helper = require('./inithelper')();
const moment = helper.ctx.moment;

var top_ctx = helper.getctx();
top_ctx.language.set('en');

var env = require('../lib/server/env')();
const levels = top_ctx.levels;
const language = top_ctx.language;

var pump = require('../lib/plugins/pump')(top_ctx);
var sandbox = require('../lib/sandbox')(top_ctx);

var now = moment('2026-01-10T12:05:00.000Z');

function loopStatus (pumpFields) {
  var status = {
    created_at: '2026-01-10T12:05:00.000Z'
    , device: 'loop://iPhone'
    , pump: Object.assign({
      clock: '2026-01-10T12:04:00.000Z'
      , pumpID: '1a2b3c'
      , suspended: false
      , bolusing: false
    }, pumpFields)
  };
  status.mills = moment(status.created_at).valueOf();
  return status;
}

function check (pumpFields) {
  var ctx = {
    settings: { units: 'mg/dl' }
    , notifications: require('../lib/notifications')(env, top_ctx)
    , language: language
    , levels: levels
  };
  ctx.notifications.initRequests();

  var refused = [];
  var unmockedError = console.error;
  console.error = function captureError (err) {
    var text = String(err && err.message || err);
    if (text.indexOf('notify isn\'t complete') !== -1) {
      refused.push(text);
      return;
    }
    return unmockedError.apply(console, arguments);
  };

  try {
    var sbx = sandbox.clientInit(ctx, now.valueOf(), { devicestatus: [loopStatus(pumpFields)] });
    sbx.extendedSettings = { 'enableAlerts': true };
    pump.setProperties(sbx);
    pump.checkNotifications(sbx);
  } finally {
    console.error = unmockedError;
  }

  return { highest: ctx.notifications.findHighestAlarm('Pump'), refused: refused };
}

function expectAlarm (result, level, title) {
  result.refused.should.eql([], 'requestNotify refused the pump notification as incomplete');
  should.exist(result.highest, 'no pump alarm raised');
  result.highest.level.should.equal(level);
  result.highest.title.should.equal(title);
  result.highest.message.should.containEql('Pump Reservoir: ');
}

describe('pump: reservoir_level_override raises the alarm (BF-213)', function () {

  it('URGENT override without a reservoir value', function () {
    expectAlarm(check({
      manufacturer: 'Insulet'
      , model: 'Dash'
      , reservoir_display_override: 'No Insulin'
      , reservoir_level_override: 2
    }), levels.URGENT, 'URGENT: Pump No Insulin');
  });

  it('URGENT override with a reservoir value above the thresholds', function () {
    expectAlarm(check({
      manufacturer: 'Medtronic'
      , model: '723'
      , reservoir: 120
      , reservoir_display_override: 'Signal Loss'
      , reservoir_level_override: 2
    }), levels.URGENT, 'URGENT: Pump Signal Loss');
  });

  it('URGENT override without a reservoir value from a pump other than Insulet', function () {
    // Threw "Cannot set properties of null" in prepareData: no pump pill and
    // no pump alarm (clock and battery included) while this was the latest.
    expectAlarm(check({
      manufacturer: 'Medtronic'
      , model: '723'
      , reservoir_display_override: 'Signal Loss'
      , reservoir_level_override: 2
    }), levels.URGENT, 'URGENT: Pump Signal Loss');
  });

  it('WARN override without a reservoir value', function () {
    expectAlarm(check({
      manufacturer: 'Insulet'
      , model: 'Dash'
      , reservoir_display_override: 'No Pod'
      , reservoir_level_override: 1
    }), levels.WARN, 'Warning, Pump No Pod');
  });

  it('WARN override with a reservoir value above the thresholds', function () {
    expectAlarm(check({
      manufacturer: 'Medtronic'
      , model: '723'
      , reservoir: 120
      , reservoir_display_override: 'Insulin Suspended'
      , reservoir_level_override: 1
    }), levels.WARN, 'Warning, Pump Insulin Suspended');
  });

  it('a level below WARN raises no alarm', function () {
    var result = check({
      manufacturer: 'Insulet'
      , model: 'Dash'
      , reservoir_display_override: 'Pod Active'
      , reservoir_level_override: -3
    });
    result.refused.should.eql([]);
    should.not.exist(result.highest);
  });

  it('without an override the reservoir thresholds keep their wording', function () {
    expectAlarm(check({ manufacturer: 'Medtronic', reservoir: 3 }), levels.URGENT, 'URGENT: Pump Reservoir Low');
    expectAlarm(check({ manufacturer: 'Medtronic', reservoir: 8 }), levels.WARN, 'Warning, Pump Reservoir Low');
    should.not.exist(check({ manufacturer: 'Medtronic', reservoir: 120 }).highest);
  });
});
