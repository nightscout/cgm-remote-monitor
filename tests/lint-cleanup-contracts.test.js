'use strict';

const assert = require('node:assert/strict');

describe('plugin outputs across lint cleanup', function () {
  it('preserves raw glucose results across calibration and display branches over repeated calls', function () {
    const rawbg = require('../lib/plugins/rawbg')({language: {translate: key => key}});
    const reading = {unfiltered: 120, filtered: 100, mgdl: 80};
    const calibration = {slope: 2, intercept: 20, scale: 1};
    const cases = [
      [{}, {}, 'unsmoothed', 100],
      [{}, {}, 'unfiltered', 50],
      [{}, {}, 'filtered', 40],
      [{filtered: 0}, {}, 'unsmoothed', 50],
      [{mgdl: 30}, {}, 'unsmoothed', 50],
      [{}, {slope: 0}, 'unsmoothed', 0],
      [{}, {scale: 0}, 'unsmoothed', 0],
      [{unfiltered: 0}, {}, 'unsmoothed', 0]
    ];
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const [sgv, cal, display, expected] of cases) {
        assert.equal(rawbg.calc({...reading, ...sgv}, {...calibration, ...cal}, {extendedSettings: {display}}), expected);
      }
    }
  });

  it('preserves basal translation call order and selected output for normal and temporary basal', function () {
    const calls = [];
    const basal = require('../lib/plugins/basalprofile')({moment: require('moment'), language: {translate(key) {calls.push(key); return key;}}});
    const time = 1700000000000;
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const temporary of [false, true]) {
        calls.length = 0;
        const sbx = {time, data: {profile: {getTempBasal() {return {totalbasal: 0.175, treatment: temporary ? {endmills: time + 1800000} : null};}}}};
        let response;
        basal.virtAsst.rollupHandlers[0].rollupHandler([], sbx, (error, result) => {assert.ifError(error); response = result;});
        const key = temporary ? 'virtAsstBasalTemp' : 'virtAsstBasal';
        assert.deepEqual(calls, ['virtAsstUnknown', 'virtAsstPreamble', key]);
        assert.deepEqual(response, {results: key, priority: 1});
      }
    }
  });
});
