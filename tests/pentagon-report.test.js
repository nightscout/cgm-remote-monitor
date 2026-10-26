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
    assert.match($('#pentagon .gd-pentagon-note').first().text(), /extrapolate observed readings to a 24-hour day/);
    assert.match($('#pentagon .gd-pentagon-note').first().text(), /Missing data may bias/);
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
  it('explains insufficient observed time even with 100% elapsed coverage', function () {
    const previousNow = Date.now;
    Date.now = () => Date.UTC(2026, 9, 1, 0, 5);
    try {
      render(records(60).slice(0, 1));
      assert.equal($('#pentagon .gd-pentagon-score').length, 0);
      assert.match($('#pentagon .gd-pentagon-coverage').text(), /100\.0%/);
      assert.match($('#pentagon .gd-pentagon-message').text(), /16 hours 48 minutes/);
    } finally { Date.now = previousNow; }
  });
  it('explains when overlapping or missing readings cannot be distinguished', function () {
    const data = records(100).flatMap(r => [r, {...r, displayTime: new Date(r.displayTime.valueOf() + 60000)}]);
    render(data);
    assert.equal($('#pentagon .gd-pentagon-score').length, 0);
    assert.match($('#pentagon .gd-pentagon-coverage').text(), /coverage is uncertain/);
    assert.match($('#pentagon .gd-pentagon-message').text(), /overlapping uploads or missing data/);
  });
  it('explains conflicting simultaneous glucose values', function () {
    const data = records(100);
    data.push({...data[50], bgValue: 200});
    render(data);
    assert.equal($('#pentagon .gd-pentagon-score').length, 0);
    assert.match($('#pentagon .gd-pentagon-coverage').text(), /coverage is uncertain/);
    assert.match($('#pentagon .gd-pentagon-message').text(), /Conflicting glucose readings/);
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
  it('registers every report state in Crowdin and renders translations as Unicode text', function () {
    const source = require('../translations/en/en.json');
    const language = require('../lib/language')();
    // A synthetic catalogue tests the real translator without presenting
    // unreviewed medical translations as approved language contributions.
    const prefix = 'العربية é 👩‍⚕️ <img> ';
    language.offerTranslations(Object.fromEntries(Object.keys(source).map(key => [key, prefix + source[key]])));
    const seen = new Set();
    const translate = key => {
      assert.ok(Object.hasOwn(source, key), 'Missing Crowdin source: ' + key);
      seen.add(key);
      return language.translate(key);
    };
    const draw = (allHours = true) => view.render($('#pentagon'), records(100), ['2026-10-01'], profile, moment, 'mg/dl', translate, allHours);
    draw();
    assert.equal($('#pentagon h3').text(), prefix + source['Comprehensive Glucose Pentagon']);
    assert.equal($('#pentagon .gd-pentagon-label').length, 5);
    assert.equal($('#pentagon .gd-pentagon-label').eq(1).text(), prefix + source['Glucose variability']);
    assert.equal($('#pentagon .gd-pentagon-label').eq(1).attr('dir'), 'auto');
    assert.equal($('#pentagon img').length, 0, 'Translations are text, never HTML');
    assert.match($('#pentagon .gd-pentagon-note').text(), /العربية é 👩‍⚕️ <img> PGR is a research metric/);
    draw(false);
    const model = require('../lib/report/pentagon'), original = model.calculate;
    try {
      for (const reason of ['empty', 'coverage', 'duration', 'ambiguous', 'conflicting', 'invalid']) {
        model.calculate = () => ({available: false, coverage: 0, count: 0, days: 2, reason});
        draw();
        assert.ok($('#pentagon .gd-pentagon-message').text().startsWith(prefix));
      }
    } finally { model.calculate = original; }
    assert.ok(seen.has('day') && seen.has('days'));
    assert.equal(seen.size, 28, 'Every report string and warning was exercised');
  });
});
