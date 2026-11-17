'use strict';

const assert = require('node:assert/strict');
const moment = require('moment-timezone');
const createProfile = require('../lib/profilefunctions');
const {createSecureDOM} = require('./fixtures/secure-jsdom');
const globals = require('./fixtures/dom-globals');
const DAY = '2026-10-21', NEXT = '2026-10-22';
const START = Date.parse(DAY + 'T00:00:00Z');

describe('Hourly basal report without drawing Day to Day', function () {
  let env, state, previousD3, plugin, data;
  beforeEach(function () {
    env = createSecureDOM('<div id="hourlystats-report"></div><div id="hourlystats-overviewchart"></div>');
    state = globals.installDomGlobals(env);
    previousD3 = global.d3; global.d3 = require('./fixtures/d3');
    env.window.moment = moment;
    const profile = createProfile(null, {moment});
    env.window.Nightscout = {client: {sbx: {data: {profile}}, translate: value => value}, report_plugins: {utils: {localeDate: day => day}}};
    data = {allstatsrecords: [], profiles: [{startDate: '2020-01-01T00:00:00Z', defaultProfile: 'Default',
      store: {Default: {timezone: 'UTC', basal: [{time: '00:00', value: 1}]}}}],
      tempbasalTreatments: [{mills: START, duration: 30, absolute: 0}, {mills: START + 3600000, duration: 30, absolute: 2}],
      [DAY]: {}, [NEXT]: {}};
    plugin = require('../lib/report_plugins/hourlystats')();
  });
  afterEach(function () {
    delete require.cache[require.resolve('../lib/report_plugins/hourlystats')];
    if (previousD3 === undefined) delete global.d3; else global.d3 = previousD3;
    globals.restoreDomGlobals(state);
  });
  function render (days = [DAY], basal = false) { plugin.report(data, days, {units: 'mg/dl', targetLow: 80, targetHigh: 180, basal}); }
  const selector = '#hourly-basal-adjustments';
  function cells () { return Array.from(env.document.querySelectorAll(selector + ' tbody tr:first-child td')); }

  it('opens directly with the new name and calculated values even when charts are hidden', function () {
    // Stale fields left by an older chart render must not control this report.
    data[DAY].netBasalPositive = Array(24).fill(99);
    data[DAY].netBasalNegative = Array(24).fill(0);
    render();
    assert.equal(env.document.querySelector(selector + ' h2').textContent, 'Hourly basal adjustments (U)');
    assert.equal(cells()[0].querySelector('.basal-net').textContent, '-0.50');
    assert.equal(cells()[1].querySelector('.basal-net').textContent, '0.50');
    assert.equal(cells()[2].querySelector('.basal-net').textContent, '0.00');
    assert.ok(!env.document.querySelector(selector).textContent.includes('must be rendered'));
    assert.match(env.document.querySelector('.hourly-basal-legend').textContent, /Counts in parentheses/);
    const first = env.document.querySelector(selector).textContent;
    render([DAY], true);
    assert.equal(env.document.querySelector(selector).textContent, first);
  });

  it('replaces the section on refresh and uses the new selected period', function () {
    render(); render([NEXT]);
    assert.equal(env.document.querySelectorAll(selector).length, 1);
    assert.equal(cells()[0].querySelector('.basal-net').textContent, '0.00');
    assert.equal(env.document.querySelector(selector + ' tbody th').textContent, NEXT);
  });

  it('shows an unavailable message without a header-only table when profiles are absent', function () {
    render(); data.profiles = []; render();
    assert.equal(env.document.querySelector(selector + ' table'), null);
    assert.match(env.document.querySelector('.hourly-basal-unavailable').textContent, /profile data is unavailable/);
    assert.equal(env.document.querySelectorAll(selector).length, 1);
  });

  it('keeps zero adjustments available and explains that no temporary basals were loaded', function () {
    data.tempbasalTreatments = []; render();
    assert.equal(cells()[0].querySelector('.basal-net').textContent, '0.00');
    assert.match(env.document.querySelector('.hourly-basal-empty').textContent, /No temporary basal records/);
  });

  it('excludes unavailable days from hourly averages and explains net direction counts', function () {
    data.profiles[0].startDate = DAY + 'T00:00:00Z';
    render(['2026-10-20', DAY]);
    const first = env.document.querySelector(selector + ' tbody tr:first-child td');
    assert.equal(first.textContent, '—');
    const average = env.document.querySelector(selector + ' tfoot td');
    assert.equal(average.querySelector('.basal-reduced').textContent, '-0.50 (1)');
    assert.equal(average.querySelector('.basal-added').textContent, '0.00 (0)');
    assert.equal(average.querySelector('.basal-net').textContent, '-0.50');
  });
});
