'use strict';

const assert = require('assert/strict');
const moment = require('moment');
const createSecureDOM = require('./fixtures/secure-jsdom').createSecureDOM;
const domGlobals = require('./fixtures/dom-globals');

describe('loopalyzer report D3 rendering', function() {
  let env;
  let state;
  let priorD3;
  let loopalyzer;

  beforeEach(function() {
    priorD3 = global.d3;
    global.d3 = require('./fixtures/d3');
    delete global.window;
    delete global.document;
    env = createSecureDOM('<!DOCTYPE html><html><body>' +
      '<div id="loopalyzer-basal" style="width:800px;height:100px"></div>' +
      '<div id="loopalyzer-bg" style="width:800px;height:200px"></div>' +
      '<div id="loopalyzer-tempbasal" style="width:800px;height:150px"></div>' +
      '<div id="loopalyzer-iob" style="width:800px;height:150px"></div>' +
      '<div id="loopalyzer-cob" style="width:800px;height:150px"></div>' +
      '</body></html>');
    state = domGlobals.installDomGlobals(env);
    env.window.moment = moment;
    loopalyzer = require('../lib/report_plugins/loopalyzer')();
  });

  afterEach(function() {
    delete require.cache[require.resolve('../lib/report_plugins/loopalyzer')];
    if (priorD3 === undefined) delete global.d3;
    else global.d3 = priorD3;
    domGlobals.restoreDomGlobals(state);
  });

  it('renders all chart types and markings as SVG', function() {
    const start = new Date('2025-01-01T00:00:00.000Z');
    const end = new Date('2025-01-02T00:00:00.000Z');
    const data = [
      [start, 1]
      
      , [new Date(start.getTime() + 5 * 60 * 1000), NaN]
      
      , [new Date(start.getTime() + 10 * 60 * 1000), 2]
    ];
    const base = {
      xDomain: [start, end]
      , gridColor: '#888'
      , axisColor: '#111'
      , barWidth: 5 * 60 * 1000
      , markings: [{
        xaxis: { from: start, to: new Date(start.getTime() + 60 * 60 * 1000) }
        , color: '#eee'
      }]
    };

    ['basal', 'tempbasal', 'iob', 'cob'].forEach(function(id) {
      loopalyzer.drawChart('#loopalyzer-' + id, Object.assign({}, base, {
        series: [{ data: data, label: id, id: id, color: '#00f', type: 'bars' }]
        , showXAxis: id === 'cob'
      }));
    });
    loopalyzer.drawChart('#loopalyzer-bg', Object.assign({}, base, {
      series: [
        { data: data, label: 'Glucose', id: 'glucose', color: '#080', type: 'line' }
        
        , { data: data, label: 'Predictions', id: 'predictions', color: '#808', type: 'points' }
      ]
      , yDomain: [0, 400]
      , markings: [{ yaxis: { from: 80, to: 180 }, color: '#dfd' }]
    }));

    assert.equal(env.document.querySelectorAll('svg.loopalyzer-chart-svg').length, 5);
    assert.equal(env.document.querySelectorAll('canvas').length, 0);
    assert.ok(env.document.querySelector('#loopalyzer-bg path.loopalyzer-series-glucose'));
    assert.equal(env.document.querySelectorAll('#loopalyzer-bg .loopalyzer-series-predictions circle').length, 2);
    assert.equal(env.document.querySelectorAll('#loopalyzer-basal .loopalyzer-series-basal rect').length, 2);
    assert.ok(env.document.querySelector('#loopalyzer-bg rect.loopalyzer-marking'));
    assert.equal(env.document.querySelectorAll('.loopalyzer-axis-x').length, 1, 'only the final chart shows time labels');
  });
});
