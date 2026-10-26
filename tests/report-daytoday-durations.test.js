'use strict';

const assert = require('assert/strict');
const moment = require('moment');
const createSecureDOM = require('./fixtures/secure-jsdom').createSecureDOM;
const domGlobals = require('./fixtures/dom-globals');

const HOUR = 60 * 60 * 1000;
const DAY1 = '2025-01-01';
const DAY2 = '2025-01-02';
const START = { [DAY1]: Date.parse(DAY1 + 'T00:00:00.000Z'), [DAY2]: Date.parse(DAY2 + 'T00:00:00.000Z') };
// Each day has readings at 00:00 and 23:55, which set the chart's time axis.
const LAST_READING = 23 * HOUR + 55 * 60 * 1000;
const WIDTH = 800;
const PADDING_LEFT = 35;
const PLOT_WIDTH = WIDTH - PADDING_LEFT - 22;

function xAt (day, hours) {
  return PADDING_LEFT + hours * HOUR / LAST_READING * PLOT_WIDTH;
}

function event (eventType, day, hours, minutes, fields) {
  return Object.assign({ eventType: eventType, mills: START[day] + hours * HOUR, duration: minutes }, fields);
}

describe('day-to-day report: events with a duration', function () {
  let env;
  let state;
  let priorD3;

  beforeEach(function () {
    priorD3 = global.d3;
    global.d3 = require('./fixtures/d3');
    delete global.window;
    delete global.document;
    env = createSecureDOM('<!DOCTYPE html><html><body><div id="daytodaycharts"></div></body></html>');
    state = domGlobals.installDomGlobals(env);
    env.window.moment = moment;
  });

  afterEach(function () {
    delete require.cache[require.resolve('../lib/report_plugins/daytoday')];
    if (priorD3 === undefined) delete global.d3;
    else global.d3 = priorD3;
    domGlobals.restoreDomGlobals(state);
  });

  // Mirrors reportclient: each shown day holds the treatments that start on it, and
  // datastorage.treatments holds every loaded day, including the day before the first.
  function render (days, treatments, options) {
    const profile = {
      applyTimezone: value => moment.utc(value)
      , loadData: function () {}
      , parseInTimezone: value => moment.utc(value)
      , updateTreatments: function () {}
    };
    env.window.Nightscout = {
      client: {
        plugins: () => ({ isDeviceStatusAvailable: () => false })
        , profilefunctions: { activeProfileToTime: () => 'Default', profileSwitchName: name => name }
        , sbx: { data: { profile: profile } }
        , settings: { timeFormat: 24 }
        , ticks: () => []
        , tooltip: global.d3.select(env.document.body).append('div')
        , translate: value => value
        , utils: { scaleMgdl: value => value, roundBGForDisplay: value => value }
      }
      , predictions: { offset: 0 }
      , report_plugins: {
        consts: { SCALE_LOG: 'log' }
        , utils: { localeDate: value => value, scaledTreatmentBG: () => 100 }
      }
    };
    const datastorage = {
      alldays: days.length
      , combobolusTreatments: []
      , devicestatus: []
      , profiles: []
      , profileSwitchTreatments: []
      , tempbasalTreatments: []
      , treatments: treatments.slice().sort((a, b) => a.mills - b.mills)
    };
    days.forEach(function (day) {
      datastorage[day] = {
        dailyCarbs: 0
        , dailyFat: 0
        , dailyProtein: 0
        , devicestatus: []
        , sgv: [0, LAST_READING].map(offset => ({
          color: 'green', date: new Date(START[day] + offset), mills: START[day] + offset, sgv: 120, type: 'sgv'
        }))
        , treatments: treatments.filter(t => t.mills >= START[day] && t.mills < START[day] + 24 * HOUR)
      };
    });

    require('../lib/report_plugins/daytoday')().report(datastorage, days, Object.assign({
      basal: false, bgcheck: false, carbs: false, cob: false, food: false, height: 250, insulin: false
      , insulindistribution: false, iob: false, maxCarbsValue: 20, maxDailyCarbsValue: 1, maxInsulinValue: 1
      , notes: true, openAps: false, othertreatments: false, predicted: false, raw: false, scale: 'linear'
      , targetHigh: 180, targetLow: 80, width: WIDTH
    }, options));
  }

  function bands (day) {
    const svg = env.document.querySelector('#daytodaychart-' + day + ' svg');
    return Array.from(svg.querySelectorAll('rect'))
      .filter(rect => rect.getAttribute('opacity') === '0.2')
      .map(rect => ({
        fill: rect.getAttribute('fill')
        , x: Number(rect.getAttribute('x'))
        , end: Number(rect.getAttribute('x')) + Number(rect.getAttribute('width'))
      }));
  }

  function label (day, text) {
    const node = Array.from(env.document.querySelectorAll('#daytodaychart-' + day + ' svg text'))
      .find(candidate => candidate.textContent === text);
    return node && Number(node.getAttribute('x'));
  }

  function assertNear (actual, expected, message) {
    assert.ok(Math.abs(actual - expected) < 1e-6, message + ' (x ' + actual + ', should be ' + expected + ')');
  }

  it('draws an event that crosses midnight on both days, clipped to each day', function () {
    render([DAY1, DAY2], [event('Exercise', DAY1, 22, 240, { notes: 'Walk' })]);

    const first = bands(DAY1);
    const second = bands(DAY2);
    assert.equal(first.length, 1, 'bands on the day the event starts');
    assert.equal(second.length, 1, 'bands on the day after');

    assertNear(first[0].x, xAt(DAY1, 22), 'first day band start');
    assertNear(first[0].end, xAt(DAY1, 24), 'first day band ends at midnight');
    assertNear(label(DAY1, 'Walk'), xAt(DAY1, 23), 'first day label centred on 22:00 to 24:00');

    assertNear(second[0].x, xAt(DAY2, 0), 'second day band starts at midnight');
    assertNear(second[0].end, xAt(DAY2, 2), 'second day band ends when the event ends');
    assertNear(label(DAY2, 'Walk'), xAt(DAY2, 1), 'second day label centred on 00:00 to 02:00');
  });

  it('draws every band type on a day shown alone when the event began the day before', function () {
    render([DAY2], [
      event('Temporary Override', DAY1, 21.5, 270, { reason: 'Override' })
      , event('Note', DAY1, 22.5, 210, { notes: 'Note' })
      , event('OpenAPS Offline', DAY1, 23, 180, { notes: 'Offline' })
      , event('Temporary Target', DAY1, 23.5, 150, { notes: 'Target', targetTop: 140, targetBottom: 140 })
    ], { othertreatments: true });

    const drawn = bands(DAY2);
    assert.deepEqual(drawn.map(band => band.fill), ['black', 'Salmon', 'Brown', 'black']);
    drawn.forEach(function (band) {
      assertNear(band.x, xAt(DAY2, 0), band.fill + ' band starts at midnight');
      assertNear(band.end, xAt(DAY2, 2), band.fill + ' band ends when the event ends');
    });
    ['Override', 'Note', 'Offline', 'Target'].forEach(function (text) {
      assertNear(label(DAY2, text), xAt(DAY2, 1), text + ' label centred on 00:00 to 02:00');
    });
  });

  it('leaves same-day events unchanged and carries over only what is drawn as a band', function () {
    render([DAY1, DAY2], [
      event('Exercise', DAY1, 14, 60, { notes: 'Same day' })
      , event('Note', DAY1, 22, 240, { notes: 'Hidden note' })
      , event('Temp Basal', DAY1, 22, 240, { absolute: 0.5 })
      , event('Combo Bolus', DAY1, 22, 240, { insulin: 1, relative: 1 })
      , event('Profile Switch', DAY1, 22, 240, { profile: 'Night' })
      , event('Carb Correction', DAY1, 22, 240, { carbs: 20 })
    ], { notes: false, othertreatments: true });

    assert.deepEqual(bands(DAY1).map(band => band.fill), ['Violet']);
    assertNear(bands(DAY1)[0].x, xAt(DAY1, 14), 'same-day band start');
    assertNear(bands(DAY1)[0].end, xAt(DAY1, 15), 'same-day band end');
    assertNear(label(DAY1, 'Same day'), xAt(DAY1, 14.5), 'same-day label');
    assert.deepEqual(bands(DAY2), []);
    assert.equal(label(DAY2, 'Hidden note'), undefined);
  });
});
