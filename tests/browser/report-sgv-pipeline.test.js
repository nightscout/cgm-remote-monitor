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
  '<input id="rp_we" type="checkbox" checked><input id="rp_th" type="checkbox" checked>' +
  '<input id="rp_fr" type="checkbox" checked><input id="rp_sa" type="checkbox" checked>' +
  '<input id="rp_su" type="checkbox" checked><div id="info"></div></body></html>';

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

  async function withReportPage(run, timezoneId = 'UTC') {
    return withPage(origin, async ({page}) => {
      await page.goto(origin);
      await page.addScriptTag({url: origin + '/bundle.js'});
      await page.addScriptTag({url: origin + '/page.js'});
      await page.addScriptTag({url: origin + '/modules.js'});
      await run(page);
    }, {timezoneId});
  }

  async function withReport(offsets, units, values, endDay, run, {day = DAY, base = BASE, timezone = 'UTC', dayHours = 24, charts = false, pentagon = false} = {}) {
    entries = offsets.map((seconds, index) => ({type: 'sgv', date: base + seconds * 1000, sgv: values[index], device: 'report-test'})).reverse();
    requests = [];
    await withReportPage(async page => {
      await page.evaluate(({units, day, endDay, timezone, charts, pentagon}) => {
        const $ = window.$, moment = window.moment, Nightscout = window.Nightscout;
        const ctx = {moment, settings: {units}, language: {translate: value => value}};
        const client = {
          ctx, settings: {units, scaleY: 'linear', thresholds: {bgTargetBottom: 80, bgTargetTop: 180}},
          careportal: {events: []}, headers: () => ({}), init: callback => callback(),
          translate: ctx.language.translate, utils: window.NightscoutTestModules.utils(ctx),
          sbx: {data: {profile: {getTimezone: () => timezone, parseInTimezone: value => moment.tz(value, timezone), applyTimezone: value => value.tz(timezone)}}},
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
        function tooltipLines(element) {
          const copy = element.cloneNode(true);
          copy.querySelectorAll('br').forEach(br => br.replaceWith(document.createTextNode('\n')));
          return copy.textContent.split('\n');
        }
        let pies = {}, chartSeries = {}, percentileTooltip = [];
        const registry = Nightscout.report_plugins_preinit;
        Nightscout.client = client;
        Nightscout.report_plugins_preinit = context => {
          const plugins = registry(context), daily = plugins('dailystats');
          // Preserve the real registry and report HTML; focus rendering on Daily Stats.
          plugins.eachPlugin = callback => callback({...daily, report(storage, days, options) {
            daily.report(storage, days, options);
            if (charts) {
              $('#owned-statistics-charts').remove();
              const container = $('<div id="owned-statistics-charts" style="width:1000px">').appendTo('body');
              for (const name of ['percentile', 'hourlystats']) {
                const plugin = plugins(name);
                container.append(plugin.html(client));
                container.find('#percentile-chart, #hourlystats-overviewchart').css({height: '500px', width: '1000px'});
                plugin.report(storage, days, options);
                if (name === 'percentile') {
                  chartSeries['#percentile-chart'] = Array.from(document.querySelectorAll('#percentile-chart path'))
                    .map(path => path.__data__).filter(Array.isArray).map(points => points.map(point => ({...point})));
                  const hover = document.querySelector('#percentile-chart svg > g > rect:last-child');
                  const bounds = hover.getBoundingClientRect();
                  hover.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: bounds.left + 1, clientY: bounds.top + 1}));
                  percentileTooltip = tooltipLines(document.querySelector('#percentile-tooltip'));

                } else {
                  chartSeries['#hourlystats-overviewchart'] = Array.from(document.querySelectorAll('.hs-box')).map(box => {
                    box.querySelector('rect:last-child').dispatchEvent(new MouseEvent('mouseover', {bubbles: true}));
                    const tooltip = document.querySelector('.hourlystats-tooltip:last-child');
                    return tooltipLines(tooltip);
                  });
                }

              }
            }
            let pentagonResult = null;
            if (pentagon) {
              $('#owned-pentagon').remove();
              const container = $('<div id="owned-pentagon">').appendTo('body');
              const distribution = plugins('glucosedistribution');
              container.append(distribution.html(client));
              distribution.report(storage, days, options);
              pentagonResult = {
                score: container.find('.gd-pentagon-score').text(),
                coverage: container.find('.gd-pentagon-coverage').text(),
                message: container.find('.gd-pentagon-message').text(),
                values: container.find('.gd-pentagon-values dd').toArray().map(node => node.textContent)
              };
            }
            pies = Object.fromEntries(Array.from(document.querySelectorAll('#dailystats-report .tir-bar')).map(bar => {
              const day = days[Array.from(document.querySelectorAll('#dailystats-report > table > tr, #dailystats-report > table > tbody > tr')).indexOf(bar.closest('tr')) - 1];
              return [day, Array.from(bar.children, (segment, index) => ({label: ['Low', 'In Range', 'High'][index], data: parseFloat(segment.style.width)}))];
            }));
            // Only inspect the report table's
            // own rows, preserving the original statistics assertions.
            const table = document.querySelector('#dailystats-report > table');
            const headers = Array.from(table.rows[0].cells, cell => cell.textContent);
            const rows = Array.from(table.rows).slice(1)
              .map(row => Array.from(row.children, cell => cell.textContent));
            window.reportResult = JSON.parse(JSON.stringify({
              data: storage[day], pentagon: pentagonResult, table: Object.fromEntries(headers.map((name, index) => [name, rows[0][index]])),
              pie: pies[day], rows, days: days.slice(), pies, chartSeries, percentileTooltip,
              percentilePaths: Array.from(document.querySelectorAll('#percentile-chart path'))
                .filter(path => Array.isArray(path.__data__)).map(path => path.getAttribute('d')),
              hourlyRows: charts ? Array.from(document.querySelector('#hourlystats-report table').rows).slice(1)
                .map(row => Array.from(row.cells, cell => cell.textContent)) : [],
              statisticsSVGs: document.querySelectorAll('#owned-statistics-charts svg').length,
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
      }, {units, day, endDay, timezone, charts, pentagon});
      await page.waitForFunction(() => window.$.active === 0);
      assert.equal(requests.filter(request => request.url.pathname === '/api/v1/entries.json').length, 0, 'Changing the initial range cancels the default week load');
      async function show() {
        await page.evaluate(() => window.resetReportResult());
        await page.locator('#rp_show').click();
        await page.waitForFunction(() => window.reportResult && window.$.active === 0);
        const result = await page.evaluate(() => window.reportResult);
        assert.equal(result.canvases, 0, 'Daily Stats uses native TIR bars');
        assert.ok(Object.values(result.pies).every(bands => bands.length === 3), 'Each populated day has a real three-band TIR bar');
        const cgmRequests = requests.filter(request => request.url.pathname === '/api/v1/entries.json');
        for (const request of requests) assert.equal(request.method, 'GET');
        for (const {url} of cgmRequests) {
          const from = Number(url.searchParams.get('find[date][$gte]'));
          const to = Number(url.searchParams.get('find[date][$lt]'));
          assert.ok(from >= base && from <= (endDay === day ? base : Date.parse(endDay + 'T00:00:00.000Z')));
          assert.equal(to - from, dayHours * 60 * 60 * 1000);
          assert.equal(url.searchParams.get('count'), '10000');
        }
        return {...result, entriesRequests: cgmRequests.length, showAgain: show};
      }
      await run(await show());
    }, timezone);
  }

  it('uses original 59-second CGM samples in the pentagon while preserving existing report filtering', async function () {
    const offsets = Array.from({length: Math.ceil(DAY_SECONDS / 59)}, (_, i) => i * 59);
    const values = offsets.map((_, i) => i % 2 ? 71 : 69);
    await withReport(offsets, 'mg/dl', values, DAY, async result => {
      assert.equal(result.entriesRequests, 1);
      assert.equal(result.data.statsrecords.length, 733, 'Existing reports keep their one-minute filter');
      assert.equal(result.data.pentagonrecords.length, 1465, 'Pentagon receives all original samples');
      assert.match(result.pentagon.coverage, /100\.0%/);
      assert.equal(result.pentagon.score, 'PGR: 1.32');
      assert.equal(result.pentagon.values[0], '720 min/day');
      assert.equal(result.pentagon.values[4], '70 mg/dL');
    }, {pentagon: true});
  });

  it('withholds the pentagon when the loaded data contain conflicting simultaneous readings', async function () {
    const offsets = Array.from({length: 288}, (_, i) => i * 300);
    const values = offsets.map(() => 100);
    offsets.push(15000); values.push(200);
    await withReport(offsets, 'mg/dl', values, DAY, async result => {
      assert.equal(result.data.pentagonrecords.length, 289);
      assert.equal(result.pentagon.score, '');
      assert.match(result.pentagon.coverage, /coverage is uncertain/);
      assert.match(result.pentagon.message, /Conflicting glucose readings/);
    }, {pentagon: true});
  });

  it('collapses exact duplicate uploads in the pentagon without changing other reports', async function () {
    const offsets = Array.from({length: 288}, (_, i) => [i * 300, i * 300]).flat();
    const values = offsets.map(() => 100);
    await withReport(offsets, 'mg/dl', values, DAY, async result => {
      assert.equal(result.data.statsrecords.length, 288);
      assert.equal(result.data.pentagonrecords.length, 576);
      assert.match(result.pentagon.coverage, /100\.0% · 288 readings/);
      assert.equal(result.pentagon.score, 'PGR: 1.00');
    }, {pentagon: true});
  });

  it('withholds the pentagon when near-duplicate uploads from one source are ambiguous', async function () {
    const offsets = Array.from({length: 288}, (_, i) => [i * 300, i * 300 + 30]).flat();
    const values = offsets.map(() => 100);
    await withReport(offsets, 'mg/dl', values, DAY, async result => {
      assert.equal(result.data.statsrecords.length, 288);
      assert.equal(result.data.pentagonrecords.length, 576);
      assert.equal(result.pentagon.score, '');
      assert.match(result.pentagon.coverage, /coverage is uncertain/);
      assert.match(result.pentagon.message, /overlapping uploads or missing data/);
    }, {pentagon: true});
  });

  ['mg/dl', 'mmol'].forEach(function (units) {
    it('preserves percentile values and hourly tables with D3 percentile whiskers (' + units + ')', async function () {
      await withReport([0, 300], units, [100, 200], DAY, async result => {
        const mmol = units === 'mmol';
        const [p90, p75, p50] = result.chartSeries['#percentile-chart'];
        assert.equal(p50.length, 48);
        assert.deepEqual(p50[0], {t: 15, v: mmol ? 8.35 : 150});
        assert.ok(p50.slice(1).every(point => point.v === null));
        assert.deepEqual(p75[0], {t: 15, v: mmol ? 11.1 : 200});
        assert.ok(p75.slice(1).every(point => point.v === null));
        assert.deepEqual(p90, p75);
        assert.deepEqual(result.percentileTooltip.slice(1), mmol
          ? ['75%: 11.1', 'Median: 8.3', '25%: 5.6', '10%: 5.6']
          : ['75%: 200', 'Median: 150', '25%: 100', '10%: 100']);
        assert.ok(result.percentileTooltip[0].endsWith(mmol ? '90%: 11.1' : '90%: 200'));

        assert.deepEqual(result.hourlyRows[0].slice(1), mmol
          ? ['2 (100%)', '8', '5.6', '5.6', '8.3', '11.1', '11.1', '2.7']
          : ['2 (100%)', '150', '100', '100.0', '150.0', '200.0', '200', '50']);
        const boxes = result.chartSeries['#hourlystats-overviewchart'];
        assert.equal(boxes.length, 1, 'Empty hours do not acquire boxes');
        assert.deepEqual(boxes[0], mmol
          ? ['0:00', 'Max: 11.1', '90%: 11.1', 'Quartile 75: 11.1', 'Median: 8.3', 'Quartile 25: 5.6', '10%: 5.6', 'Min: 5.6']
          : ['0:00', 'Max: 200.0', '90%: 200.0', 'Quartile 75: 200.0', 'Median: 150.0', 'Quartile 25: 100.0', '10%: 100.0', 'Min: 100.0']);
        assert.equal(result.statisticsSVGs, 2);
        const again = await result.showAgain();
        assert.deepEqual(again.chartSeries, result.chartSeries);
        assert.deepEqual(again.hourlyRows, result.hourlyRows);
        assert.equal(again.entriesRequests, 1);
      }, {charts: true});
    });

    it('keeps twelve-hour holes visible in the percentile lines and bands (' + units + ')', async function () {
      await withReport([0, 12 * 3600], units, [100, 200], DAY, async result => {
        assert.equal(result.percentilePaths.length, 3);
        result.percentilePaths.forEach(path => assert.equal((path.match(/M/g) || []).length, 2));
        const medians = result.chartSeries['#percentile-chart'][2];
        assert.ok(medians.slice(1, 24).every(point => point.v === null));
      }, {charts: true});
    });

    [
      { name: 'dense', offsets: [0, 58, 116], kept: [0, 116], bands: ['0%', '50%', '50%'], pie: [0, 50, 50] },
      { name: 'five-minute', offsets: [0, 300, 600], kept: [0, 300, 600], bands: ['33%', '33%', '33%'], pie: [33, 33, 33] }
    ].forEach(function (fixture) {
      it('uses the retained ' + fixture.name + ' readings in charts and statistics (' + units + ')', async function () {
        await withReport(fixture.offsets, units, [100, 50, 200], DAY, async result => {
          const expectedValues = units === 'mg/dl' ? [100, 50, 200] : [5.6, 2.8, 11.1];
          const expectedStats = fixture.name === 'dense' ? [expectedValues[0], expectedValues[2]] : expectedValues;
          assert.equal(result.entriesRequests, 1);
          assert.deepEqual(result.data.sgv.filter(entry => entry.type === 'sgv')
            .map(entry => (entry.mills - BASE) / 1000), fixture.kept);
          assert.deepEqual(result.data.statsrecords.map(entry => entry.sgv), expectedStats);
          assert.ok(result.data.statsrecords.every(entry => entry.device === 'report-test'), 'SGV source is preserved for coverage');
          assert.equal(result.table.Readings, String(fixture.kept.length));
          const quartiles = units === 'mg/dl'
            ? (fixture.name === 'dense' ? ['100.0', '150.0', '200.0'] : ['50.0', '100.0', '200.0'])
            : (fixture.name === 'dense' ? ['5.6', '8.3', '11.1'] : ['2.8', '5.6', '11.1']);
          assert.deepEqual([result.table['25%'], result.table.Median, result.table['75%']], quartiles);
          assert.deepEqual([result.table.Low, result.table.Normal, result.table.High], fixture.bands);
          assert.deepEqual(result.pie.map(band => band.label), ['Low', 'In Range', 'High']);
          assert.deepEqual(result.pie.map(band => band.data), fixture.pie);
          assert.equal(result.table['A1c est* %DCCT'], fixture.name === 'dense' ? '6.9%' : '5.7%');
          assert.equal(result.table['A1c est* IFCC'], fixture.name === 'dense' ? '51' : '39');
        });
      });
    });

    for (const fixture of [
      {day: '2025-03-09', base: Date.parse('2025-03-09T05:00:00Z'), dayHours: 23, offsets: [0, 7200, 82500, 82800]},
      {day: '2025-11-02', base: Date.parse('2025-11-02T04:00:00Z'), dayHours: 25, offsets: [3600, 7200, 89700, 90000]}
    ]) {
      it('retains quartiles across the ' + fixture.dayHours + '-hour DST day (' + units + ')', async function () {
        await withReport(fixture.offsets, units, [100, 200, 300, 999], fixture.day, async result => {
          assert.deepEqual(result.days, [fixture.day]);
          assert.equal(result.table.Readings, '3');
          const bounds = result.data.sgv.filter(record => record.type === 'rawbg' && record.color === 'transparent')
            .map(record => record.date).sort();
          assert.deepEqual(bounds, [new Date(fixture.base).toISOString(),
            new Date(fixture.base + fixture.dayHours * 3600000).toISOString()]);
          assert.deepEqual([result.table['25%'], result.table.Median, result.table['75%']],
            units === 'mg/dl' ? ['100.0', '200.0', '300.0'] : ['5.6', '11.1', '16.7']);
          assert.deepEqual(result.stats[0].map(record => record.bgValue), [100, 200, 300]);
          const mmol = units === 'mmol';
          const medians = result.chartSeries['#percentile-chart'][2];
          const expected = fixture.dayHours === 23
            ? {0: mmol ? 5.6 : 100, 6: mmol ? 11.1 : 200, 47: mmol ? 16.7 : 300}
            : {2: mmol ? 8.35 : 150, 47: mmol ? 16.7 : 300};
          assert.equal(medians.length, 48);
          medians.forEach(point => assert.equal(point.v, expected[(point.t - 15) / 30] ?? null));
          const counts = result.hourlyRows.map(row => Number(row[1].split(' ')[0]));
          assert.deepEqual(counts, Array.from({length: 24}, (_, hour) =>
            fixture.dayHours === 23 ? ([0, 3, 23].includes(hour) ? 1 : 0) : (hour === 1 ? 2 : hour === 23 ? 1 : 0)));
          assert.equal(result.statisticsSVGs, 2);
          const repeated = await result.showAgain();
          assert.equal(repeated.entriesRequests, 1);
          assert.deepEqual(repeated.rows, result.rows);
          assert.deepEqual(repeated.chartSeries, result.chartSeries);
          assert.deepEqual(repeated.hourlyRows, result.hourlyRows);
        }, {...fixture, timezone: 'America/New_York', charts: true});
      });
    }

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

  describe('automatic initial report', function () {
    async function initialPage(run) {
      requests = [];
      entries = Array.from({length: 7}, (_, index) => ({type: 'sgv', date: Date.UTC(2025, 0, 27 + index, 20), sgv: 120 + index}));
      await withReportPage(async page => {
        // UTC is already Feb 3, while the profile is still on Feb 2.
        await page.clock.setFixedTime(new Date('2025-02-03T02:00:00Z'));
        await page.evaluate(() => {
          const moment = window.moment, ns = window.Nightscout;
          const ctx = {moment, settings: {units: 'mg/dl'}, language: {translate: value => value}};
          const profile = {data: null, parseInTimezone: value => moment.tz(value, 'America/Los_Angeles'),
            applyTimezone: value => value.tz('America/Los_Angeles')};
          const client = {ctx, settings: {units: 'mg/dl', theme: 'modern', scaleY: 'linear', thresholds: {bgTargetBottom: 80, bgTargetTop: 180}},
            careportal: {events: []}, headers: () => ({}), translate: ctx.language.translate,
            utils: window.NightscoutTestModules.utils(ctx), sbx: {data: {profile}}, profilefunctions: {data: [{}]},
            dataLastUpdated: 1, ddata: {processDurations: value => value},
            init(callback) {window.authorizeInitialReport = callback; callback();}};
          const registry = ns.report_plugins_preinit;
          ns.client = client;
          window.initialRenderCount = 0;
          ns.report_plugins_preinit = context => {
            const plugins = registry(context), agp = plugins('agp');
            plugins.eachPlugin = callback => callback({...agp, report(storage, days, options) {
              agp.report(storage, days, options);
              window.initialRenderCount++;
              window.initialReportDays = days.slice();
            }});
            return plugins;
          };
          window.releaseInitialProfile = () => {profile.data = [{}];};
          ns.reportclient();
        });
        await page.waitForFunction(() => window.$.active === 0);
        assert.equal(requests.filter(request => request.url.pathname === '/api/v1/entries.json').length, 0,
          'Wait for a populated profile snapshot rather than using the viewer timezone');
        await run(page);
      });
    }

    it('loads seven profile-calendar days without Show and leaves the range alone on reconnect', async function () {
      await initialPage(async page => {
        await page.evaluate(() => window.releaseInitialProfile());
        await page.waitForFunction(() => window.initialRenderCount === 1 && window.$.active === 0);
        assert.equal(await page.locator('#rp_from').inputValue(), '2025-01-27');
        assert.equal(await page.locator('#rp_to').inputValue(), '2025-02-02');
        assert.equal((await page.evaluate(() => window.initialReportDays)).length, 7);
        assert.equal(requests.filter(request => request.url.pathname === '/api/v1/entries.json').length, 7);
        assert.equal(await page.locator('#agp-chart svg').count(), 1);
        await page.locator('#rp_from').fill('2025-02-01');
        const before = requests.length;
        await page.evaluate(() => {window.authorizeInitialReport(); window.authorizeInitialReport();});
        await page.waitForFunction(() => window.$.active === 0);
        assert.equal(await page.locator('#rp_from').inputValue(), '2025-02-01');
        assert.equal(await page.evaluate(() => window.initialRenderCount), 1);
        assert.equal(requests.length, before);
      });
    });

    it('does not overwrite a range edited while the initial profile is loading', async function () {
      await initialPage(async page => {
        await page.locator('#rp_from').fill('2025-02-01');
        await page.evaluate(() => {
          window.releaseInitialProfile();
          window.setTimeout(() => {window.initialProfileSettled = true;}, 350);
        });
        await page.waitForFunction(() => window.initialProfileSettled);
        assert.equal(await page.locator('#rp_from').inputValue(), '2025-02-01');
        assert.equal(requests.filter(request => request.url.pathname === '/api/v1/entries.json').length, 0);
        await page.locator('#rp_show').click();
        await page.waitForFunction(() => window.initialRenderCount === 1 && window.$.active === 0);
        assert.equal((await page.evaluate(() => window.initialReportDays)).length, 3);
      });
    });
  });

  describe('report page reconnect initialization', function () {
    for (const theme of ['default', 'modern']) {
      it('builds and wires the ' + theme + ' report GUI only for the first authorized connection', async function () {
        requests = [];
        await withReportPage(async page => {
          await page.evaluate(theme => {
            const $ = window.$, moment = window.moment, Nightscout = window.Nightscout;
            const ctx = {moment, settings: {units: 'mg/dl'}, language: {translate: value => value}};
            let authorized, addHtmlCalls = 0;
            const client = {
              ctx, careportal: {events: []}, headers: () => ({}), init: callback => { authorized = callback; },
              settings: {theme, scaleY: 'linear', units: 'mg/dl', thresholds: {bgTargetBottom: 80, bgTargetTop: 180}},
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
              styles: $('style[id$="-css"]').length,
              pressed: $('#tabnav > li.selected').attr('aria-pressed')
            });
            authorized();
          }, theme);
          await page.waitForFunction(() => window.$.active === 0);
          const first = await page.evaluate(() => window.reportGuiState());
          assert.equal(first.addHtmlCalls, 1);
          assert.equal(first.handlers, 1);
          assert.ok(first.menu > 1);
          await page.locator('#rp_from').fill(DAY);
          await page.locator('#tabnav > li').nth(1).click();
          const chosen = await page.evaluate(() => window.reportGuiState());
          assert.notEqual(chosen.selected, first.selected);
          if (theme === 'modern') assert.equal(chosen.pressed, 'true');
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
    }

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
