'use strict';

const assert = require('assert/strict');
const moment = require('moment');
const createSecureDOM = require('./fixtures/secure-jsdom').createSecureDOM;
const domGlobals = require('./fixtures/dom-globals');

const DAY = '2025-02-03'; // Monday, selected by the fixture's weekday filter.
const BASE = Date.UTC(2025, 1, 3);
const DAY_SECONDS = 24 * 60 * 60;
const DOM_GLOBALS = ['window', 'document', 'navigator', '$', 'jQuery'];

function clearReportModules () {
  Object.keys(require.cache).forEach(function (modulePath) {
    if (modulePath.includes('/lib/report/') || modulePath.includes('/lib/report_plugins/')) {
      delete require.cache[modulePath];
    }
  });
  delete require.cache[require.resolve('js-storage')];
}

describe('report SGV loading and Daily Stats', function () {
  let env;
  let state;
  let $;
  let previousGlobals;

  beforeEach(function () {
    previousGlobals = Object.fromEntries(DOM_GLOBALS.map(function (name) {
      return [name, Object.getOwnPropertyDescriptor(global, name)];
    }));
    clearReportModules();
    env = createSecureDOM(
      '<!DOCTYPE html><html><head></head><body>' +
      '<ul id="tabnav"></ul><div id="pluginchartplaceholders"></div>' +
      '<button id="rp_show">Show</button>' +
      '<input id="rp_from"><input id="rp_to">' +
      '<input id="rp_targetlow"><input id="rp_targethigh">' +
      '<input id="rp_linear" type="radio"><input id="wrp_linear" type="radio">' +
      '<input id="rp_oldestontop" type="radio" checked>' +
      '<input id="rp_enabledate" type="checkbox" checked>' +
      '<input id="rp_mo" type="checkbox" checked>' +
      '<input id="rp_tu" type="checkbox" checked>' +
      '<input id="rp_we" type="checkbox" checked><div id="info"></div>' +
      '</body></html>'
    );
    state = domGlobals.installDomGlobals(env);
    $ = env.window.$;
    env.window.moment = moment;
  });

  afterEach(function () {
    clearReportModules();
    domGlobals.restoreDomGlobals(state);
    DOM_GLOBALS.forEach(function (name) {
      if (previousGlobals[name]) {
        Object.defineProperty(global, name, previousGlobals[name]);
      } else {
        delete global[name];
      }
    });
  });

  function renderReport (offsets, units, values = [100, 50, 200], endDay = DAY) {
    // The API returns newest first. Freeze it to catch accidental in-place sorting.
    const entries = Object.freeze(offsets.map(function (seconds, index) {
      return Object.freeze({
        type: 'sgv', date: BASE + seconds * 1000, sgv: values[index], device: 'report-test'
      });
    }).reverse());
    let entriesRequests = 0;
    let pies;
    let resolveRender;
    let rejectRender;

    function show () {
      return new Promise(function (resolve, reject) {
        resolveRender = resolve;
        rejectRender = reject;
        pies = {};
        $('#rp_show').trigger('click');
      });
    }

    // Exercise the real loading, filtering, unit conversion and table renderer;
    // only network responses and canvas drawing are replaced.
    $.ajax = function (url, options) {
      let response = [];
      if (url.startsWith('/api/v1/entries.json?')) {
        entriesRequests++;
        const query = new URL(url, 'http://localhost').searchParams;
        const from = Number(query.get('find[date][$gte]'));
        const to = Number(query.get('find[date][$lt]'));
        assert.ok(from >= BASE && from <= moment.utc(endDay).valueOf());
        assert.equal(to - from, DAY_SECONDS * 1000);
        response = Object.freeze(entries.filter(entry => entry.date >= from && entry.date < to));
      } else {
        assert.ok(['/api/v1/food/regular.json', '/api/v1/treatments.json', '/api/v1/profiles']
          .some(function (path) { return url.startsWith(path); }), 'Unexpected request: ' + url);
      }
      options.success(response);
      return $.Deferred().resolve(response).promise();
    };
    $.plot = function (selector, series) {
      assert.ok(selector.startsWith('#dailystat-chart-'));
      pies[selector.slice('#dailystat-chart-'.length)] = series;
    };

    const ctx = { moment: moment, settings: { units: units }, language: { translate: value => value } };
    const client = {
      ctx: ctx,
      settings: { units: units, scaleY: 'linear', thresholds: { bgTargetBottom: 80, bgTargetTop: 180 } },
      careportal: { events: [] },
      headers: () => ({}),
      init: callback => callback(),
      translate: ctx.language.translate,
      utils: require('../lib/utils')(ctx),
      sbx: { data: { profile: { parseInTimezone: value => moment.utc(value) } } },
      ddata: { processDurations: treatments => treatments }
    };

    env.window.addEventListener('error', function (event) {
      event.preventDefault();
      rejectRender(event.error || new Error(event.message));
    });
    env.window.Nightscout = {
      client: client,
      report_plugins_preinit: function (context) {
        const plugins = require('../lib/report_plugins')(context);
        const daily = plugins('dailystats');
        // Keep the real plugin registry/HTML setup, rendering just Daily Stats.
        plugins.eachPlugin = function (callback) {
          callback(Object.assign({}, daily, {
            report: function (storage, days, options) {
              daily.report(storage, days, options);
              const headers = $('#dailystats-report th').map((_, cell) => $(cell).text()).get();
              const rows = $('#dailystats-report tr').get().slice(1).map(function (row) {
                return $(row).children().map((_, cell) => $(cell).text()).get();
              });
              resolveRender({
                data: storage[DAY],
                table: Object.fromEntries(headers.map((name, index) => [name, rows[0][index]])),
                pie: pies[DAY],
                rows: rows,
                days: days.slice(),
                pies: pies,
                // Snapshot cached records so a later render cannot alter the first result.
                stats: days.map(day => storage[day].statsrecords.map(record => Object.assign({}, record))),
                entriesRequests: entriesRequests,
                showAgain: show
              });
            }
          }));
        };
        return plugins;
      }
    };
    require('../lib/report/reportclient')();
    $('#rp_from').val(DAY);
    $('#rp_to').val(endDay);
    return show();
  }

  ['mg/dl', 'mmol'].forEach(function (units) {
    [
      { name: 'dense', offsets: [0, 58, 116], kept: [0, 116], bands: ['0%', '50%', '50%'], pie: [0, 50, 50] },
      { name: 'five-minute', offsets: [0, 300, 600], kept: [0, 300, 600], bands: ['33%', '33%', '33%'], pie: [33.3, 33.3, 33.3] }
    ].forEach(function (fixture) {
      it('uses the retained ' + fixture.name + ' readings in charts and statistics (' + units + ')', async function () {
        const result = await renderReport(fixture.offsets, units);
        const expectedValues = units === 'mg/dl' ? [100, 50, 200] : [5.6, 2.8, 11.1];
        const expectedStats = fixture.name === 'dense' ? [expectedValues[0], expectedValues[2]] : expectedValues;
        assert.equal(result.entriesRequests, 1);
        assert.deepEqual(result.data.sgv.filter(entry => entry.type === 'sgv')
          .map(entry => (entry.mills - BASE) / 1000), fixture.kept);
        assert.deepEqual(result.data.statsrecords.map(entry => entry.sgv), expectedStats);
        assert.equal(result.table.Readings, String(fixture.kept.length));
        assert.deepEqual([result.table.Low, result.table.Normal, result.table.High], fixture.bands);
        assert.deepEqual(result.pie.map(band => band.label), ['Low', 'In Range', 'High']);
        assert.deepEqual(result.pie.map(band => band.data), fixture.pie);
        assert.equal(result.table['A1c est* %DCCT'], fixture.name === 'dense' ? '6.9%' : '5.7%');
        assert.equal(result.table['A1c est* IFCC'], fixture.name === 'dense' ? '51' : '39');
      });
    });

    it('calculates estimated A1c before rounding glucose for display (' + units + ')', async function () {
      // 150 mg/dL displays as 8.3 mmol/L. Converting that rounded display value
      // back to mg/dL would incorrectly round the A1c estimate down to 6.8%.
      const result = await renderReport([0], units, [150]);
      assert.equal(result.table.Readings, '1');
      assert.equal(result.table.Average, units === 'mg/dl' ? '150.0' : '8.3');
      assert.equal(result.table['A1c est* %DCCT'], '6.9%');
      assert.equal(result.table['A1c est* IFCC'], '51');
    });

    it('keeps daily A1c totals separate across an empty day and cached re-renders (' + units + ')', async function () {
      // Different sample counts and means expose sums or denominators leaking
      // between days: Monday averages 150 mg/dL, Wednesday averages 300 mg/dL.
      const result = await renderReport(
        [0, 300, 2 * DAY_SECONDS, 2 * DAY_SECONDS + 300, 2 * DAY_SECONDS + 600],
        units, [100, 200, 200, 300, 400], '2025-02-05'
      );
      assert.equal(result.entriesRequests, 3);
      assert.deepEqual(result.days, [DAY, '2025-02-04', '2025-02-05']);
      assert.equal(result.rows.length, 3);
      assert.equal(result.rows[0][5], '2');
      assert.equal(result.rows[2][5], '3');
      assert.equal(result.rows[0][8], units === 'mg/dl' ? '150.0' : '8.3');
      assert.equal(result.rows[2][8], units === 'mg/dl' ? '300.0' : '16.7');
      assert.deepEqual(result.rows[0].slice(13), ['6.9%', '51']);
      assert.deepEqual(result.rows[2].slice(13), ['12.1%', '109']);
      // The empty day has a date and message, with no numeric statistics or pie.
      assert.equal(result.rows[1].length, 3);
      assert.equal(result.rows[1][2], 'No data available');
      assert.deepEqual(Object.keys(result.pies), [DAY, '2025-02-05']);
      assert.deepEqual(result.stats.map(records => records.map(record => record.bgValue)),
        [[100, 200], [], [200, 300, 400]]);

      const repeated = await result.showAgain();
      assert.equal(repeated.entriesRequests, 3, 'Historical CGM data should be reused from the report cache');
      assert.deepEqual(repeated.days, result.days);
      assert.deepEqual(repeated.rows, result.rows);
      assert.deepEqual(repeated.pies, result.pies);
      assert.deepEqual(repeated.stats, result.stats);
    });
  });
});
