'use strict';

const assert = require('assert/strict');
const moment = require('moment-timezone');
const createSecureDOM = require('./fixtures/secure-jsdom').createSecureDOM;
const domGlobals = require('./fixtures/dom-globals');

const TIMEZONE = 'Europe/Oslo';
const DAY = '2026-10-01';
const NEXT_DAY = '2026-10-02';
const FIVE_MINUTES = 5 * 60 * 1000;
const PLOT_START = Date.parse(DAY + 'T00:00:00.000Z');
const DOM_GLOBALS = ['window', 'document', 'navigator', '$', 'jQuery'];

describe('Loopalyzer report glucose chart', function () {
  let env;
  let state;
  let previousGlobals;
  let previousNow;
  let previousZone;

  beforeEach(function () {
    previousGlobals = Object.fromEntries(DOM_GLOBALS.map(function (name) {
      return [name, Object.getOwnPropertyDescriptor(global, name)];
    }));
    previousNow = moment.now;
    previousZone = moment.defaultZone && moment.defaultZone.name;
    // The report overlays historical days on today's axis. Freeze that axis on
    // a normal UTC day, independent of the CI host's date and timezone.
    moment.now = () => PLOT_START + 12 * 60 * 60 * 1000;
    moment.tz.setDefault('UTC');
    delete require.cache[require.resolve('../lib/report_plugins/loopalyzer')];
    env = createSecureDOM();
    state = domGlobals.installDomGlobals(env);
    env.window.moment = moment;
  });

  afterEach(function () {
    delete require.cache[require.resolve('../lib/report_plugins/loopalyzer')];
    domGlobals.restoreDomGlobals(state);
    DOM_GLOBALS.forEach(function (name) {
      if (previousGlobals[name]) Object.defineProperty(global, name, previousGlobals[name]);
      else delete global[name];
    });
    moment.now = previousNow;
    moment.tz.setDefault(previousZone);
  });

  function reading (day, offset, value) {
    return {
      displayTime: new Date(moment.tz(day, TIMEZONE).valueOf() + offset)
      , sgv: value, bgValue: value
    };
  }

  function render (records, days) {
    const $ = env.window.$;
    const ctx = {
      moment: moment
      , settings: require('../lib/settings')()
      , language: require('../lib/language')()
    };
    ctx.settings.units = 'mg/dl';
    const profile = require('../lib/profilefunctions')([{
      defaultProfile: 'Default', startDate: '1980-01-01'
      , store: { Default: {
        timezone: TIMEZONE, units: 'mg/dl', dia: 3, carbs_hr: 30
        , basal: [{ time: '00:00', value: 1 }]
        , sens: [{ time: '00:00', value: 50 }]
        , carbratio: [{ time: '00:00', value: 10 }]
        , target_low: [{ time: '00:00', value: 90 }]
        , target_high: [{ time: '00:00', value: 120 }]
      } }
    }], ctx);
    const plugins = {
      iob: require('../lib/plugins/iob')(ctx)
      , cob: require('../lib/plugins/cob')(ctx)
    };
    const client = {
      settings: ctx.settings, sbx: { data: { profile: profile } }
      , plugins: name => plugins[name], translate: value => value
    };
    env.window.Nightscout = {
      client: client
      , report_plugins: { utils: { localeDate: value => value } }
    };
    const report = require('../lib/report_plugins/loopalyzer')();
    $('body').empty().append(report.html(client));
    const plots = [];
    // Only canvas drawing is replaced: use the real report, slotting,
    // averaging, profile and IOB/COB implementations.
    $.plot = function (selector, series) {
      if (selector === '#loopalyzer-bg') plots.push(series);
    };
    // As in reportclient, statsrecords contain only the selected local days;
    // newest-first input also exercises the report's chronological ordering.
    const selected = records.filter(function (record) {
      return days.includes(moment(record.displayTime).tz(TIMEZONE).format('YYYY-MM-DD'));
    }).slice().sort((a, b) => b.displayTime - a.displayTime);
    report.report({
      allstatsrecords: selected, alldays: days.length, profiles: [], treatments: []
      , devicestatus: [], profileSwitchTreatments: [], tempbasalTreatments: [], combobolusTreatments: []
    }, days, { units: 'mg/dl', targetLow: 80, targetHigh: 180 });

    assert.equal(plots.length, 1, 'one glucose chart was rendered');
    const glucose = plots[0].find(series => series.id === 'glucose');
    assert.ok(glucose, 'the rendered chart includes the glucose series');
    assert.equal(glucose.lines.show, true);
    assert.equal(glucose.data.length, 288);
    glucose.data.forEach(function (point, index) {
      assert.equal(point[0].getTime(), PLOT_START + index * FIVE_MINUTES);
    });
    return glucose.data.map(point => point[1]);
  }

  it('plots the issue #6236 readings at their expected times', function () {
    const records = [
      [1602547500286.0908, 72], [1602547800601.2769, 81], [1602548100006.845, 82]
      , [1602548399978.8152, 77], [1602548700313.8928, 75], [1602549000395.83, 76]
      , [1602549300030.324, 77]
    ].map(function (entry) {
      return { displayTime: new Date(entry[0]), sgv: entry[1], bgValue: entry[1] };
    });

    const values = render(records, ['2020-10-13']);
    // These timestamps are local 02:05 through 02:35 in Europe/Oslo.
    assert.deepEqual(values.slice(25, 32), [72, 81, 82, 77, 75, 76, 77]);
    assert.equal(values.filter(Number.isFinite).length, 7);
  });

  it('plots a genuine missing sample as a gap at its actual time', function () {
    const records = [0, 1, 3, 4].map(function (slot, index) {
      return reading(DAY, slot * FIVE_MINUTES + 200, 100 + index);
    });

    const values = render(records, [DAY]);
    assert.deepEqual(values.slice(0, 5), [100, 101, NaN, 102, 103]);
    assert.equal(values.filter(Number.isFinite).length, 4);
  });

  it('keeps the plotted midnight samples unchanged when adjacent days are selected', function () {
    const records = [reading(DAY, 288 * FIVE_MINUTES - 200, 80), reading(NEXT_DAY, 200, 200)];
    const firstAlone = render(records, [DAY]);
    const nextAlone = render(records, [NEXT_DAY]);
    const together = render(records, [NEXT_DAY, DAY]);

    assert.ok(Number.isNaN(firstAlone[0]));
    assert.equal(firstAlone[287], 80);
    assert.equal(nextAlone[0], 200);
    assert.ok(Number.isNaN(nextAlone[287]));
    assert.equal(together[0], nextAlone[0]);
    assert.equal(together[287], firstAlone[287]);
    assert.equal(together.filter(Number.isFinite).length, 2);
  });

  it('does not plot a next-day sample in the previous day\'s missing final interval', function () {
    const records = [];
    for (let i = 0; i < 287; i++) records.push(reading(DAY, i * FIVE_MINUTES + 200, 100));
    records.push(reading(NEXT_DAY, 200, 240));

    const firstAlone = render(records, [DAY]);
    const together = render(records, [NEXT_DAY, DAY]);
    assert.ok(Number.isNaN(firstAlone[287]));
    assert.ok(Number.isNaN(together[287]));
    // Overlapping times are intentionally averaged; a missing final time is not filled.
    assert.equal(together[0], 170);
    assert.equal(together.filter(Number.isFinite).length, 287);
  });
});
