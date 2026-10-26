'use strict';
const assert = require('node:assert/strict');
const moment = require('moment-timezone');
const {createSecureDOM} = require('./fixtures/secure-jsdom');
const globals = require('./fixtures/dom-globals');
const DAY = '2026-10-25';

describe('AGP report values and gaps', function () {
  let env, state, $, report, previousD3;
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
  });
  afterEach(function () {
    if (previousD3) Object.defineProperty(global, 'd3', previousD3); else delete global.d3;
    globals.restoreDomGlobals(state); env.cleanup();
  });
  function record(at, value = 120) {return {displayTime: new Date(at), bgValue: value, sgv: value};}
  function render(data, days = [DAY], units = 'mg/dl', targets = {}) {
    report.report({allstatsrecords: data}, days, {units, targetLow: units === 'mmol' ? 3.9 : 70, targetHigh: units === 'mmol' ? 10 : 180, ...targets});
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
  it('clears the previous report when the next result is empty', function () {
    render([record('2026-10-25T08:00:00+01:00')]);
    assert.ok($('#agp-chart svg').length);
    render([], ['2026-10-26']);
    assert.equal($('#agp-days').text(), 'Result is empty');
    for (const selector of ['#agp-stats', '#agp-tir', '#agp-chart', '#agp-daily', '#agp-cgmactive']) {
      assert.equal($(selector).text(), '');
      assert.equal($(selector).children().length, 0);
    }
    render([record('2026-10-26T09:00:00+01:00', 180)], ['2026-10-26']);
    assert.ok($('#agp-days').text().includes('2026-10-26'));
    assert.equal($('.agp-stat-value').first().text(), '180mg/dL');
  });
  for (const units of ['mg/dl', 'mmol']) {
    it('keeps numerical statistics consistent in ' + units, function () {
      render([record('2026-10-25T08:00:00+01:00', 100), record('2026-10-25T08:05:00+01:00', 200)], [DAY], units);
      assert.equal($('.agp-stat-value').eq(0).text(), units === 'mmol' ? '8.3mmol/L' : '150mg/dL');
      assert.equal($('.agp-stat-value').eq(1).text(), '6.9%');
      assert.equal($('.agp-stat-value').eq(2).text(), '33.3%');
      const point = median().__data__[32];
      assert.ok(Math.abs(point.v - (units === 'mmol' ? 150 / 18.0182 : 150)) < 0.01);
    });
    it('keeps summary chart ranges aligned with TIR when report targets change in ' + units, function () {
      const values = [65, 75, 175, 200];
      const data = values.map((value, i) => record('2026-10-25T08:' + String(i * 5).padStart(2, '0') + ':00+01:00', value));
      function geometry() {
        return ['#agp-chart', '#agp-daily'].map(selector => ({
          band: ['y', 'height'].map(attribute => Number($(selector + ' rect').first().attr(attribute))),
          lines: $(selector + ' line').toArray().map(node => [node.getAttribute('y1'), node.getAttribute('y2')])
        }));
      }
      render(data, [DAY], units);
      const consensus = geometry();
      const scale = units === 'mmol' ? 18.0182 : 1;
      render(data, [DAY], units, {targetLow: 80 / scale, targetHigh: 160 / scale});

      assert.equal($('.agp-target .agp-tir-range').text(), units === 'mmol' ? '3.9–10.0' : '70–180');
      assert.equal($('.agp-target .agp-tir-pct').text(), '50.0%');
      assert.deepEqual(geometry(), consensus, 'custom report targets do not change summary shading or reference lines');
      const band = $('#agp-daily rect').first()[0];
      const top = Number(band.getAttribute('y')), bottom = top + Number(band.getAttribute('height'));
      const dots = $('#agp-daily circle').toArray();
      for (const index of [1, 2]) {
        const y = Number(dots[index].getAttribute('cy'));
        assert.ok(y >= top && y <= bottom, values[index] + ' mg/dL is inside the summary target band');
      }
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
    assert.equal(forward[0], 'Sun 10/04/2026'); assert.equal(forward[27], 'Sat 10/31/2026');
    assert.equal(forward[3], 'Wed 10/07/2026');
  });
});
