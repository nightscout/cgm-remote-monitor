'use strict';

const assert = require('node:assert/strict');
const {createSecureDOM} = require('./fixtures/secure-jsdom');
const globals = require('./fixtures/dom-globals');
const START = Date.parse('2026-10-21T10:00:00Z');
const MINUTE = 60000;

describe('Calibrations report matching and selection', function () {
  let env, state, previousD3, plugin;
  beforeEach(function () {
    env = createSecureDOM('<div id="report"></div>');
    state = globals.installDomGlobals(env);
    previousD3 = global.d3;
    global.d3 = require('./fixtures/d3');
    env.window.Nightscout = {
      client: {settings: {units: 'mg/dl'}, translate: value => value,
        utils: {scaleMgdl: value => value, roundBGForDisplay: value => Math.round(value)}},
      report_plugins: {utils: {localeDateTime: date => date.toISOString()}}
    };
    plugin = require('../lib/report_plugins/calibrations')();
    env.document.getElementById('report').innerHTML = plugin.html(env.window.Nightscout.client);
  });
  afterEach(function () {
    delete require.cache[require.resolve('../lib/report_plugins/calibrations')];
    if (previousD3 === undefined) delete global.d3;
    else global.d3 = previousD3;
    globals.restoreDomGlobals(state);
  });
  function day (sgv, mbg, cal = [], treatments = []) { return {sgv, mbg, cal, treatments}; }
  function sensor (minutes, raw, fields = {}) {
    return {type: 'sgv', mills: START + minutes * MINUTE, filtered: raw, ...fields};
  }
  function meter (minutes, fields = {}) { return {mills: START + minutes * MINUTE, y: 120, device: 'synthetic', ...fields}; }
  function rawValues () {
    return Array.from(env.document.querySelectorAll('.calibrations-mbg td:last-child'), node => node.textContent);
  }

  for (const reverse of [false, true]) {
    it('matches raw data without mutating observations with newest first ' + reverse, function () {
      const data = {
        '2026-10-21': day([sensor(4, 60000), sensor(0, 58000)], [meter(1), meter(5)]),
        '2026-10-26': day([sensor(7204, 62000), sensor(7200, 59000)], [meter(7201), meter(7205)])
      };
      const original = JSON.stringify(data);
      const days = Object.keys(data);
      plugin.report(data, reverse ? days.reverse() : days);
      assert.deepEqual(rawValues(), ['58000', '60000', '59000', '62000']);
      assert.deepEqual(Array.from(env.document.querySelectorAll('input'), node => node.checked), [false, true, true, true]);
      assert.equal(env.document.querySelectorAll('.calibrations-point').length, 3);
      assert.equal(JSON.stringify(data), original);
    });
  }

  it('uses only real raw signals, falling back to unfiltered data and ignoring future entries', function () {
    const data = {day: day([
      sensor(0, 58000), sensor(1, 0, {unfiltered: '59000'}),
      sensor(2, 99999, {type: 'rawbg'}), sensor(2, 88888, {type: 'mbg'}),
      sensor(2, undefined), sensor(2, -1), sensor(4, 70000), sensor(2, 11111, {mills: undefined})
    ], [meter(3)])};
    plugin.report(data, ['day']);
    assert.deepEqual(rawValues(), ['59000']);
    assert.equal(env.document.querySelectorAll('.calibrations-point').length, 1);
  });

  it('accepts the five-minute boundary and labels missing or stale signals without retaining previous matches', function () {
    const data = {day: day([sensor(0, 58000)], [meter(5), meter(5.01), meter(-1), meter(6, {raw: 12345})])};
    plugin.report(data, ['day']);
    assert.deepEqual(rawValues(), ['Not available', '58000', 'Not available', 'Not available']);
    assert.equal(env.document.querySelectorAll('.calibrations-point').length, 1);
    data.day.sgv = [];
    plugin.report(data, ['day']);
    assert.deepEqual(rawValues(), Array(4).fill('Not available'));
    assert.equal(env.document.querySelectorAll('.calibrations-point').length, 0);
    assert.match(env.document.getElementById('calibrations-status').textContent, /No matching raw sensor data/);
  });

  it('selects the only meter reading even without a device and explains selection without raw data', function () {
    plugin.report({day: day([], [meter(1, {device: undefined})])}, ['day']);
    const input = env.document.querySelector('.calibrations-checkbox');
    assert.equal(input.checked, true);
    assert.match(input.getAttribute('aria-label'), /Show in chart/);
    assert.match(env.document.querySelector('.calibrations-help + .calibrations-help').textContent, /latest three/);
    input.checked = false;
    input.dispatchEvent(new env.window.Event('change', {bubbles: true}));
    assert.match(env.document.getElementById('calibrations-status').textContent, /Select a meter reading/);
  });

  for (const units of ['mg/dl', 'mmol']) {
    it('keeps raw values and calibration curves consistent with meter display units ' + units, function () {
      const client = env.window.Nightscout.client;
      client.settings.units = units;
      client.utils.scaleMgdl = value => units === 'mmol' ? value / 18.0182 : value;
      client.utils.roundBGForDisplay = value => units === 'mmol' ? Number(value).toFixed(1) : Math.round(value);
      const cal = {mills: START + MINUTE + 1, scale: 1, slope: 1000, intercept: 0};
      const data = {day: day([sensor(0, 58000)], [meter(1)], [cal], [{mills: START, eventType: 'Sensor Start'}])};
      const original = JSON.stringify(data);
      plugin.report(data, ['day']);
      assert.ok(env.document.querySelector('thead').textContent.includes(units === 'mmol' ? 'mmol/L' : 'mg/dL'));
      assert.equal(env.document.querySelector('.calibrations-mbg td:nth-child(3)').textContent, units === 'mmol' ? '6.7' : '120');
      assert.deepEqual(rawValues(), ['58000']);
      assert.equal(env.document.querySelectorAll('.calibrations-curve').length, 1);
      assert.equal(env.document.querySelectorAll('.calibrations-point').length, 1);
      assert.ok(Math.abs(Number(env.document.querySelector('.calibrations-point').getAttribute('cx')) - (90 + 120 / 500 * 490)) < 1e-8);
      assert.ok(Math.abs(Number(env.document.querySelector('.calibrations-curve').getAttribute('x1')) - (90 + 50 / 500 * 490)) < 1e-8);
      assert.ok(env.document.querySelector('.calibrations-event').textContent.includes('Sensor Start'));
      assert.equal(JSON.stringify(data), original);
    });
  }

  it('clears a previous chart when a subsequent report contains no data', function () {
    plugin.report({day: day([sensor(0, 58000)], [meter(1)])}, ['day']);
    plugin.report({day: day([], [])}, ['day']);
    assert.equal(env.document.querySelectorAll('.calibrations-point').length, 0);
    assert.match(env.document.getElementById('calibrations-list').textContent, /No data available/);
    assert.match(env.document.getElementById('calibrations-status').textContent, /No meter readings/);
  });
});
