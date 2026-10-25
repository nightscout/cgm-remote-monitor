'use strict';
const assert = require('node:assert/strict');
const moment = require('moment-timezone');
const {createSecureDOM} = require('./fixtures/secure-jsdom');
const globals = require('./fixtures/dom-globals');
const DAY = '2026-10-25';

describe('AGP report values, gaps and exports', function () {
  let env, state, $, report, copied, downloads, previousD3;
  beforeEach(function () {
    env = createSecureDOM(); state = globals.installDomGlobals(env); $ = env.window.$;
    env.window.moment = moment;
    previousD3 = Object.getOwnPropertyDescriptor(global, 'd3');
    global.d3 = require('../lib/d3.mjs');
    const profile = {parseInTimezone: value => moment.tz(value, 'Europe/Oslo'), applyTimezone: value => value.tz('Europe/Oslo')};
    const client = {translate: text => text, settings: {units: 'mg/dl'}, sbx: {data: {profile}}};
    env.window.Nightscout = {client, report_plugins: {utils: {localeDate: value => value}}};
    report = require('../lib/report_plugins/agp')();
    $('body').append(report.html(client));
    copied = []; downloads = [];
    Object.defineProperty(env.window.navigator, 'clipboard', {configurable: true, value: {writeText: text => {copied.push(text); return Promise.resolve();}}});
    const create = env.window.document.createElement.bind(env.window.document);
    env.window.document.createElement = name => {
      const element = create(name);
      if (name === 'a') element.click = () => downloads.push(element.download);
      return element;
    };
    env.window.URL.createObjectURL = () => 'blob:local-test'; env.window.URL.revokeObjectURL = () => {};
  });
  afterEach(function () {
    if (previousD3) Object.defineProperty(global, 'd3', previousD3); else delete global.d3;
    globals.restoreDomGlobals(state); env.cleanup();
  });
  function record(at, value = 120) {return {displayTime: new Date(at), bgValue: value, sgv: value};}
  function render(data, days = [DAY], units = 'mg/dl') {
    report.report({allstatsrecords: data}, days, {units, targetLow: units === 'mmol' ? 3.9 : 70, targetHigh: units === 'mmol' ? 10 : 180});
  }
  function median(selector = '#agp-chart') {return $(selector + ' path').toArray().findLast(path => Array.isArray(path.__data__));}
  it('bins and groups readings by the profile timezone rather than the host', function () {
    render([record('2026-10-24T23:00:00Z')]);
    assert.equal(median().__data__[4].v, 120);
    assert.ok(median().__data__.slice(0, 4).every(point => point.v === null));
    assert.equal($('#agp-daily path').length, 1);
    assert.equal($('#agp-daily circle').length, 1);
    assert.equal($('#agp-daily path')[0].__data__[0].t, 60);
  });
  it('disables both exports and removes old handlers when the next result is empty', async function () {
    render([record('2026-10-25T08:00:00+01:00')]);
    $('#agp-copy').trigger('click'); $('#agp-download').trigger('click');
    await Promise.resolve();
    assert.equal(copied.length, 1); assert.equal(downloads.length, 1);
    render([], ['2026-10-26']);
    $('#agp-copy').trigger('click'); $('#agp-download').trigger('click');
    assert.equal($('#agp-days').text(), 'Result is empty');
    assert.ok($('#agp-copy').prop('disabled')); assert.ok($('#agp-download').prop('disabled'));
    assert.equal(copied.length, 1); assert.equal(downloads.length, 1);
    assert.equal($('#agp-export-status').text(), '');
    render([record('2026-10-26T09:00:00+01:00', 180)], ['2026-10-26']);
    $('#agp-copy').trigger('click'); await Promise.resolve();
    assert.equal(copied.length, 2);
    assert.ok(copied[1].includes('2026-10-26')); assert.ok(!copied[1].includes('2026-10-25'));
    assert.ok(copied[1].includes('Average Glucose: 180 mg/dL'));
  });
  it('ignores a delayed clipboard failure from an older period', async function () {
    let fail;
    env.window.navigator.clipboard.writeText = () => new Promise((resolve, reject) => {fail = reject;});
    let fallback = 0; env.window.document.execCommand = () => {fallback++; return true;};
    render([record('2026-10-25T08:00:00+01:00')]); $('#agp-copy').trigger('click');
    render([], ['2026-10-26']); fail(new Error('denied')); await Promise.resolve();
    assert.equal(fallback, 0); assert.equal($('#agp-export-status').text(), '');
  });
  for (const units of ['mg/dl', 'mmol']) {
    it('keeps numerical statistics and exports consistent in ' + units, async function () {
      render([record('2026-10-25T08:00:00+01:00', 100), record('2026-10-25T08:05:00+01:00', 200)], [DAY], units);
      $('#agp-copy').trigger('click'); await Promise.resolve();
      assert.ok(copied[0].includes('Average Glucose: ' + (units === 'mmol' ? '8.3 mmol/L' : '150 mg/dL')));
      assert.ok(copied[0].includes('6.9%')); assert.ok(copied[0].includes('33.3%'));
      const point = median().__data__[32];
      assert.ok(Math.abs(point.v - (units === 'mmol' ? 150 / 18.0182 : 150)) < 0.01);
    });
  }
  it('leaves missing AGP intervals empty and splits the daily trace', function () {
    render([record('2026-10-25T00:00:00+02:00'), record('2026-10-25T12:00:00+01:00')]);
    for (const path of $('#agp-chart path').toArray().filter(path => Array.isArray(path.__data__))) {
      assert.equal((path.getAttribute('d').match(/M/g) || []).length, 2);
      assert.ok(path.__data__.slice(1, 48).every(point => point.v === null));
    }
    assert.equal(($('#agp-daily path').attr('d').match(/M/g) || []).length, 2);
  });
  it('selects the latest 28 daily profiles regardless of the report sort option', function () {
    const days = Array.from({length: 31}, (_, i) => '2026-10-' + String(i + 1).padStart(2, '0'));
    const readings = days.map(day => record(day + 'T12:00:00+01:00'));
    render(readings, days);
    const forward = $('.agp-daily-label').toArray().map(node => node.textContent);
    render(readings, days.slice().reverse());
    assert.deepEqual($('.agp-daily-label').toArray().map(node => node.textContent), forward);
    assert.equal(forward[0], '2026-10-04'); assert.equal(forward[27], '2026-10-31');
  });
});
