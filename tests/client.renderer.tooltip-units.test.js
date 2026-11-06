'use strict';

require('should');
var createSecureDOM = require('./fixtures/secure-jsdom').createSecureDOM;
var domGlobals = require('./fixtures/dom-globals');

// The chart tooltip of a treatment shows its BG in the display units. The BG
// is stored in the record's own units: the careportal writes the display units
// (lib/client/careportal.js gatherData, units: client.settings.units); a record
// without units is taken to be in the profile's units. (#5940)
describe('renderer treatment tooltip BG units', function () {
  var env;
  var state;
  var priorD3;
  var d3;

  beforeEach(function () {
    priorD3 = global.d3;
    d3 = global.d3 = require('./fixtures/d3');
    delete global.window;
    delete global.document;
    env = createSecureDOM('<!DOCTYPE html><html><body></body></html>');
    state = domGlobals.installDomGlobals(env);
  });

  afterEach(function () {
    delete require.cache[require.resolve('../lib/client/renderer')];
    if (priorD3 === undefined) delete global.d3;
    else global.d3 = priorD3;
    domGlobals.restoreDomGlobals(state);
  });

  function setup (displayUnits, profileUnits) {
    var tooltip = d3.select(env.document.body).append('div').append('div').attr('id', 'tooltip');
    var svg = d3.select(env.document.body).append('svg');
    var client = {
      careportal: { resolveEventName: function (value) { return value; } }
      , chart: {
        basals: svg.append('g')
        , drag: svg.append('g')
        , focus: svg.append('g')
        , prevChartWidth: 900
        , xScale: function () { return 0; }
        , yScale: function () { return 0; }
      }
      , ddata: { profile: { getUnits: function () { return profileUnits; } } }
      , editMode: false
      , focusRangeMS: 1
      , formatTime: function () { return '12:00'; }
      , sbx: { scaleEntry: function () { return 100; } }
      , settings: { units: displayUnits }
      , tooltip: tooltip
      , translate: function (value) { return value; }
      , utils: {
        scaleMgdl: function (value) { return value; }
        , toRoundedStr: function (value) { return String(value); }
      }
    };
    return { client: client, svg: svg, tooltip: tooltip };
  }

  function hoverBG (node, tooltip) {
    node.dispatchEvent(new env.window.MouseEvent('mouseover', { bubbles: true, clientX: 10, clientY: 10 }));
    var match = /BG:\s*([-0-9.]+)/.exec(tooltip.text());
    if (!match) throw new Error('no BG line in tooltip: ' + tooltip.text());
    return Number(match[1]);
  }

  // A Meal Bolus with carbs and a BG, drawn by drawTreatment (the bubble).
  function mealBolusTooltipBG (displayUnits, profileUnits, fields) {
    var t = setup(displayUnits, profileUnits);
    var treatment = Object.assign({ eventType: 'Meal Bolus', carbs: 10, glucoseType: 'Finger', mills: Date.now() }, fields);
    require('../lib/client/renderer')(t.client, d3).drawTreatment(treatment, { scale: 2, showLabels: false, treatments: 1 }, 10, {});
    return hoverBG(t.client.chart.focus.select('.draggable-treatment').node(), t.tooltip);
  }

  // A BG Check with no carbs or insulin, drawn by addTreatmentCircles (the dot).
  function bgCheckTooltipBG (displayUnits, profileUnits, fields) {
    var t = setup(displayUnits, profileUnits);
    t.client.ddata.treatments = [Object.assign({ eventType: 'BG Check', glucoseType: 'Finger', mills: Date.now() }, fields)];
    t.client.ddata.tempTargetTreatments = [];
    require('../lib/client/renderer')(t.client, d3).addTreatmentCircles(new Date());
    return hoverBG(t.svg.select('.treatment-dot').node(), t.tooltip);
  }

  describe('display units differ from the record units', function () {
    it('mmol display, mg/dl profile: a careportal BG of 5 mmol shows 5', function () {
      mealBolusTooltipBG('mmol', 'mg/dl', { glucose: '5', units: 'mmol' }).should.equal(5);
    });

    it('mg/dl display, mmol profile: a careportal BG of 90 mg/dl shows 90', function () {
      mealBolusTooltipBG('mg/dl', 'mmol', { glucose: '90', units: 'mg/dl' }).should.equal(90);
    });

    it('mmol display, mmol profile: a record stored as 90 mg/dl shows 5', function () {
      mealBolusTooltipBG('mmol', 'mmol', { glucose: 90, units: 'mg/dl' }).should.equal(5);
    });
  });

  describe('controls', function () {
    it('mmol display, mmol profile: 5 mmol shows 5', function () {
      mealBolusTooltipBG('mmol', 'mmol', { glucose: '5', units: 'mmol' }).should.equal(5);
    });

    it('mg/dl display, mg/dl profile: 90 mg/dl shows 90', function () {
      mealBolusTooltipBG('mg/dl', 'mg/dl', { glucose: '90', units: 'mg/dl' }).should.equal(90);
    });

    it('mmol display, mg/dl profile: 90 mg/dl is converted to 5', function () {
      mealBolusTooltipBG('mmol', 'mg/dl', { glucose: 90, units: 'mg/dl' }).should.equal(5);
    });

    it('BG Check dot, mmol display, mg/dl profile: 5 mmol shows 5', function () {
      bgCheckTooltipBG('mmol', 'mg/dl', { glucose: '5', units: 'mmol' }).should.equal(5);
    });
  });

  describe('a record without units is taken to be in the profile units', function () {
    it('mmol display, mg/dl profile: 90 is converted to 5', function () {
      mealBolusTooltipBG('mmol', 'mg/dl', { glucose: 90 }).should.equal(5);
    });

    it('mg/dl display, mmol profile: 5 is converted to 90', function () {
      mealBolusTooltipBG('mg/dl', 'mmol', { glucose: 5 }).should.equal(90);
    });

    it('mmol display, mmol profile: 5 shows 5', function () {
      mealBolusTooltipBG('mmol', 'mmol', { glucose: '5' }).should.equal(5);
    });
  });

  describe('units spellings', function () {
    it('mmol display, mmol profile: a record stored as 90 mg/dL shows 5', function () {
      mealBolusTooltipBG('mmol', 'mmol', { glucose: 90, units: 'mg/dL' }).should.equal(5);
    });

    it('mg/dl display, mg/dl profile: a record stored as 5 mmol/L shows 90', function () {
      mealBolusTooltipBG('mg/dl', 'mg/dl', { glucose: 5, units: 'mmol/L' }).should.equal(90);
    });

    it('mmol display, mg/dl profile: a record stored as 5 mmol/L shows 5', function () {
      mealBolusTooltipBG('mmol', 'mg/dl', { glucose: '5', units: 'mmol/L' }).should.equal(5);
    });

    it('mg/dl display, mmol profile: a record stored as 90 mg/dL shows 90', function () {
      mealBolusTooltipBG('mg/dl', 'mmol', { glucose: '90', units: 'mg/dL' }).should.equal(90);
    });
  });
});
