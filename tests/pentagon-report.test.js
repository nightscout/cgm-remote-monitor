'use strict';
const assert = require('node:assert/strict');
const moment = require('moment-timezone');
const {createSecureDOM} = require('./fixtures/secure-jsdom');
const globals = require('./fixtures/dom-globals');
const view = require('../lib/report/pentagon-view');

describe('Glucose pentagon report', function () {
  let env, state, $, profile;
  beforeEach(function () {
    env = createSecureDOM(); state = globals.installDomGlobals(env); $ = env.window.$;
    profile = {parseInTimezone: day => moment.tz(day, 'UTC'), applyTimezone: value => value.tz('UTC')};
    $('body').append('<section id="pentagon"></section>');
  });
  afterEach(function () {globals.restoreDomGlobals(state); env.cleanup();});
  function records(value) {
    return Array.from({length: 288}, (_, i) => ({displayTime: new Date(Date.UTC(2026, 9, 1) + i * 5 * 60000), bgValue: value}));
  }
  function render(data, units = 'mg/dl', allHours = true) {
    view.render($('#pentagon'), data, ['2026-10-01'], profile, moment, units, text => text, allHours);
  }
  it('renders a labelled SVG, a numerical score and five accessible values', function () {
    render(records(100));
    assert.equal($('#pentagon svg[role="img"]').length, 1);
    assert.equal($('#pentagon svg title').text(), 'Comprehensive Glucose Pentagon');
    assert.match($('#pentagon .gd-pentagon-score').text(), /^PGR: 1\.\d{2}$/);
    assert.equal($('#pentagon dl dt').length, 5);
    assert.equal($('#pentagon dl dd').length, 5);
    assert.equal($('#pentagon .gd-pentagon-reference').length, 1);
    assert.equal($('#pentagon .gd-pentagon-patient').length, 1);
    assert.match($('#pentagon .gd-pentagon-coverage').text(), /100\.0%/);
    assert.match($('#pentagon .gd-pentagon-note').text(), /not a validated prediction/);
  });
  it('changes display units without changing the score or polygon', function () {
    render(records(200));
    const score = $('#pentagon .gd-pentagon-score').text(), polygon = $('#pentagon .gd-pentagon-patient').attr('points');
    assert.match($('#pentagon dl dd').last().text(), /^200 mg\/dL$/);
    render(records(200), 'mmol');
    assert.match($('#pentagon dl dd').last().text(), /^11\.1 mmol\/L$/);
    assert.match($('#pentagon .gd-pentagon-note').first().text(), /3\.9–10\.0 mmol\/L/);
    assert.equal($('#pentagon .gd-pentagon-score').text(), score);
    assert.equal($('#pentagon .gd-pentagon-patient').attr('points'), polygon);
  });
  it('clears a prior score when data or coverage becomes insufficient', function () {
    render(records(100)); assert.equal($('#pentagon .gd-pentagon-score').length, 1);
    render(records(100).slice(0, 2));
    assert.equal($('#pentagon svg').length, 0); assert.equal($('#pentagon .gd-pentagon-score').length, 0);
    assert.match($('#pentagon .gd-pentagon-message').text(), /70%/);
    render([]); assert.equal($('#pentagon svg').length, 0);
    assert.match($('#pentagon .gd-pentagon-message').text(), /No glucose/);
  });
  it('withholds full-day metrics when hours are filtered and restores them', function () {
    render(records(100), 'mg/dl', false);
    assert.equal($('#pentagon svg').length, 0);
    assert.match($('#pentagon .gd-pentagon-message').text(), /all 24 hours/);
    render(records(100)); assert.equal($('#pentagon svg').length, 1);
  });
  it('marks values beyond the chart scale without clipping the numeric score', function () {
    render(records(600));
    assert.ok($('#pentagon .gd-pentagon-overflow').length > 0);
    assert.ok(Number($('#pentagon .gd-pentagon-score').text().replace('PGR: ', '')) > 1);
    assert.equal($('#pentagon dl dd').last().text(), '600 mg/dL');
  });
});
