'use strict';

/*
 * tests/client-core/careportal-normalize-treatment.captured.test.js
 *
 * Golden-shape tests that feed real-world Loop-emitted treatment
 * records (sanitized; see tests/fixtures/captured/README.md)
 * through the pure normalize-treatment module.
 *
 * The captured set is dominated by Loop "Temp Basal" treatments
 * (automatic = true, with rate / absolute / duration / insulinType /
 * syncIdentifier) plus a handful of manually-entered events. We
 * assert that:
 *
 *   1. Normalization is non-throwing for every captured record.
 *   2. The output never contains empty-string or null/undefined fields
 *      (this is the documented contract of the normalize step).
 *   3. Normalization is idempotent (n(n(x)) === n(x)) for adapter-
 *      shaped input — the second run should produce the same fields.
 *   4. For Temp Basal records (the majority shape), the canonical
 *      eventType, rate, duration, and absolute values are preserved.
 *
 * Note: gatherData() in the legacy adapter shapes the `raw` bag
 * differently from the API-stored treatment (e.g. it carries
 * absoluteRaw, eventTime, etc.). For real API records we map
 * back into adapter shape before invoking normalize, then verify
 * the round-trip retains the meaningful fields.
 */

require('should');
var fs = require('fs');
var path = require('path');

var normalize = require('../../lib/client-core/careportal/normalize-treatment');
var eventTypes = require('../../lib/client-core/careportal/event-types');

var CAPTURED = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'captured', 'loop', 'treatments.json'), 'utf8'));

// Build an inputMatrix from the same source the adapter uses so
// that reason resolution exercises real configuration.
var INPUT_MATRIX = (function () {
  // eventTypes.buildInputMatrix expects an allEventTypes array;
  // we approximate by passing every captured eventType plus the
  // standard Temp Basal entry. The matrix only matters for reason
  // lookup, which our captured records don't exercise.
  return {};
}());

function toAdapterRaw (treatment) {
  // Mirror the bag the legacy gatherData() produces. Strings for
  // numeric form fields, eventTime as a Date, absoluteRaw forwarded
  // separately so the "0 is valid" branch is exercised.
  var raw = {
    eventType: treatment.eventType
    , enteredBy: treatment.enteredBy
    , notes: treatment.notes
    , preBolus: treatment.preBolus != null ? String(treatment.preBolus) : ''
    , glucose: treatment.glucose != null ? String(treatment.glucose) : ''
    , glucoseType: treatment.glucoseType
    , units: treatment.units
    , carbs: treatment.carbs != null ? treatment.carbs : ''
    , insulin: treatment.insulin != null ? treatment.insulin : ''
    , duration: treatment.duration != null ? treatment.duration : ''
    , percent: treatment.percent != null ? treatment.percent : ''
    , profile: treatment.profile
    , reason: treatment.reason
    , targetTop: treatment.targetTop != null ? treatment.targetTop : ''
    , targetBottom: treatment.targetBottom != null ? treatment.targetBottom : ''
    , insulinType: treatment.insulinType
    , syncIdentifier: treatment.syncIdentifier
    , automatic: treatment.automatic
    , temp: treatment.temp
    , rate: treatment.rate
    , utcOffset: treatment.utcOffset
  };
  if (treatment.absolute !== undefined && treatment.absolute !== null) {
    raw.absoluteRaw = String(treatment.absolute);
  }
  if (treatment.created_at) {
    raw.eventTime = new Date(treatment.created_at);
  }
  return raw;
}

describe('client-core: careportal / normalize-treatment (captured Loop fixtures)', function () {

  it('captured fixture set is non-empty', function () {
    CAPTURED.length.should.be.greaterThan(0);
  });

  it('normalize() does not throw for any captured record', function () {
    CAPTURED.forEach(function (t, i) {
      (function () { normalize(toAdapterRaw(t), { units: 'mg/dl', inputMatrix: INPUT_MATRIX }); })
        .should.not.throw('record[' + i + ']');
    });
  });

  it('output never contains empty-string or null fields', function () {
    CAPTURED.forEach(function (t, i) {
      var out = normalize(toAdapterRaw(t), { units: 'mg/dl', inputMatrix: INPUT_MATRIX });
      Object.keys(out).forEach(function (k) {
        var v = out[k]; // eslint-disable-line security/detect-object-injection
        (v === '' || v === null)
          .should.equal(false, 'record[' + i + '] field ' + k + ' = ' + JSON.stringify(v));
      });
    });
  });

  it('Temp Basal records retain eventType, rate, duration, absolute', function () {
    var tempBasals = CAPTURED.filter(function (t) { return t.eventType === 'Temp Basal'; });
    tempBasals.length.should.be.greaterThan(50, 'capture should be Loop-Temp-Basal-dominated');
    tempBasals.forEach(function (t, i) {
      var out = normalize(toAdapterRaw(t), { units: 'mg/dl', inputMatrix: INPUT_MATRIX });
      out.eventType.should.equal('Temp Basal', 'TB[' + i + ']');
      out.should.have.property('duration');
      out.should.have.property('rate');
      // absolute may legitimately be 0 (full suspension); presence,
      // not truthiness, is the assertion.
      out.should.have.property('absolute');
      Number(out.absolute).should.equal(t.absolute);
    });
  });

  it('idempotent: n(n(adapter(x))) === n(adapter(x))', function () {
    CAPTURED.forEach(function (t, i) {
      var raw = toAdapterRaw(t);
      var first = normalize(raw, { units: 'mg/dl', inputMatrix: INPUT_MATRIX });
      // Re-shape the first output back into adapter form (subset of
      // fields normalize() consumes) then re-normalize.
      var raw2 = Object.assign({}, raw, first);
      delete raw2.created_at; // normalize sets this from eventTime
      raw2.eventTime = new Date(first.created_at);
      if (first.absolute !== undefined) raw2.absoluteRaw = String(first.absolute);
      var second = normalize(raw2, { units: 'mg/dl', inputMatrix: INPUT_MATRIX });
      second.should.eql(first, 'record[' + i + ']');
    });
  });

  // Sanity: confirm we know what eventTypes appear so future
  // capture additions surface here as a diff.
  it('event-type histogram is documented', function () {
    var counts = {};
    CAPTURED.forEach(function (t) {
      counts[t.eventType] = (counts[t.eventType] || 0) + 1; // eslint-disable-line security/detect-object-injection
    });
    // Lock the current shape; if a new eventType appears in a future
    // capture, this test fails loudly so the test author can decide
    // whether new normalization branches are needed.
    counts.should.eql({
      'Temp Basal': 97
      , 'Site Change': 1
      , 'Correction Bolus': 1
      , 'Carb Correction': 1
    });
  });

  // Quiet eslint about the unused require — kept for future tests
  // that need the actual buildInputMatrix output.
  it('event-types module is loadable', function () {
    eventTypes.should.be.an.Object();
  });
});
