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
  function render (days, treatments, options, readings) {
    const mmol = options && options.units === 'mmol';
    const profile = {
      applyTimezone: value => moment.utc(value)
      , loadData: function () {}
      , parseInTimezone: value => moment.utc(value)
      , updateTreatments: function () {}
      , getBasalRenderTimes: start => [start, start + 12 * HOUR]
      , getTempBasal: date => { const rate = options && options.basalRate !== undefined ? options.basalRate : moment.utc(Number(date)).hour() < 12 ? .5 : .8; return {basal: rate, tempbasal: rate, totalbasal: rate}; }
    };
    env.window.Nightscout = {
      client: {
        plugins: () => ({ isDeviceStatusAvailable: () => false })
        , profilefunctions: { activeProfileToTime: () => 'Default', profileSwitchName: name => name }
        , sbx: { data: { profile: profile } }
        , settings: { timeFormat: 24, units: mmol ? 'mmol' : 'mg/dl', theme: options && options.theme }
        , ticks: () => []
        , tooltip: global.d3.select(env.document.body).append('div')
        , translate: value => value
        , utils: { scaleMgdl: value => mmol ? value / 18.0182 : value, roundBGForDisplay: value => mmol ? Number(value).toFixed(1) : Math.round(value), toRoundedStr: value => String(value) }
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
        , sgv: readings || [0, LAST_READING].map(offset => ({
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

  function sensor (minutes, value = 120, fields = {}) {
    return Object.assign({type: 'sgv', color: 'green', sgv: value, date: new Date(START[DAY1] + minutes * 60000)}, fields);
  }

  it('smooths sensor readings without joining raw values, fingersticks or missing intervals', function () {
    const readings = [sensor(0), sensor(5, 130), sensor(10, 140), sensor(30, 150), sensor(35, 160),
      sensor(15, 145, {type: 'rawbg', color: 'gray'}), sensor(20, 130, {type: 'mbg', color: 'red'})];
    render([DAY1], [], {}, readings);
    const paths = Array.from(env.document.querySelectorAll('.daytoday-glucose-line'));
    assert.equal(paths.length, 2);
    assert.match(paths[0].getAttribute('d'), /C/, 'uses a smooth trend curve');
    assert.deepEqual(paths.map(path => path.__data__.points.map(point => point.mills)),
      [[0, 5, 10], [30, 35]].map(minutes => minutes.map(minute => START[DAY1] + minute * 60000)));
    assert.ok(paths.every(path => path.getAttribute('stroke') === '#348165'));
    assert.ok(paths.every(path => path.__data__.points.every(point => point.reading.type === 'sgv')));
  });

  for (const units of ['mg/dl', 'mmol']) {
    it('shows the original reading and time on hover in ' + units, function () {
      const value = units === 'mmol' ? 6.7 : 121;
      render([DAY1], [], {units}, [sensor(0, value), sensor(5, value), sensor(10, value)]);
      const sample = env.document.querySelectorAll('.daytoday-glucose-sample')[1];
      sample.dispatchEvent(new env.window.MouseEvent('mouseover', {bubbles: true, clientX: 200, clientY: 100}));
      const tooltip = env.document.querySelector('.daytoday-reading-tooltip');
      assert.equal(tooltip.querySelector('.daily-tooltip-glucose strong').textContent, value + (units === 'mmol' ? ' mmol/L' : ' mg/dL'));
      assert.ok(tooltip.textContent.includes('00:05'));
      assert.equal(tooltip.style.display, 'block');
      assert.equal(sample.getAttribute('fill'), '#fff');
      sample.dispatchEvent(new env.window.MouseEvent('mouseout', {bubbles: true}));
      assert.equal(tooltip.style.display, 'none');
      assert.equal(sample.getAttribute('fill'), 'transparent');
    });
  }

  for (const units of ['mg/dl', 'mmol']) {
    it('tracks the nearest reading from empty plot space in ' + units, function () {
      const values = units === 'mmol' ? [5.5, 6.7, 7.8] : [100, 121, 140];
      render([DAY1], [], {units}, [sensor(0, values[0]), sensor(5, values[1]), sensor(10, values[2])]);
      const svg = env.document.querySelector('#daytodaychart-' + DAY1 + ' svg');
      const focus = svg.querySelector('.daytoday-glucose-focus');
      // Move well above the glucose curve, halfway through the time axis.
      svg.dispatchEvent(new env.window.MouseEvent('mousemove', {bubbles: true, clientX: PADDING_LEFT + PLOT_WIDTH / 2, clientY: 25}));
      const tooltip = env.document.querySelector('.daytoday-reading-tooltip');
      assert.equal(tooltip.style.display, 'block');
      assert.equal(tooltip.querySelector('.daily-tooltip-glucose strong').textContent, values[1] + (units === 'mmol' ? ' mmol/L' : ' mg/dL'));
      assert.ok(tooltip.textContent.includes('00:05'));
      assert.equal(focus.style.display, '');
      assert.equal(Number(focus.querySelector('circle').getAttribute('cx')), PADDING_LEFT + PLOT_WIDTH / 2);
      svg.dispatchEvent(new env.window.MouseEvent('mousemove', {bubbles: true, clientX: PADDING_LEFT + PLOT_WIDTH * .85, clientY: 25}));
      assert.ok(tooltip.textContent.includes('00:10'), 'moves to the nearest sample by time');
      svg.dispatchEvent(new env.window.MouseEvent('mouseleave'));
      assert.equal(tooltip.style.display, 'none');
      assert.equal(focus.style.display, 'none');
    });
  }

  it('keeps modern basal rates on their own axis and retains exact treatment amounts and totals', function () {
    const readings = [sensor(0, 100), sensor(5, 121), sensor(10, 140)];
    const original = JSON.stringify(readings);
    render([DAY1], [event('Meal Bolus', DAY1, 5 / 60, 0, {insulin: 2, carbs: 25})],
      {theme: 'modern', basal: true, insulin: true, carbs: true, insulindistribution: true}, readings);
    const svg = env.document.querySelector('#daytodaychart-' + DAY1 + ' svg');
    assert.ok(svg.querySelector('.daily-basal-axis'));
    assert.ok(svg.querySelector('.daily-glucose-wash'));
    assert.equal(svg.querySelector('.daily-treatment-carbs text').textContent, '25 g');
    assert.equal(svg.querySelector('.daily-treatment-bolus text').textContent, '2 U');
    assert.equal(env.document.querySelector('.daily-insulin-total').textContent, '17.6');
    const legend = env.document.querySelector('.daily-insulin-legend').textContent;
    assert.ok(legend.includes('15.6 U')); assert.ok(legend.includes('2.0 U'));
    assert.equal(JSON.stringify(readings), original, 'presentation leaves the sensor readings untouched');
    const basalTicks = Array.from(svg.querySelectorAll('.daily-basal-axis .tick')).map(node => Number(node.getAttribute('transform').match(/,([^)]*)/)[1]));
    const glucoseTicks = Array.from(svg.querySelectorAll('.y.axis .tick')).map(node => Number(node.getAttribute('transform').match(/,([^)]*)/)[1]));
    // Axis fixture supplies no glucose ticks; the basal track still starts below the 260px glucose plot.
    assert.ok(basalTicks.every(y => y > 260));
    assert.equal(glucoseTicks.length, 0);
  });

  for (const units of ['mg/dl', 'mmol']) {
    it('combines glucose, basal and all nearby treatments in ' + units, function () {
      const value = units === 'mmol' ? 6.7 : 121;
      render([DAY1], [
        event('Meal Bolus', DAY1, 4 / 60, 0, {insulin: 2, carbs: 25, notes: '<img src=x onerror=alert(1)>'}),
        event('Temp Basal', DAY1, 8 / 60, 30, {absolute: 0}),
        event('Meal Bolus', DAY1, 20 / 60, 0, {insulin: 99})
      ], {units, theme: 'modern', basal: true, insulin: true, carbs: true}, [sensor(0, value), sensor(5, value), sensor(10, value)]);
      const svg = env.document.querySelector('#daytodaychart-' + DAY1 + ' svg');
      const x = Number(svg.querySelectorAll('.daytoday-glucose-sample')[1].getAttribute('cx'));
      svg.dispatchEvent(new env.window.MouseEvent('mousemove', {bubbles: true, clientX: x, clientY: 60}));
      const tooltip = env.document.querySelector('.daytoday-reading-tooltip');
      assert.equal(tooltip.querySelector('.daily-tooltip-glucose strong').textContent, value + (units === 'mmol' ? ' mmol/L' : ' mg/dL'));
      assert.equal(tooltip.querySelector('.daily-tooltip-basal strong').textContent, '0.5 U/h');
      assert.equal(tooltip.querySelectorAll('li').length, 2);
      assert.ok(tooltip.querySelector('li span').textContent.includes('2 U · 25 g'));
      assert.equal(tooltip.querySelectorAll('li span')[1].textContent, '0 U/h · 30 min');
      assert.ok(!tooltip.textContent.includes('99 U'));
      assert.equal(tooltip.querySelector('img'), null, 'treatment notes are text, not executable markup');
      assert.equal(svg.querySelectorAll('.daily-treatment.is-selected').length, 2);
      assert.equal(svg.querySelector('.daily-basal-focus').style.display, '');
      svg.dispatchEvent(new env.window.MouseEvent('mouseleave'));
      assert.equal(svg.querySelectorAll('.daily-treatment.is-selected').length, 0);
    });
  }

  it('selects the new basal rate at a rate boundary and displays suspension as zero', function () {
    for (const basalRate of [undefined, 0]) {
      render([DAY1], [], {basal: true, basalRate}, [sensor(0), sensor(720), sensor(1435)]);
      const svg = env.document.querySelector('#daytodaychart-' + DAY1 + ' svg');
      const x = Number(svg.querySelectorAll('.daytoday-glucose-sample')[1].getAttribute('cx'));
      svg.dispatchEvent(new env.window.MouseEvent('mousemove', {bubbles: true, clientX: x, clientY: 25}));
      const tooltip = Array.from(env.document.querySelectorAll('.daytoday-reading-tooltip')).at(-1);
      assert.equal(tooltip.querySelector('.daily-tooltip-basal strong').textContent, basalRate === 0 ? '0 U/h' : '0.8 U/h');
      assert.ok(tooltip.textContent.includes('No nearby treatments'));
    }
  });

  it('shows treatments and basal when the day has no sensor readings', function () {
    render([DAY1], [event('Meal Bolus', DAY1, 5 / 60, 0, {insulin: 2})],
      {theme: 'modern', basal: true, insulin: true},
      [sensor(0, 40, {type: 'rawbg', color: 'transparent'}), sensor(1440, 40, {type: 'rawbg', color: 'transparent'})]);
    const svg = env.document.querySelector('#daytodaychart-' + DAY1 + ' svg');
    const x = Number(svg.querySelector('.daily-treatment-bolus circle').getAttribute('cx'));
    svg.dispatchEvent(new env.window.MouseEvent('mousemove', {bubbles: true, clientX: x, clientY: 60}));
    const tooltip = env.document.querySelector('.daytoday-reading-tooltip');
    assert.ok(tooltip.textContent.includes('No glucose reading'));
    assert.equal(tooltip.querySelector('li span').textContent, '2 U');
    assert.equal(tooltip.querySelector('.daily-tooltip-basal strong').textContent, '0.5 U/h');
  });

  it('keeps tooltip height fixed while following horizontal pointer movement', function () {
    render([DAY1], [], {theme: 'modern', basal: true}, [sensor(0), sensor(5), sensor(10)]);
    const svg = env.document.querySelector('#daytodaychart-' + DAY1 + ' svg');
    svg.getBoundingClientRect = () => ({left: 0, top: 100});
    Object.defineProperty(env.document.documentElement, 'clientWidth', {configurable: true, value: 1200});
    const tooltip = env.window.Nightscout.client.tooltip.node();
    let height = 100;
    tooltip.getBoundingClientRect = () => ({width: 240, height});
    svg.dispatchEvent(new env.window.MouseEvent('mousemove', {bubbles: true, clientX: 300, clientY: 160}));
    const top = tooltip.style.top, left = Number.parseFloat(tooltip.style.left);
    height = 500;
    svg.dispatchEvent(new env.window.MouseEvent('mousemove', {bubbles: true, clientX: 500, clientY: 300}));
    assert.equal(tooltip.style.top, top, 'vertical position ignores pointer Y and tooltip height');
    assert.equal(Number.parseFloat(tooltip.style.left) - left, 200);
  });

  it('keeps the first reading selectable at the rounded plot boundary', function () {
    render([DAY1], [], {basal: true}, [sensor(0), sensor(5), sensor(10)]);
    const svg = env.document.querySelector('#daytodaychart-' + DAY1 + ' svg');
    svg.dispatchEvent(new env.window.MouseEvent('mousemove', {bubbles: true, clientX: PADDING_LEFT - .5, clientY: 25}));
    const tooltip = env.document.querySelector('.daytoday-reading-tooltip');
    assert.equal(tooltip.style.display, 'block');
    assert.ok(tooltip.textContent.includes('00:00'));
  });

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
