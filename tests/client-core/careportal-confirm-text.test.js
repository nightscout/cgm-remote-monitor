'use strict';

/*
 * tests/client-core/careportal-confirm-text.test.js
 *
 * Track 2 / Phase 5a — Node-only tests for the pure confirm-text
 * builder. Mirrors the lines the legacy careportal.test.js asserted
 * via `window.confirm(message)` interception, but here we call the
 * pure builder directly and inspect the returned string.
 */

require('should');
var build = require('../../lib/client-core/careportal/confirm-text');
var consts = require('../../lib/constants');

describe('client-core/careportal/confirm-text', function () {

  function lines(s) { return s.split('\n'); }

  it('always emits the verify header and event-type line', function () {
    var out = build({ eventType: 'Snack Bolus' }, {});
    var ls = lines(out);
    ls[0].should.match(/Please verify/);
    ls[1].should.match(/Event Type: Snack Bolus/);
  });

  it('uses the injected translate fn for static labels', function () {
    var out = build({ eventType: 'Snack Bolus' }, {
      translate: function (s) { return s === 'Event Type' ? 'Tipo' : s; }
    });
    out.should.match(/Tipo: Snack Bolus/);
  });

  it('routes the event-type through resolveEventName', function () {
    var out = build({ eventType: 'Meal Bolus' }, {
      resolveEventName: function () { return 'Meal'; }
    });
    out.should.match(/Event Type: Meal/);
  });

  it('appends "Cancel" to the event line for a Temporary Target with duration 0', function () {
    var out = build({ eventType: 'Temporary Target', duration: 0 }, {});
    out.should.match(/Event Type: Temporary Target Cancel/);
  });

  it('includes glucose, carbs, insulin, notes, enteredBy when present', function () {
    var out = build({
      eventType: 'Snack Bolus'
      , glucose: 100
      , glucoseType: 'Finger'
      , carbs: 10
      , insulin: 0.6
      , preBolus: 15
      , notes: 'Testing'
      , enteredBy: 'Dad'
    }, {});
    out.should.match(/Blood Glucose: 100/);
    out.should.match(/Measurement Method: Finger/);
    out.should.match(/Carbs Given: 10/);
    out.should.match(/Insulin Given: 0\.6/);
    out.should.match(/Carb Time: 15 mins/);
    out.should.match(/Notes: Testing/);
    out.should.match(/Entered By: Dad/);
  });

  it('omits optional fields when falsy', function () {
    var out = build({ eventType: 'Snack Bolus' }, {});
    out.should.not.match(/Carbs Given/);
    out.should.not.match(/Insulin Given/);
    out.should.not.match(/Notes/);
  });

  it('rounds mmol target values to 1 decimal', function () {
    var top = 6.5 * consts.MMOL_TO_MGDL;
    var bot = 5.4 * consts.MMOL_TO_MGDL;
    var out = build({
      eventType: 'Temporary Target', duration: 30, targetTop: top, targetBottom: bot
    }, { units: 'mmol' });
    out.should.match(/Target Top: 6\.5/);
    out.should.match(/Target Bottom: 5\.4/);
  });

  it('emits Combo Bolus split percentages', function () {
    var out = build({ eventType: 'Combo Bolus', splitNow: 60, splitExt: 40 }, {});
    out.should.match(/Combo Bolus: 60% : 40%/);
  });

  it('emits Basal value when "absolute" key exists (even if 0)', function () {
    var out = build({ eventType: 'Temp Basal', absolute: 0 }, {});
    out.should.match(/Basal value: 0/);
  });

  it('uses opts.now for the Event Time fallback', function () {
    var fixed = new Date('2024-01-02T03:04:05Z');
    var out = build({ eventType: 'Snack Bolus' }, { now: fixed });
    out.should.match(/Event Time: /);
    var lastLine = lines(out).pop();
    lastLine.should.equal('Event Time: ' + fixed.toLocaleString());
  });

  it('uses data.eventTime.toLocaleString() when provided', function () {
    var t = new Date('2024-06-01T12:00:00Z');
    var out = build({ eventType: 'Snack Bolus', eventTime: t }, {});
    var lastLine = lines(out).pop();
    lastLine.should.equal('Event Time: ' + t.toLocaleString());
  });
});
