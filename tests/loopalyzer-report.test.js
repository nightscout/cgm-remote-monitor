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

  describe('DST transition days (#8156)', function () {
    function renderAllCharts (overrides, days, enablePredictions) {
      const $ = env.window.$;
      const ctx = {
        moment: moment
        , settings: require('../lib/settings')()
        , language: require('../lib/language')()
      };
      ctx.settings.units = 'mg/dl';
      const utils = require('../lib/utils')(ctx);
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
        settings: ctx.settings, utils: utils, sbx: { data: { profile: profile } }
        , plugins: name => plugins[name], translate: value => value
      };
      env.window.Nightscout = {
        client: client
        , report_plugins: { utils: { localeDate: value => value } }
      };
      const report = require('../lib/report_plugins/loopalyzer')();
      $('body').empty().append(report.html(client));
      if (enablePredictions) {
        $('#rp_loopalyzerpredictions').prop('checked', true);
      }
      const charts = {};
      $.plot = function (selector, series, options) {
        charts[selector] = { series: series, options: options };
      };
      const datastorage = Object.assign({
        allstatsrecords: [], alldays: days.length, profiles: [], treatments: []
        , devicestatus: [], profileSwitchTreatments: [], tempbasalTreatments: [], combobolusTreatments: []
      }, overrides);
      report.report(datastorage, days, { units: 'mg/dl', targetLow: 80, targetHigh: 180 });
      return charts;
    }

    it('renders all charts when viewed on 23-hour and 25-hour DST days', function () {
      const bolusAt = moment.tz(DAY + 'T08:00:00', TIMEZONE).valueOf();
      const datastorage = {
        allstatsrecords: [reading(DAY, 8 * 60 * 60 * 1000, 125)]
        , treatments: [{
          eventType: 'Meal Bolus'
          , created_at: new Date(bolusAt).toISOString()
          , mills: bolusAt
          , insulin: 2
          , carbs: 30
        }]
        , tempbasalTreatments: [{
          eventType: 'Temp Basal'
          , created_at: new Date(bolusAt).toISOString()
          , mills: bolusAt
          , duration: 30
          , absolute: 1.5
        }]
      };

      ['2023-10-29', '2026-03-29'].forEach(function (viewerDay) {
        moment.tz.setDefault(TIMEZONE);
        moment.now = () => moment.tz(viewerDay + 'T12:00:00', TIMEZONE).valueOf();
        delete require.cache[require.resolve('../lib/report_plugins/loopalyzer')];

        const charts = renderAllCharts(datastorage, [DAY], false);
        const bgSeries = charts['#loopalyzer-bg'].series.find(s => s.id === 'glucose');
        const basalSeries = charts['#loopalyzer-basal'].series.find(s => s.id === 'basals');
        const tempSeries = charts['#loopalyzer-tempbasal'].series.find(s => s.id === 'tempBasals');
        const iobSeries = charts['#loopalyzer-iob'].series.find(s => s.id === 'iobs');
        const cobSeries = charts['#loopalyzer-cob'].series.find(s => s.id === 'cobs');

        [bgSeries, basalSeries, tempSeries, iobSeries, cobSeries].forEach(function (series) {
          assert.equal(series.data.length, 288);
          assert.ok(series.data.some(point => Number.isFinite(point[1])));
        });

        const axisStart = bgSeries.data[0][0].getTime();
        bgSeries.data.forEach(function (point, index) {
          assert.equal(point[0].getTime(), axisStart + index * FIVE_MINUTES);
        });
        const axisEnd = axisStart + 288 * FIVE_MINUTES;
        [charts['#loopalyzer-iob'], charts['#loopalyzer-cob']].forEach(function (chart) {
          const treatmentMarking = chart.options.grid.markings.find(m => m.xaxis);
          assert.ok(treatmentMarking);
          assert.ok(treatmentMarking.xaxis.from.getTime() >= axisStart);
          assert.ok(treatmentMarking.xaxis.to.getTime() <= axisEnd);
        });
      });
    });

    it('retains series data when selected days include 23-hour and 25-hour DST transitions', function () {
      ['2026-03-29', '2026-10-25'].forEach(function (dstDay) {
        const morning = moment.tz(dstDay, TIMEZONE).valueOf() + 6 * 60 * 60 * 1000;
        const lateHour = moment.tz(dstDay, TIMEZONE).valueOf() + 24 * 60 * 60 * 1000 + 30 * 60 * 1000;
        const isLongDay = dstDay === '2026-10-25';

        const calculatedCharts = renderAllCharts({
          allstatsrecords: [reading(dstDay, 6 * 60 * 60 * 1000, 118)]
          , treatments: [{
            eventType: 'Meal Bolus'
            , created_at: new Date(morning).toISOString()
            , mills: morning
            , insulin: 2
            , carbs: 25
          }]
          , tempbasalTreatments: [{
            eventType: 'Temp Basal'
            , created_at: new Date(morning).toISOString()
            , mills: morning
            , duration: 30
            , absolute: 1.5
          }]
        }, [dstDay], false);

        ['#loopalyzer-basal', '#loopalyzer-bg', '#loopalyzer-tempbasal', '#loopalyzer-iob', '#loopalyzer-cob'].forEach(function (selector) {
          const data = calculatedCharts[selector].series[0].data;
          assert.equal(data.length, 288);
          assert.ok(data.some(point => Number.isFinite(point[1])));
        });

        const midnightPlus5 = moment.tz(dstDay, TIMEZONE).valueOf() + FIVE_MINUTES;
        const devicestatus = [
          {
            device: 'loop://iPhone'
            , mills: morning + FIVE_MINUTES
            , loop: {
              iob: { iob: 1.8, timestamp: new Date(morning + FIVE_MINUTES).toISOString() }
              , cob: { cob: 20, timestamp: new Date(morning + FIVE_MINUTES).toISOString() }
              , predicted: {
                startDate: new Date(morning + FIVE_MINUTES).toISOString()
                , values: [120, 125, 130]
              }
            }
          }
          , {
            device: 'loop://iPhone'
            , mills: midnightPlus5
            , loop: {
              iob: { iob: 0.4, timestamp: new Date(midnightPlus5).toISOString() }
              , cob: { cob: 0, timestamp: new Date(midnightPlus5).toISOString() }
              , predicted: {
                startDate: new Date(midnightPlus5).toISOString()
                , values: [105, 106, 107]
              }
            }
          }
        ];
        if (isLongDay) {
          devicestatus.unshift({
            device: 'loop://iPhone'
            , mills: lateHour
            , loop: {
              iob: { iob: 0.9, timestamp: new Date(lateHour).toISOString() }
              , cob: { cob: 10, timestamp: new Date(lateHour).toISOString() }
              , predicted: {
                startDate: new Date(lateHour - 20 * 60 * 1000).toISOString()
                , values: [110, 112, 114, 116, 118, 120]
              }
            }
          });
        }
        const treatments = [{
          eventType: 'Meal Bolus'
          , created_at: new Date(morning).toISOString()
          , mills: morning
          , insulin: 2
          , carbs: 25
        }];
        if (isLongDay) {
          treatments.push({
            eventType: 'Meal Bolus'
            , created_at: new Date(lateHour).toISOString()
            , mills: lateHour
            , insulin: 1
            , carbs: 15
          });
        }

        const statusCharts = renderAllCharts({
          allstatsrecords: [reading(dstDay, 6 * 60 * 60 * 1000, 118)]
          , treatments: treatments
          , devicestatus: devicestatus
        }, [dstDay], true);

        const predictions = statusCharts['#loopalyzer-bg'].series.find(s => s.id === 'predictions');
        assert.ok(predictions);
        assert.equal(predictions.data.length, 288);
        assert.ok(predictions.data.some(point => Number.isFinite(point[1])));
        assert.ok(statusCharts['#loopalyzer-iob'].series[0].data.some(point => Number.isFinite(point[1])));
        assert.ok(statusCharts['#loopalyzer-cob'].series[0].data.some(point => Number.isFinite(point[1])));
      });
    });
  });
});
