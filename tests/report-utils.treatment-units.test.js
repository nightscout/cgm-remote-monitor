'use strict';

require('should');
const moment = require('moment');

// The day-to-day report places a treatment's glucose bubble with
// report_plugins.utils.scaledTreatmentBG. A treatment's units may be spelled
// 'mmol', 'mmol/L' or 'mmol/l' (and 'mg/dl' or 'mg/dL'); each is read as the
// profile and the tooltip read it, so the bubble sits at the treatment's own
// glucose in the display units (BF-157).
describe('report utils: a treatment glucose in either spelling of its units', function () {
  let priorWindow;

  function scaledTreatmentBG (displayUnits, treatment) {
    const settings = { units: displayUnits };
    const utils = require('../lib/utils')({
      moment: moment
      , settings: settings
      , language: { translate: value => value }
    });
    global.window = {
      moment: moment
      , Nightscout: { client: { settings: settings, utils: utils } }
    };
    delete require.cache[require.resolve('../lib/report_plugins/utils')];
    const reportUtils = require('../lib/report_plugins/utils')();
    // No readings near the treatment, so a glucose that is not used falls back to 450 mg/dl
    return reportUtils.scaledTreatmentBG(Object.assign({ mills: Date.now() }, treatment), []);
  }

  beforeEach(function () {
    priorWindow = global.window;
  });

  afterEach(function () {
    delete require.cache[require.resolve('../lib/report_plugins/utils')];
    if (priorWindow === undefined) delete global.window;
    else global.window = priorWindow;
  });

  it('an mmol treatment on an mmol site is placed at its own value', function () {
    scaledTreatmentBG('mmol', { glucose: 7, units: 'mmol' }).should.equal(7);
  });

  it('an mmol/L treatment on an mmol site is placed at its own value', function () {
    scaledTreatmentBG('mmol', { glucose: 7, units: 'mmol/L' }).should.equal(7);
  });

  it('an mmol/L treatment on an mg/dl site is converted to mg/dl', function () {
    scaledTreatmentBG('mg/dl', { glucose: 7, units: 'mmol/L' }).should.equal(126);
  });

  it('an mmol/l treatment on an mg/dl site is converted to mg/dl', function () {
    scaledTreatmentBG('mg/dl', { glucose: 7, units: 'mmol/l' }).should.equal(126);
  });

  it('an mg/dl treatment on an mmol site is converted to mmol', function () {
    scaledTreatmentBG('mmol', { glucose: 126, units: 'mg/dl' }).should.equal(7);
  });

  it('an mg/dL treatment on an mmol site is converted to mmol', function () {
    scaledTreatmentBG('mmol', { glucose: 126, units: 'mg/dL' }).should.equal(7);
  });

  it('an mg/dL treatment on an mg/dl site is placed at its own value', function () {
    scaledTreatmentBG('mg/dl', { glucose: 126, units: 'mg/dL' }).should.equal(126);
  });
});
