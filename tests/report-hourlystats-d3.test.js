'use strict';

const assert = require('assert/strict');
const moment = require('moment');
const createSecureDOM = require('./fixtures/secure-jsdom').createSecureDOM;
const domGlobals = require('./fixtures/dom-globals');

describe('hourly stats report D3 rendering', function() {
  let env;
  let state;
  let priorD3;

  beforeEach(function() {
    priorD3 = global.d3;
    global.d3 = require('./fixtures/d3');
    delete global.window;
    delete global.document;
    env = createSecureDOM('<!DOCTYPE html><html><body><div id="hourlystats-overviewchart"></div><div id="hourlystats-report"></div></body></html>');
    state = domGlobals.installDomGlobals(env);
    env.window.d3 = global.d3;
    env.window.moment = moment;
  });

  afterEach(function() {
    delete require.cache[require.resolve('../lib/report_plugins/hourlystats')];
    if (priorD3 === undefined) delete global.d3;
    else global.d3 = priorD3;
    domGlobals.restoreDomGlobals(state);
  });

  it('renders quartiles and standard deviation as SVG candles', function() {
    const profile = {
      applyTimezone: value => moment.utc(value)
      , loadData: function() {}
      , updateTreatments: function() {}
    };
    env.window.Nightscout = {
      client: {
        sbx: { data: { profile: profile } }
        , translate: value => value
      }
      , report_plugins: { utils: { localeDate: value => value } }
    };

    require('../lib/report_plugins/hourlystats')().report({
      allstatsrecords: [
        { displayTime: new Date('2025-01-01T10:00:00.000Z'), sgv: 100 }
        
        , { displayTime: new Date('2025-01-01T10:30:00.000Z'), sgv: 140 }
      ]
      , profiles: []
      , profileSwitchTreatments: []
      , tempbasalTreatments: []
      , combobolusTreatments: []
    }, [], { units: 'mg/dl' });

    const chart = env.document.querySelector('#hourlystats-overviewchart');
    assert.ok(chart.querySelector('svg.hourlystats-chart'), 'D3 SVG is rendered');
    assert.equal(chart.querySelector('canvas'), null, 'a legacy canvas is not rendered');
    assert.equal(chart.querySelectorAll('.hourlystats-candle').length, 1, 'only hours containing readings are rendered');
    assert.ok(chart.querySelector('.hourlystats-candle-body'), 'the interquartile range is rendered');
    assert.ok(chart.querySelector('.hourlystats-candle-whisker'), 'the standard deviation is rendered');
    assert.ok(chart.querySelector('.hourlystats-axis-x'), 'the hourly axis is rendered');
    assert.ok(chart.querySelector('.hourlystats-axis-y'), 'the glucose axis is rendered');
  });
});
