'use strict';

/*
 * tests/client-core/careportal-normalize-treatment.test.js
 *
 * Track 2 / Phase 5a — Node-only tests for the pure
 * normalize-treatment module. Drives every branch the legacy
 * gatherData() closure used to: reason resolution, mmol→mg/dL,
 * absolute-supports-zero, eventTime/created_at, profile drop,
 * Temp Basal / Temporary Target Cancel / Combo Bolus fixups,
 * and empty/null stripping.
 */

require('should');
var normalize = require('../../lib/client-core/careportal/normalize-treatment');
var consts = require('../../lib/constants');

describe('client-core/careportal/normalize-treatment', function () {

  var fixedNow = new Date('2024-01-02T03:04:05Z');

  function baseRaw(extra) {
    var raw = { eventType: 'Snack Bolus' };
    if (extra) Object.keys(extra).forEach(function (k) { raw[k] = extra[k]; });
    return raw;
  }

  it('drops empty and null fields from the result', function () {
    var raw = baseRaw({ enteredBy: '', notes: null, carbs: '10' });
    var out = normalize(raw, { now: fixedNow });
    out.should.not.have.property('enteredBy');
    out.should.not.have.property('notes');
    out.carbs.should.equal('10');
  });

  it('parses preBolus to int and drops it when NaN', function () {
    normalize(baseRaw({ preBolus: '15' }), { now: fixedNow }).preBolus.should.equal(15);
    normalize(baseRaw({ preBolus: 'abc' }), { now: fixedNow }).should.not.have.property('preBolus');
    normalize(baseRaw({}), { now: fixedNow }).should.not.have.property('preBolus');
  });

  it('attaches reasonDisplay when reason matches a row in inputMatrix', function () {
    var matrix = {
      'Temporary Target': { reasons: [{ name: 'Eating Soon', displayName: 'Eating Soon (display)' }] }
    };
    var out = normalize(baseRaw({
      eventType: 'Temporary Target', reason: 'Eating Soon', duration: 30
      , targetTop: 120, targetBottom: 100
    }), { inputMatrix: matrix, now: fixedNow });
    out.reasonDisplay.should.equal('Eating Soon (display)');
  });

  it('omits reasonDisplay when reason does not match', function () {
    var matrix = { 'Temporary Target': { reasons: [{ name: 'Other', displayName: 'Other' }] } };
    var out = normalize(baseRaw({
      eventType: 'Temporary Target', reason: 'Missing', duration: 30
    }), { inputMatrix: matrix, now: fixedNow });
    out.should.not.have.property('reasonDisplay');
  });

  it('upconverts mmol target values to mg/dL', function () {
    var out = normalize(baseRaw({
      eventType: 'Temporary Target', duration: 30, targetTop: 6, targetBottom: 5
    }), { units: 'mmol', now: fixedNow });
    out.targetTop.should.be.approximately(6 * consts.MMOL_TO_MGDL, 0.001);
    out.targetBottom.should.be.approximately(5 * consts.MMOL_TO_MGDL, 0.001);
  });

  it('preserves mg/dL targets unchanged when units != mmol', function () {
    var out = normalize(baseRaw({
      eventType: 'Temporary Target', duration: 30, targetTop: 120, targetBottom: 100
    }), { units: 'mg/dl', now: fixedNow });
    out.targetTop.should.equal(120);
    out.targetBottom.should.equal(100);
  });

  it('sets data.absolute when absoluteRaw is a numeric string (including "0")', function () {
    normalize(baseRaw({ absoluteRaw: '0.8' }), { now: fixedNow }).absolute.should.equal(0.8);
    normalize(baseRaw({ absoluteRaw: '0' }), { now: fixedNow }).absolute.should.equal(0);
  });

  it('omits data.absolute when absoluteRaw is empty or non-numeric', function () {
    normalize(baseRaw({ absoluteRaw: '' }), { now: fixedNow }).should.not.have.property('absolute');
    normalize(baseRaw({ absoluteRaw: 'abc' }), { now: fixedNow }).should.not.have.property('absolute');
  });

  it('uses opts.now for created_at when no eventTime is supplied', function () {
    var out = normalize(baseRaw(), { now: fixedNow });
    out.created_at.should.equal(fixedNow.toISOString());
  });

  it('uses data.eventTime for created_at when supplied', function () {
    var t = new Date('2024-06-01T12:00:00Z');
    var out = normalize(baseRaw({ eventTime: t }), { now: fixedNow });
    out.created_at.should.equal(t.toISOString());
  });

  it('drops profile when the eventType row in inputMatrix has profile=false', function () {
    var matrix = { 'Snack Bolus': { profile: false } };
    var out = normalize(baseRaw({ profile: 'Default' }), { inputMatrix: matrix, now: fixedNow });
    out.should.not.have.property('profile');
  });

  it('keeps profile when the eventType row has profile=true', function () {
    var matrix = { 'Profile Switch': { profile: true } };
    var out = normalize(baseRaw({ eventType: 'Profile Switch', profile: 'Default' })
      , { inputMatrix: matrix, now: fixedNow });
    out.profile.should.equal('Default');
  });

  it('normalises any "Temp Basal" variant to "Temp Basal"', function () {
    var matrix = { 'Temp Basal Start': { profile: false } };
    var out = normalize(baseRaw({ eventType: 'Temp Basal Start', percent: 110 })
      , { inputMatrix: matrix, now: fixedNow });
    out.eventType.should.equal('Temp Basal');
  });

  it('handles "Temporary Target Cancel" by setting duration=0 and clearing targets', function () {
    var matrix = { 'Temporary Target Cancel': { profile: false } };
    var out = normalize(baseRaw({
      eventType: 'Temporary Target Cancel', targetTop: 120, targetBottom: 100, duration: 30
    }), { inputMatrix: matrix, now: fixedNow });
    out.eventType.should.equal('Temporary Target');
    out.duration.should.equal(0);
    out.should.not.have.property('targetTop');
    out.should.not.have.property('targetBottom');
  });

  it('attaches splitNow/splitExt for Combo Bolus from the *Raw fields', function () {
    var matrix = { 'Combo Bolus': { profile: false } };
    var out = normalize(baseRaw({
      eventType: 'Combo Bolus', splitNowRaw: '60', splitExtRaw: '40'
    }), { inputMatrix: matrix, now: fixedNow });
    out.splitNow.should.equal(60);
    out.splitExt.should.equal(40);
    out.should.not.have.property('splitNowRaw');
    out.should.not.have.property('splitExtRaw');
  });

  it('does not mutate the input raw object', function () {
    var raw = baseRaw({ targetTop: 6, targetBottom: 5, eventType: 'Temporary Target', duration: 30 });
    var snap = JSON.stringify(raw);
    normalize(raw, { units: 'mmol', now: fixedNow });
    JSON.stringify(raw).should.equal(snap);
  });
});
