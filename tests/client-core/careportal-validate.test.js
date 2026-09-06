'use strict';

/*
 * tests/client-core/careportal-validate.test.js
 *
 * Track 2 / Phase 5a — Node-only mocha tests for the pure
 * lib/client-core/careportal/validate module. No jsdom, no bundle,
 * no fixtures: just `require` and `should`.
 *
 * These exercise the same code paths the legacy
 * tests/careportal.test.js used to drive through the webpack bundle,
 * but at unit-test speed and with full branch coverage.
 */

require('should');
var validate = require('../../lib/client-core/careportal/validate');
var consts = require('../../lib/constants');

describe('client-core/careportal/validate', function () {

  it('passes through non-temporary-target events with no messages', function () {
    var res = validate({ eventType: 'Snack Bolus', duration: 0 }, { units: 'mg/dl' });
    res.allOk.should.be.true();
    res.messages.should.have.length(0);
  });

  it('passes a Temporary Target Cancel (duration === 0) without checking targets', function () {
    var res = validate({ eventType: 'Temporary Target', duration: 0 }, { units: 'mg/dl' });
    res.allOk.should.be.true();
    res.messages.should.have.length(0);
  });

  it('flags missing top/bottom for Temporary Target', function () {
    var res = validate({ eventType: 'Temporary Target', duration: 30, targetTop: '', targetBottom: '' }, { units: 'mg/dl' });
    res.allOk.should.be.false();
    res.messages.should.matchAny(/valid value for both top and bottom/);
  });

  it('flags NaN top for Temporary Target', function () {
    var res = validate({ eventType: 'Temporary Target', duration: 30, targetTop: 'abc', targetBottom: 100 }, { units: 'mg/dl' });
    res.allOk.should.be.false();
    res.messages.should.matchAny(/valid value/);
  });

  it('accepts an in-range Temporary Target in mg/dl', function () {
    var res = validate({ eventType: 'Temporary Target', duration: 30, targetTop: 120, targetBottom: 100 }, { units: 'mg/dl' });
    res.allOk.should.be.true();
    res.messages.should.have.length(0);
  });

  it('rejects a Temporary Target above 18 mmol/L (mg/dl input)', function () {
    var res = validate({ eventType: 'Temporary Target', duration: 30, targetTop: 18 * consts.MMOL_TO_MGDL + 1, targetBottom: 100 }, { units: 'mg/dl' });
    res.allOk.should.be.false();
    res.messages.should.matchAny(/too high/);
  });

  it('rejects a Temporary Target below 4 mmol/L (mg/dl input)', function () {
    var res = validate({ eventType: 'Temporary Target', duration: 30, targetTop: 120, targetBottom: 4 * consts.MMOL_TO_MGDL - 1 }, { units: 'mg/dl' });
    res.allOk.should.be.false();
    res.messages.should.matchAny(/too low/);
  });

  it('rejects an inverted target range (top < bottom)', function () {
    var res = validate({ eventType: 'Temporary Target', duration: 30, targetTop: 90, targetBottom: 110 }, { units: 'mg/dl' });
    res.allOk.should.be.false();
    res.messages.should.matchAny(/low target must be lower/);
  });

  it('accepts Temporary Target in mmol units after conversion', function () {
    // gather() always upconverts mmol → mg/dL before validate() sees the data;
    // the units flag here only affects threshold rounding for messages.
    var res = validate({ eventType: 'Temporary Target', duration: 30, targetTop: 6 * consts.MMOL_TO_MGDL, targetBottom: 5 * consts.MMOL_TO_MGDL }, { units: 'mmol' });
    res.allOk.should.be.true();
  });

  it('rejects Temporary Target above 18 in mmol units', function () {
    var res = validate({ eventType: 'Temporary Target', duration: 30, targetTop: 19 * consts.MMOL_TO_MGDL, targetBottom: 5 * consts.MMOL_TO_MGDL }, { units: 'mmol' });
    res.allOk.should.be.false();
    res.messages.should.matchAny(/too high/);
  });

  it('rejects Temporary Target below 4 in mmol units', function () {
    var res = validate({ eventType: 'Temporary Target', duration: 30, targetTop: 6 * consts.MMOL_TO_MGDL, targetBottom: 3 * consts.MMOL_TO_MGDL }, { units: 'mmol' });
    res.allOk.should.be.false();
    res.messages.should.matchAny(/too low/);
  });

  it('uses default MMOL_TO_MGDL when not provided', function () {
    var res = validate({ eventType: 'Temporary Target', duration: 30, targetTop: 120, targetBottom: 100 }, { units: 'mg/dl' });
    res.allOk.should.be.true();
  });
});
