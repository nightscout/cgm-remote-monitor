'use strict';

const assert = require('assert/strict');
const moment = require('moment');
const createSecureDOM = require('./fixtures/secure-jsdom').createSecureDOM;
const domGlobals = require('./fixtures/dom-globals');

describe('percentile report D3 rendering', function() {
  let env;
  let state;
  let priorD3;

  beforeEach(function() {
    priorD3 = global.d3;
    global.d3 = require('./fixtures/d3');
    delete global.window;
    delete global.document;
    env = createSecureDOM('<!DOCTYPE html><html><body><span id="percentile-days"></span><div id="percentile-chart"></div></body></html>');
    state = domGlobals.installDomGlobals(env);
    env.window.d3 = global.d3;
    env.window.moment = moment;
  });

  afterEach(function() {
    delete require.cache[require.resolve('../lib/report_plugins/percentile')];
    if (priorD3 === undefined) delete global.d3;
    else global.d3 = priorD3;
    domGlobals.restoreDomGlobals(state);
  });

  it('renders smooth, class-based percentile paths as SVG', function() {
    const day = '2025-01-01';
    const start = Date.parse(day + 'T00:00:00.000Z');
    const records = [];
    for (let index = 0; index < 48; index++) {
      records.push({
        displayTime: new Date(start + index * 30 * 60 * 1000)
        , sgv: 90 + (index % 8) * 5
      });
    }

    env.window.Nightscout = {
      client: {
        sbx: { data: { profile: { applyTimezone: value => moment.utc(value) } } }
        , translate: value => value
      }
      , report_plugins: { utils: { localeDate: value => value } }
    };

    require('../lib/report_plugins/percentile')().report({ allstatsrecords: records }, [day], {
      targetHigh: 180
      , targetLow: 80
      , units: 'mg/dl'
    });

    const chart = env.document.querySelector('#percentile-chart');
    const median = chart.querySelector('path.p-median');
    assert.ok(chart.querySelector('svg'), 'D3 SVG is rendered');
    assert.equal(chart.querySelector('canvas'), null, 'a legacy canvas is not rendered');
    assert.equal(chart.querySelectorAll('path.p-band-50').length, 3, 'the central band is split at both target limits');
    assert.equal(chart.querySelectorAll('path.p-band-80').length, 3, 'the outer band is split at both target limits');
    assert.ok(chart.querySelector('clipPath#percentile-in-range-clip'), 'the target-range clip is rendered');
    assert.ok(chart.querySelector('clipPath#percentile-above-range-clip'), 'the above-range clip is rendered');
    assert.ok(chart.querySelector('clipPath#percentile-below-range-clip'), 'the below-range clip is rendered');
    assert.ok(chart.querySelector('path.p-band-50.p-band-in-range'), 'the central target-range band is themeable');
    assert.ok(chart.querySelector('path.p-band-80.p-band-below'), 'the outer low band is themeable');
    assert.ok(chart.querySelector('path.p-band-50.p-band-above'), 'the central high band is themeable');
    assert.equal(chart.querySelector('path.p-line-10, path.p-line-25, path.p-line-75, path.p-line-90'), null
      , 'percentile band boundary lines are not rendered');
    assert.ok(median, 'the median has a CSS class');
    assert.match(median.getAttribute('d'), /C/, 'the median path contains smooth cubic curve segments');
  });
});
