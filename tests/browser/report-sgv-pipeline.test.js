'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {withPage} = require('./fixture');
const {buildModules} = require('./modules');

const DAY = '2025-02-03';
const BASE = Date.UTC(2025, 1, 3);
const DAY_SECONDS = 24 * 60 * 60;
const HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
  '<ul id="tabnav"></ul><div id="pluginchartplaceholders"></div>' +
  '<button id="rp_show">Show</button><input id="rp_from"><input id="rp_to">' +
  '<input id="rp_targetlow"><input id="rp_targethigh">' +
  '<input id="rp_linear" type="radio"><input id="wrp_linear" type="radio">' +
  '<input id="rp_oldestontop" type="radio" checked>' +
  '<input id="rp_enabledate" type="checkbox" checked>' +
  '<input id="rp_mo" type="checkbox" checked><input id="rp_tu" type="checkbox" checked>' +
  '<input id="rp_we" type="checkbox" checked><div id="info"></div></body></html>';

describe('report SGV loading and Daily Stats in a real browser', function () {
  let server, origin, entries, requests;
  before(async function () {
    const app = fs.readFileSync(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public/js/bundle.app.js'));
    const modules = await buildModules();
    const pageBundle = fs.readFileSync(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public/js/bundle.reports.js'));
    server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/page.js') {
        response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        response.end(pageBundle); return;
      }
      if (url.pathname === '/bundle.js' || url.pathname === '/modules.js') {
        response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        response.end(url.pathname === '/bundle.js' ? app : modules);
      } else if (url.pathname.startsWith('/api/')) {
        requests.push({method: request.method, url});
        let data = [];
        if (url.pathname === '/api/v1/entries.json') {
          const from = Number(url.searchParams.get('find[date][$gte]'));
          const to = Number(url.searchParams.get('find[date][$lt]'));
          data = entries.filter(entry => entry.date >= from && entry.date < to);
        } else if (!['/api/v1/food/regular.json', '/api/v1/treatments.json', '/api/v1/profiles'].includes(url.pathname)) {
          response.writeHead(404).end();
          return;
        }
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify(data));
      } else if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(HTML);
      } else response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  async function withReportPage(run) {
    return withPage(origin, async ({page}) => {
      await page.goto(origin);
      await page.addScriptTag({url: origin + '/bundle.js'});
      await page.addScriptTag({url: origin + '/page.js'});
      await page.addScriptTag({url: origin + '/modules.js'});
      await run(page);
    });
  }

  async function withReport(offsets, units, values, endDay, run) {
    entries = offsets.map((seconds, index) => ({type: 'sgv', date: BASE + seconds * 1000, sgv: values[index], device: 'report-test'})).reverse();
    requests = [];
    await withReportPage(async page => {
      await page.evaluate(({units, day, endDay}) => {
        const $ = window.$, moment = window.moment, Nightscout = window.Nightscout;
        const ctx = {moment, settings: {units}, language: {translate: value => value}};
        const client = {
          ctx, settings: {units, scaleY: 'linear', thresholds: {bgTargetBottom: 80, bgTargetTop: 180}},
          careportal: {events: []}, headers: () => ({}), init: callback => callback(),
          translate: ctx.language.translate, utils: window.NightscoutTestModules.utils(ctx),
          sbx: {data: {profile: {parseInTimezone: value => moment.utc(value)}}},
          ddata: {processDurations: treatments => treatments}
        };
        // Preserve the original immutable API-response guarantee, while using
        // native jQuery HTTP and its real JSON converter.
        const parse = $.ajaxSettings.converters['text json'];
        $.ajaxPrefilter(options => {
          if (options.url.startsWith('/api/v1/entries.json?')) {
            options.converters = {...options.converters, 'text json': text => Object.freeze(parse(text).map(Object.freeze))};
          }
        });
        let pies = {};
        const plot = $.plot;
        $.plot = Object.assign(function (selector, series, options) {
          if (!selector.startsWith('#dailystat-chart-')) throw new Error('Unexpected chart: ' + selector);
          pies[selector.slice('#dailystat-chart-'.length)] = series.map(band => ({...band}));
          return plot.call(this, selector, series, options);
        }, plot);
        const registry = Nightscout.report_plugins_preinit;
        Nightscout.client = client;
        Nightscout.report_plugins_preinit = context => {
          const plugins = registry(context), daily = plugins('dailystats');
          // Preserve the real registry and report HTML; focus rendering on Daily Stats.
          plugins.eachPlugin = callback => callback({...daily, report(storage, days, options) {
            daily.report(storage, days, options);
            // Flot adds nested legend tables; only inspect the report table's
            // own rows, preserving the original statistics assertions.
            const table = document.querySelector('#dailystats-report > table');
            const headers = Array.from(table.rows[0].cells, cell => cell.textContent);
            const rows = Array.from(table.rows).slice(1)
              .map(row => Array.from(row.children, cell => cell.textContent));
            window.reportResult = JSON.parse(JSON.stringify({
              data: storage[day], table: Object.fromEntries(headers.map((name, index) => [name, rows[0][index]])),
              pie: pies[day], rows, days: days.slice(), pies,
              stats: days.map(day => storage[day].statsrecords),
              canvases: document.querySelectorAll('#dailystats-report canvas').length
            }));
          }});
          return plugins;
        };
        Nightscout.reportclient();
        $('#rp_from').val(day);
        $('#rp_to').val(endDay);
        window.resetReportResult = () => { window.reportResult = null; pies = {}; };
      }, {units, day: DAY, endDay});
      await page.waitForFunction(() => window.$.active === 0);
      async function show() {
        await page.evaluate(() => window.resetReportResult());
        await page.locator('#rp_show').click();
        await page.waitForFunction(() => window.reportResult && window.$.active === 0);
        const result = await page.evaluate(() => window.reportResult);
        assert.ok(result.canvases >= Object.keys(result.pies).length, 'Real Flot canvases were drawn');
        const cgmRequests = requests.filter(request => request.url.pathname === '/api/v1/entries.json');
        for (const request of requests) assert.equal(request.method, 'GET');
        for (const {url} of cgmRequests) {
          const from = Number(url.searchParams.get('find[date][$gte]'));
          const to = Number(url.searchParams.get('find[date][$lt]'));
          assert.ok(from >= BASE && from <= Date.parse(endDay + 'T00:00:00.000Z'));
          assert.equal(to - from, DAY_SECONDS * 1000);
          assert.equal(url.searchParams.get('count'), '10000');
        }
        return {...result, entriesRequests: cgmRequests.length, showAgain: show};
      }
      await run(await show());
    });
  }

  ['mg/dl', 'mmol'].forEach(function (units) {
    [
      { name: 'dense', offsets: [0, 58, 116], kept: [0, 116], bands: ['0%', '50%', '50%'], pie: [0, 50, 50] },
      { name: 'five-minute', offsets: [0, 300, 600], kept: [0, 300, 600], bands: ['33%', '33%', '33%'], pie: [33.3, 33.3, 33.3] }
    ].forEach(function (fixture) {
      it('uses the retained ' + fixture.name + ' readings in charts and statistics (' + units + ')', async function () {
        await withReport(fixture.offsets, units, [100, 50, 200], DAY, async result => {
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
    });

    it('calculates estimated A1c before rounding glucose for display (' + units + ')', async function () {
      // 150 mg/dL displays as 8.3 mmol/L. Converting that rounded display value
      // back to mg/dL would incorrectly round the A1c estimate down to 6.8%.
      await withReport([0], units, [150], DAY, async result => {
        assert.equal(result.table.Readings, '1');
        assert.equal(result.table.Average, units === 'mg/dl' ? '150.0' : '8.3');
        assert.equal(result.table['A1c est* %DCCT'], '6.9%');
        assert.equal(result.table['A1c est* IFCC'], '51');
      });
    });

    it('keeps daily A1c totals separate across an empty day and cached re-renders (' + units + ')', async function () {
      // Different sample counts and means expose sums or denominators leaking
      // between days: Monday averages 150 mg/dL, Wednesday averages 300 mg/dL.
      await withReport(
        [0, 300, 2 * DAY_SECONDS, 2 * DAY_SECONDS + 300, 2 * DAY_SECONDS + 600],
        units, [100, 200, 200, 300, 400], '2025-02-05', async result => {
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

  describe('report page reconnect initialization', function () {
    it('builds and wires the report GUI only for the first authorized connection', async function () {
      requests = [];
      await withReportPage(async page => {
        await page.evaluate(() => {
          const $ = window.$, moment = window.moment, Nightscout = window.Nightscout;
          const ctx = {moment, settings: {units: 'mg/dl'}, language: {translate: value => value}};
          let authorized, addHtmlCalls = 0;
          const client = {
            ctx, careportal: {events: []}, headers: () => ({}), init: callback => { authorized = callback; },
            settings: {scaleY: 'linear', units: 'mg/dl', thresholds: {bgTargetBottom: 80, bgTargetTop: 180}},
            translate: ctx.language.translate, utils: window.NightscoutTestModules.utils(ctx)
          };
          const registry = Nightscout.report_plugins_preinit;
          Nightscout.client = client;
          Nightscout.report_plugins_preinit = context => {
            const plugins = registry(context), addHtml = plugins.addHtmlFromPlugins;
            plugins.addHtmlFromPlugins = client => { addHtmlCalls++; return addHtml(client); };
            return plugins;
          };
          Nightscout.reportclient();
          window.reconnectReport = () => authorized();
          window.reportGuiState = () => ({
            addHtmlCalls, handlers: $._data($('#rp_show')[0], 'events').click.length,
            from: $('#rp_from').val(), selected: $('#tabnav > li.selected').attr('id'),
            menu: $('#tabnav > li').length, placeholders: $('#pluginchartplaceholders > div').length,
            styles: $('style[id$="-css"]').length
          });
          authorized();
        });
        await page.waitForFunction(() => window.$.active === 0);
        const first = await page.evaluate(() => window.reportGuiState());
        assert.equal(first.addHtmlCalls, 1);
        assert.equal(first.handlers, 1);
        assert.ok(first.menu > 1);
        await page.locator('#rp_from').fill(DAY);
        await page.locator('#tabnav > li').nth(1).click();
        const chosen = await page.evaluate(() => window.reportGuiState());
        assert.notEqual(chosen.selected, first.selected);
        for (let cycle = 0; cycle < 2; cycle++) {
          await page.evaluate(() => window.reconnectReport());
          await page.waitForFunction(() => window.$.active === 0);
          assert.deepEqual(await page.evaluate(() => window.reportGuiState()), chosen);
        }
        assert.equal(requests.length, 1, 'Reconnect must not reload the food database');
        assert.equal(requests[0].method, 'GET');
        assert.equal(requests[0].url.pathname, '/api/v1/food/regular.json');
      });
    });

    it('makes plugin HTML and styles idempotent while preserving tab selection', async function () {
      requests = [];
      await withReportPage(async page => {
        await page.evaluate(() => {
          const $ = window.$, Nightscout = window.Nightscout;
          const client = {translate: value => value};
          Nightscout.client = client;
          const plugins = Nightscout.report_plugins_preinit({language: {translate: client.translate}});
          window.addReportHtml = () => plugins.addHtmlFromPlugins(client);
          window.reportHtmlState = () => ({
            menu: $('#tabnav > li').length, placeholders: $('#pluginchartplaceholders > div').length,
            styles: Array.from(document.querySelectorAll('style[id$="-css"]'), style => style.id),
            selected: $('#tabnav > li.selected').attr('id'),
            secondDisplay: $('#pluginchartplaceholders > div').eq(1).css('display')
          });
          window.addReportHtml();
        });
        const first = await page.evaluate(() => window.reportHtmlState());
        assert.ok(first.styles.length > 0);
        await page.evaluate(() => {
          const $ = window.$;
          $('#tabnav > li').removeClass('selected').eq(1).addClass('selected');
          $('#pluginchartplaceholders > div').hide().eq(1).show();
        });
        const chosen = await page.evaluate(() => window.reportHtmlState());
        assert.equal(chosen.menu, first.menu);
        assert.equal(chosen.placeholders, first.placeholders);
        assert.notEqual(chosen.selected, first.selected);
        assert.notEqual(chosen.secondDisplay, 'none');
        for (let cycle = 0; cycle < 2; cycle++) {
          await page.evaluate(() => window.addReportHtml());
          const repeated = await page.evaluate(() => window.reportHtmlState());
          assert.deepEqual(repeated, chosen);
          assert.equal(new Set(repeated.styles).size, repeated.styles.length);
        }
        assert.equal(requests.length, 0);
      });
    });
  });
});
