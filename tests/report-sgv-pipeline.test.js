'use strict';

const assert = require('assert/strict');
const moment = require('moment');
const createSecureDOM = require('./fixtures/secure-jsdom').createSecureDOM;
const domGlobals = require('./fixtures/dom-globals');

const DAY = '2025-02-03'; // Monday, selected by the fixture's weekday filter.
const BASE = Date.UTC(2025, 1, 3);
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
      '<input id="rp_enabledate" type="checkbox" checked>' +
      '<input id="rp_mo" type="checkbox" checked><div id="info"></div>' +
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

  function renderReport (offsets, units) {
    const values = [100, 50, 200];
    // The API returns newest first. Freeze it to catch accidental in-place sorting.
    const entries = Object.freeze(offsets.map(function (seconds, index) {
      return Object.freeze({
        type: 'sgv', date: BASE + seconds * 1000, sgv: values[index], device: 'report-test'
      });
    }).reverse());
    let entriesRequests = 0;
    let pie;
    // Exercise the real loading, filtering, unit conversion and table renderer;
    // only network responses and canvas drawing are replaced.
    $.ajax = function (url, options) {
      let response = [];
      if (url.startsWith('/api/v1/entries.json?')) {
        entriesRequests++;
        assert.ok(url.includes('find[date][$gte]=' + BASE));
        response = entries;
      } else {
        assert.ok(['/api/v1/food/regular.json', '/api/v1/treatments.json', '/api/v1/profiles']
          .some(function (path) { return url.startsWith(path); }), 'Unexpected request: ' + url);
      }
      options.success(response);
      return $.Deferred().resolve(response).promise();
    };
    $.plot = function (selector, series) {
      assert.equal(selector, '#dailystat-chart-' + DAY);
      pie = series;
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

    return new Promise(function (resolve, reject) {
      env.window.addEventListener('error', function (event) {
        event.preventDefault();
        reject(event.error || new Error(event.message));
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
                const cells = $('#dailystats-report tr').eq(1).children();
                resolve({
                  data: storage[DAY],
                  table: Object.fromEntries(headers.map((name, index) => [name, cells.eq(index).text()])),
                  pie: pie,
                  entriesRequests: entriesRequests
                });
              }
            }));
          };
          return plugins;
        }
      };
      require('../lib/report/reportclient')();
      $('#rp_from, #rp_to').val(DAY);
      $('#rp_show').trigger('click');
    });
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
      });
    });
  });
});
