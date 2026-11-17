'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const express = require('express');
const ejs = require('ejs');
const {withPage} = require('./fixture');
const fixtures = require('./legacy-report-data.json');
const networkDiagnostics = new WeakMap();

function queryKey(value) {
  const url = new URL(value, 'http://127.0.0.1');
  url.searchParams.delete('_');
  url.searchParams.sort();
  return url.pathname + '?' + url.searchParams.toString();
}

describe('legacy reports in a real browser', function () {
  let server, origin, markup, requests, responses, reportProfile;
  before(async function () {
    const root = process.env.NIGHTSCOUT_REPORT_REFERENCE_ROOT || path.resolve(__dirname, '../..');
    const file = path.join(root, 'views/reportindex.html');
    markup = ejs.render(fs.readFileSync(file, 'utf8'), {type: 'reports', title: '', bundle: '/bundle', settings: require('../fixtures/default-server-settings').settings}, {filename: file});
    const cssNames = ['main', 'drawer', 'report', 'dropdown', 'ui-lightness/jquery-ui.min'];
    const css = new Map(cssNames.map(name => ['/css/' + name + '.css', fs.readFileSync(path.join(root, 'static/css', name + '.css'), 'utf8')
      .split('\n').filter(line => ![
        "@import url('https://fonts.googleapis.com/css?family=Ubuntu:400,700');",
        '@import url("//fonts.googleapis.com/css?family=Ubuntu:300,400,500,700,300italic,400italic,500italic,700italic");',
        '@import url("//fonts.googleapis.com/css?family=Open+Sans:300italic,400italic,600italic,700italic,300,400,600,700,800");'
      ].includes(line)).join('\n')]));
    const html = '<!doctype html><html><head><meta charset="utf-8">' + cssNames.map(name => '<link rel="stylesheet" href="/css/' + name + '.css">').join('') + '</head><body></body></html>';
    responses = new Map(Object.entries(fixtures.someData).map(([url, data]) => [queryKey(url), data]));
    const reportSettings = structuredClone(fixtures.exampleProfile[0]);
    delete reportSettings.startDate;
    reportProfile = {startDate: '2015-01-01T00:00:00.000Z', defaultProfile: 'Default', store: {Default: reportSettings}};
    const settings = structuredClone(require('../fixtures/default-server-settings'));
    const app = express();
    app.use(express.json()); app.use(express.urlencoded({extended: true}));
    app.get('/', (request, response) => response.type('html').send(html));
    app.use((request, response, next) => {
      if (request.path.startsWith('/api/') || request.path.startsWith('/translations/')) {
        const record = {method: request.method, url: request.originalUrl, body: request.body, finished: false};
        requests.push(record);
        response.once('finish', () => {record.finished = true;});
      }
      next();
    });
    app.get('/api/v1/status.json', (request, response) => response.json(settings));
    app.get('/api/v1/verifyauth', (request, response) => response.json({message: 'OK'}));
    app.get('/api/v1/adminnotifies', (request, response) => response.json({message: {notifies: [], notifyCount: 0}}));
    app.get('/translations/{*path}', (request, response) => response.json({}));
    app.get('/api/v1/profiles', (request, response) => {
      const params = new URL(request.originalUrl, 'http://127.0.0.1').searchParams;
      const at = Date.parse(reportProfile.startDate);
      const matches = [['$gt', (a, b) => a > b], ['$gte', (a, b) => a >= b],
        ['$lt', (a, b) => a < b], ['$lte', (a, b) => a <= b]].every(([operator, compare]) => {
        const value = params.get('find[startDate][' + operator + ']');
        return value === null || compare(at, Date.parse(value));
      });
      response.json(matches ? [reportProfile] : []);
    });
    app.get(['/api/v1/entries.json', '/api/v1/treatments.json', '/api/v1/food/regular.json', '/api/v1/devicestatus.json'],
      (request, response) => response.json(responses.get(queryKey(request.originalUrl)) || []));
    app.delete('/api/v1/treatments/:id', (request, response) => response.json({message: 'OK'}));
    app.put('/api/v1/treatments/', (request, response) => response.json({message: 'OK'}));
    for (const [url, content] of css) app.get(url, (request, response) => response.type('css').send(content));
    app.use('/bundle', express.static(path.join(root, 'node_modules/.cache/_ns_cache/public')));
    app.use(express.static(path.join(root, 'static')));
    server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {if (server) await new Promise(resolve => server.close(resolve));});

  async function withReports(run) {
    requests = [];
    await withPage(origin, async ({page, routed}) => {
      const pending = new Map(), failures = [], consoleErrors = [];
      page.on('console', message => {if (message.type() === 'error') consoleErrors.push(message.text());});
      networkDiagnostics.set(page, {pending, failures, routed, consoleErrors});
      page.on('request', request => pending.set(request, Date.now()));
      page.on('requestfinished', request => pending.delete(request));
      page.on('requestfailed', request => {
        pending.delete(request);
        failures.push({path: new URL(request.url()).pathname, error: request.failure()});
      });
      await page.clock.setFixedTime(new Date('2025-01-01T12:00:00Z'));
      await page.goto(origin);
      await page.evaluate(markup => {
        const parsed = new DOMParser().parseFromString(markup, 'text/html');
        parsed.querySelectorAll('script').forEach(script => script.remove());
        parsed.querySelectorAll('audio').forEach(audio => {audio.preload = 'none';});
        document.body.replaceChildren(...parsed.body.childNodes);
      }, markup);
      await page.addScriptTag({url: origin + '/bundle/js/bundle.app.js'});
      await page.addScriptTag({url: origin + '/bundle/js/bundle.reports.js'});
      await page.addScriptTag({url: origin + '/report/js/flotcandle.js'});
      await page.addScriptTag({url: origin + '/report/js/loopalyzer.js'});
      await page.evaluate(() => {
        window.reportFixture = {emitted: [], failures: [], errors: [], completed: 0};
        window.$(document).on('ajaxComplete.reportFixture', () => window.reportFixture.completed++);
        window.addEventListener('error', event => window.reportFixture.errors.push(event.message));
        window.$.ajaxPrefilter((options, original, xhr) => xhr.fail((response, status) => {
          window.reportFixture.failures.push({url: options.url, status, httpStatus: response.status});
        }));
        window.io = {connect() {
          const socket = {
            on(event, callback) {if (event === 'connect') queueMicrotask(callback); return socket;},
            emit(event, data, callback) {
              window.reportFixture.emitted.push({event, data});
              if (callback) callback({read: true});
              return socket;
            }
          }; return socket;
        }};
        window.Nightscout.reportclient();
      });
      await page.waitForFunction(() => window.Nightscout.report_plugins && window.$.active === 0 && window.Nightscout.client.hashauth.isAuthenticated());
      await page.evaluate(profile => {
        const client = window.Nightscout.client;
        client.dataUpdate({sgvs: [{mgdl: 100, mills: Date.now(), direction: 'Flat', type: 'sgv'}], treatments: []});
        profile[0].startDate = new Date(profile[0].startDate);
        client.sbx.data.profile.loadData(profile);
      }, fixtures.exampleProfile);
      await page.locator('a.presetdates').first().click();
      assert.equal(await page.locator('#rp_from').inputValue(), '2025-01-01');
      await page.locator('#rp_from').fill('2015-08-08');
      await page.locator('#rp_to').fill('2015-09-07');
      assert.equal(requests.filter(r => new URL(r.url, origin).pathname === '/api/v1/status.json').length, 1);
      assert.equal(requests.filter(r => new URL(r.url, origin).pathname === '/api/v1/verifyauth').length, 1);
      assert.equal(await page.locator('#tabnav .menutab').count(), 12);
      await run(page);
    }, {timezoneId: 'UTC'});
  }

  async function show(page) {
    await page.locator('#rp_show').click();
    await idle(page);
  }

  async function idle(page) {
    const started = Date.now();
    try {
      // A month requires many batches of real HTTP requests. Bound total work
      // separately from a stalled request: completed AJAX calls prove progress.
      await page.evaluate(() => {
        window.reportFixture.progress = {completed: window.reportFixture.completed, at: performance.now()};
      });
      const result = await page.waitForFunction(() => {
        if (window.$.active === 0 && window.$('#rp_show').is(':visible') && window.$('#info').text() === '') return 'ready';
        const state = window.reportFixture, progress = state.progress;
        if (state.completed !== progress.completed) {
          progress.completed = state.completed;
          progress.at = performance.now();
        }
        return performance.now() - progress.at >= 15000 ? 'stalled' : false;
      }, null, {timeout: 60000});
      try {assert.equal(await result.jsonValue(), 'ready', 'Report made no HTTP completion progress for 15 seconds');}
      finally {await result.dispose();}
    } catch (error) {
      const state = await page.evaluate(() => ({active: window.$.active, info: window.$('#info').text(),
        showVisible: window.$('#rp_show').is(':visible'), errors: window.reportFixture.errors,
        failures: window.reportFixture.failures.slice(-5), completed: window.reportFixture.completed,
        stalledForMs: performance.now() - window.reportFixture.progress.at}));
      error.message += '\nReport state: ' + JSON.stringify(state);
      const network = networkDiagnostics.get(page);
      error.message += '\nHTTP state: ' + JSON.stringify({
        pending: Array.from(network.pending, ([request, at]) => ({path: new URL(request.url()).pathname,
          elapsedMs: Date.now() - at})),
        failures: network.failures.slice(-10),
        consoleErrors: network.consoleErrors.slice(-10),
        routed: Array.from(network.routed.values(), state => ({...state, elapsedMs: Date.now() - state.since})),
        received: requests.length,
        unfinished: requests.filter(request => !request.finished).map(request => new URL(request.url, origin).pathname)
      });
      throw error;
    }
    console.log('Report idle after', Date.now() - started, 'ms');
  }

  it('should produce some html', async function () {
    this.timeout(90000);
    await withReports(async page => {
      await page.locator('#daytoday').click();
      await page.locator('#rp_optionsnotes').check();
      await page.locator('#rp_optionscarbs').check();
      await page.locator('#rp_notes').fill('something');
      await page.locator('#rp_eventtype').selectOption('BG Check');
      for (const id of ['rp_optionsraw', 'rp_optionsiob', 'rp_optionscob', 'rp_enableeventtype', 'rp_enablenotes', 'rp_optionsopenaps']) await page.locator('#' + id).check();
      await page.locator('#rp_enablefood').check(); await page.locator('#rp_enablefood').uncheck();
      await page.addStyleTag({url: origin + '/css/modern-reports.css'});
      for (const theme of ['default', 'modern']) {
        await page.evaluate(theme => {
          window.Nightscout.client.settings.theme = theme;
          document.documentElement.classList.toggle('modern-ui', theme === 'modern');
          document.body.classList.add('report-page');
        }, theme);
        for (const scale of ['rp_log', 'rp_linear']) {
          await page.locator('#' + scale).check(); await show(page);
          const text = await page.locator('#daytoday-placeholder').textContent();
          assert.ok(text.includes('Milk now')); assert.ok(text.includes('50 g'));
          assert.ok(text.includes('TDD average: 2.9U'));
          const sample = page.locator('.daytoday-glucose-sample').first();
          const glucose = await sample.evaluate(node => Math.round(node.__data__.sgv));
          await sample.hover();
          assert.equal(await page.locator('.daily-tooltip-glucose strong').textContent(), glucose + ' mg/dL');
          assert.equal(await page.locator('.daytoday-reading-tooltip').isVisible(), true);
          const hoverPosition = await sample.evaluate(node => {
            const svg = node.ownerSVGElement, bounds = svg.getBoundingClientRect();
            const point = new DOMPoint(Number(node.getAttribute('cx')), 60).matrixTransform(svg.getScreenCTM());
            return {x: point.x - bounds.x, y: point.y - bounds.y};
          });
          const svg = page.locator('#daytodaycharts svg:has(.daytoday-glucose-sample)').first();
          await svg.hover({position: hoverPosition});
          const tooltipTop = await page.locator('.daytoday-reading-tooltip').evaluate(node => node.getBoundingClientRect().top);
          await svg.hover({position: {x: hoverPosition.x, y: hoverPosition.y + 50}});
          const tooltipAfter = await page.locator('.daytoday-reading-tooltip').evaluate(node => ({top: node.getBoundingClientRect().top, styleTop: node.style.top, scrollY: window.scrollY}));
          assert.ok(Math.abs(tooltipAfter.top - tooltipTop) < 1, JSON.stringify({theme, scale, tooltipTop, tooltipAfter, hoverPosition}));
          assert.equal(await page.locator('.daily-tooltip-glucose strong').textContent(), glucose + ' mg/dL');
          assert.equal(await svg.locator('.daytoday-glucose-focus').isVisible(), true);
          assert.ok((await page.locator('.daily-tooltip-basal').textContent()).includes('U/h'));
          if (theme === 'modern') {
            assert.ok(await page.locator('.daily-basal-axis').count());
            assert.ok(await page.locator('.daily-treatment-carbs').count());
            assert.ok(await page.locator('.daily-treatment-bolus').count());
            assert.ok((await page.locator('.daily-chart-legend').first().textContent()).includes('Basal (U/h)'));
            const bolus = page.locator('.daily-treatment-bolus').first();
            const dose = await bolus.locator('text').textContent();
            const markerMeta = await bolus.evaluate(node => ({time: new Date(node.__data__.mills).toISOString(), title: node.querySelector('title').textContent}));
            await bolus.locator('circle').hover();
            const observed = await page.evaluate(() => ({text: document.querySelector('.daytoday-reading-tooltip')?.textContent, selected: document.querySelectorAll('.daily-treatment.is-selected').length}));
            assert.ok(observed.text?.includes(dose), JSON.stringify({dose, markerMeta, observed}));
            assert.ok((await bolus.getAttribute('class')).includes('is-selected'));
          }
          await page.locator('#daytoday-placeholder h2').hover();
          assert.equal(await page.locator('.daytoday-reading-tooltip').isVisible(), false);
        }
      }
      await page.locator('#treatments').click(); await show(page);
      const cells = await page.locator('#treatments-report tr.border_bottom').evaluateAll(rows => rows.map(row => Array.from(row.cells, cell => cell.textContent)));
      assert.ok(cells.some(row => row[1] === 'Correction Bolus' && row[2] === '250' && row[3] === '0.75'));
      const firstDetails = page.locator('.treatment-detail-toggle').first();
      await firstDetails.click();
      assert.equal(await firstDetails.getAttribute('aria-expanded'), 'true');
      assert.ok((await page.locator('.treatment-detail-row').first().textContent()).includes('Finger'));
      await firstDetails.click();
      assert.equal(await page.locator('.treatment-detail-row').first().isVisible(), false);
      for (let cycle = 1; cycle <= 2; cycle++) {
        const deletesBefore = requests.filter(r => r.method === 'DELETE').length;
        const confirmation = page.waitForEvent('dialog').then(async dialog => {
          assert.equal(dialog.type(), 'confirm'); assert.ok(dialog.message().includes('Delete this treatment?'));
          await dialog.dismiss();
        });
        await page.locator('.treatment-menu > summary').first().click();
        await page.locator('.deleteTreatment').first().click(); await confirmation;
        assert.equal(requests.filter(r => r.method === 'DELETE').length, deletesBefore);
        const accepted = page.waitForEvent('dialog').then(async dialog => {
          assert.equal(dialog.type(), 'confirm'); assert.ok(dialog.message().includes('Meal Bolus'));
          await dialog.accept();
        });
        await page.locator('.treatment-menu > summary').first().click();
        await page.locator('.deleteTreatment').first().click(); await accepted;
        await idle(page);
        assert.equal(requests.filter(r => r.method === 'DELETE').length, deletesBefore + 1);
        assert.equal(requests.filter(r => r.method === 'DELETE').at(-1).url, '/api/v1/treatments/55ce59bb925aa80e7071e5ba');
        for (const dismiss of ['cancel', 'escape']) {
          await page.locator('.editTreatment').first().click();
          await page.locator('#rp_edittreatmentdialog').waitFor({state: 'visible'});
          assert.equal(await page.evaluate(() => document.activeElement.id), 'rped_eventType');
          const originalNotes = await page.locator('#rped_adnotes').inputValue();
          await page.locator('#rped_adnotes').fill('Discard this treatment draft');
          if (dismiss === 'cancel') await page.getByRole('dialog').getByRole('button', {name: 'Cancel', exact: true}).click();
          else await page.keyboard.press('Escape');
          await page.locator('#rp_edittreatmentdialog').waitFor({state: 'hidden'});
          assert.equal(requests.filter(r => r.method === 'PUT').length, cycle - 1, 'Dismissal sends no treatment update');
          await page.locator('.editTreatment').first().click();
          assert.equal(await page.locator('#rped_adnotes').inputValue(), originalNotes, 'Reopen restores the saved treatment');
          await page.keyboard.press('Escape');
          await page.locator('#rp_edittreatmentdialog').waitFor({state: 'hidden'});
        }
        await page.locator('.editTreatment').first().click();
        assert.equal(await page.locator('#rped_eventType').inputValue(), 'Meal Bolus');
        assert.equal(await page.locator('#rped_carbsGiven').inputValue(), '54');
        assert.equal(await page.locator('#rped_insulinGiven').inputValue(), '3.15');
        await page.locator('#rped_adnotes').fill('Report edit cycle ' + cycle);
        await page.getByRole('button', {name: 'Save', exact: true}).click();
        await idle(page);
        const saved = requests.filter(r => r.method === 'PUT');
        assert.equal(saved.length, cycle);
        assert.equal(saved.at(-1).url, '/api/v1/treatments/');
        const body = saved.at(-1).body;
        assert.deepEqual({id: body._id, eventType: body.eventType, carbs: body.carbs, insulin: body.insulin,
          notes: body.notes, units: body.units, eventTime: body.eventTime},
        {id: '55ce59bb925aa80e7071e5ba', eventType: 'Meal Bolus', carbs: '54', insulin: '3.15',
          notes: 'Report edit cycle ' + cycle, units: 'mg/dl', eventTime: '2015-08-14T21:00:00.000Z'});
        assert.equal(Object.hasOwn(body, 'created_at'), false);
        assert.equal(Object.hasOwn(body, 'mills'), false);
      }
      await page.locator('#dailystats').click();
      const daily = await page.locator('#dailystats-report > table').evaluate(table => Array.from(table.rows).slice(1).map(row => Array.from(row.cells, cell => cell.textContent)));
      assert.ok(daily.some(row => row.slice(2, 6).join('|') === '0%|100%|0%|2'));
      // The raw hourly count is independent of the distribution report's
      // interpolation/cleaning.
      assert.equal(daily.length, 31);
      assert.equal(daily.filter(row => row[2] === 'No data available').length, 23);
      const populated = daily.filter(row => row.length === 15);
      assert.equal(populated.length, 8);
      assert.equal(populated.reduce((sum, row) => sum + Number(row[5]), 0), 16);
      const distribution = await page.locator('#glucosedistribution-report tr').evaluateAll(rows => rows.map(row => Array.from(row.cells, cell => cell.textContent)));
      // #8812 removed the duplicated first sample: ten of twenty are in range.
      assert.ok(distribution.some(row => row[0].trim() === 'In Range (70–180):' && row[1] === '50.0%' && row[2] === '10'), JSON.stringify(distribution));
      assert.equal(distribution.find(row => row[0].trim() === 'Overall:')[2], '20');
      const hourly = await page.locator('#hourlystats-report td').allTextContents();
      assert.ok(hourly.includes('16 (100%)'));
      assert.equal(await page.locator('#success-grid').count(), 1);
      assert.ok((await page.locator('#calibrations-placeholder').textContent()).includes('Calibration: Scale: 1.10 Intercept: 31102 Slope: 776.91'));

    });
  });

  for (const theme of ['default', 'modern']) {
    it('switches and remembers independent report chart styles in ' + theme, async function () {
      await withReports(async page => {
        await page.addStyleTag({url: origin + '/css/modern-reports.css'});
        async function renderCharts () {
          await page.evaluate(theme => {
            const client = window.Nightscout.client;
            client.settings.theme = theme;
            document.documentElement.classList.toggle('modern-ui', theme === 'modern');
            document.body.classList.add('report-page');
            const start = client.sbx.data.profile.parseInTimezone('2015-08-08').valueOf();
            const records = [60, 120, 120, 240].map((value, i) => ({
              sgv: value, bgValue: value, displayTime: new Date(start + i * 1800000)
            }));
            const data = {alldays: 2, allstatsrecords: records,
              '2015-08-08': {statsrecords: records}, '2015-08-09': {statsrecords: []}};
            for (const name of ['glucosedistribution', 'dailystats']) {
              const plugin = window.Nightscout.report_plugins(name);
              document.getElementById(name + '-placeholder').innerHTML = plugin.html(client);
              plugin.report(data, ['2015-08-09', '2015-08-08'], {targetLow: 70, targetHigh: 180});
            }
          }, theme);
        }
        await renderCharts();
        const requestCount = requests.length;
        const distributionStats = await page.locator('#glucosedistribution-report').textContent();
        const dailyStats = await page.locator('#dailystats-report tr').evaluateAll(rows =>
          rows.map(row => Array.from(row.cells).slice(1).map(cell => cell.textContent)));
        assert.equal(await page.locator('#glucosedistribution-chartstyle-bar').isChecked(), true);
        assert.equal(await page.locator('#dailystats-chartstyle-bar').isChecked(), true);
        await page.locator('#glucosedistribution').click();
        await page.locator('#glucosedistribution-chartstyle-bar').focus();
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.locator('#glucosedistribution-chartstyle-pie').isChecked(), true);
        const overview = page.locator('#glucosedistribution-overviewchart');
        assert.equal(await overview.locator('svg path').count(), 3);
        assert.equal(await overview.locator('.gd-vbar').count(), 0);
        assert.deepEqual(await overview.locator('path title').allTextContents(),
          ['Low (54–69): 25.0%', 'In Range (70–180): 50.0%', 'High (181–250): 25.0%']);
        assert.equal(await page.locator('#glucosedistribution-report').textContent(), distributionStats);
        assert.equal(await page.locator('#dailystats-chartstyle-bar').isChecked(), true);
        await page.locator('#glucosedistribution-rangemode-tight').check();
        assert.ok((await overview.locator('svg').getAttribute('aria-label')).includes('In Tight Range'));
        await page.locator('#glucosedistribution-0').uncheck();
        assert.equal(await overview.locator('svg path').count(), 2);
        const filteredStats = await page.locator('#glucosedistribution-report').textContent();
        await page.locator('#glucosedistribution-chartstyle-bar').check();
        assert.equal(await overview.locator('.gd-vbar').count(), 1);
        assert.equal(await page.locator('#glucosedistribution-report').textContent(), filteredStats);
        await page.locator('#glucosedistribution-chartstyle-pie').check();
        await page.locator('#glucosedistribution-1').uncheck();
        assert.equal(await overview.locator('svg, .gd-vbar').count(), 0, 'empty hour selections clear the chart');
        assert.equal(await page.locator('#glucosedistribution-days').textContent(), 'Result is empty');
        await page.locator('#glucosedistribution-chartstyle-bar').check();
        await page.locator('#glucosedistribution-chartstyle-pie').check();
        assert.equal(await overview.locator('svg, .gd-vbar').count(), 0);
        await page.locator('#glucosedistribution-0').check();
        await page.locator('#glucosedistribution-1').check();

        await page.locator('#dailystats').click();
        await page.locator('#dailystats-chartstyle-pie').check();
        assert.equal(await page.locator('.daily-stats-chart svg').count(), 1, 'empty days have no chart');
        assert.deepEqual(await page.locator('.daily-stats-chart path title').allTextContents(),
          ['Low: 25%', 'In Range: 50%', 'High: 25%']);
        assert.deepEqual(await page.locator('#dailystats-report tr').evaluateAll(rows =>
          rows.map(row => Array.from(row.cells).slice(1).map(cell => cell.textContent))), dailyStats);
        if (process.env.NIGHTSCOUT_REPORT_STYLE_SCREENSHOTS) {
          await page.locator('#dailystats-placeholder').screenshot({path: process.env.NIGHTSCOUT_REPORT_STYLE_SCREENSHOTS + '/' + theme + '-daily.png'});
        }
        await page.emulateMedia({media: 'print'});
        assert.equal(await page.locator('#dailystats-placeholder .report-chart-style').isVisible(), false);
        assert.equal(await page.locator('.daily-stats-chart svg').isVisible(), true);
        await page.emulateMedia({media: 'screen'});
        await page.locator('#dailystats-chartstyle-bar').check();
        assert.equal(await page.locator('.daily-stats-chart .tir-bar').count(), 1);
        assert.equal(await page.locator('#glucosedistribution-chartstyle-pie').isChecked(), true);
        assert.equal(requests.length, requestCount, 'chart switches use already loaded data');

        // Recreate report controls as on a fresh visit, reading browser preferences.
        await renderCharts();
        assert.equal(await page.locator('#glucosedistribution-chartstyle-pie').isChecked(), true);
        assert.equal(await page.locator('#dailystats-chartstyle-bar').isChecked(), true);
        assert.equal(await overview.locator('svg path').count(), 3);
        await page.locator('#glucosedistribution').click();
        if (process.env.NIGHTSCOUT_REPORT_STYLE_SCREENSHOTS) {
          await page.locator('#glucosedistribution-placeholder').screenshot({path: process.env.NIGHTSCOUT_REPORT_STYLE_SCREENSHOTS + '/' + theme + '-distribution.png'});
        }
        await page.setViewportSize({width: 375, height: 812});
        await page.locator('#glucosedistribution-chartstyle-pie').scrollIntoViewIfNeeded();
        const controls = await page.locator('#glucosedistribution-placeholder .report-chart-style').boundingBox();
        assert.ok(controls.width <= 375, 'chart controls fit a phone viewport');
        if (process.env.NIGHTSCOUT_REPORT_STYLE_SCREENSHOTS) {
          await page.locator('#glucosedistribution-placeholder').screenshot({path: process.env.NIGHTSCOUT_REPORT_STYLE_SCREENSHOTS + '/' + theme + '-phone.png'});
        }
        await page.emulateMedia({media: 'print'});
        assert.equal(await page.locator('#glucosedistribution-placeholder .report-chart-style').isVisible(), false);
        assert.equal(await overview.locator('svg').isVisible(), true);
        await page.emulateMedia({media: 'screen'});
        await page.reload();
        assert.deepEqual(await page.evaluate(() => [localStorage.getItem('reportChartStyle_glucosedistribution'),
          localStorage.getItem('reportChartStyle_dailystats')]), ['pie', 'bar']);
      });
    });
  }

  for (const theme of ['default', 'modern']) {
    it('explains Calibrations, matches either date order and fits narrow screens in ' + theme, async function () {
      await withReports(async page => {
        await page.addStyleTag({url: origin + '/css/modern-reports.css'});
        await page.locator('#calibrations').click();
        await page.evaluate(theme => {
          const client = window.Nightscout.client;
          client.settings.theme = theme;
          document.documentElement.classList.toggle('modern-ui', theme === 'modern');
          document.body.classList.add('report-page');
          const start = Date.parse('2015-08-08T10:00:00Z');
          const meter = (minutes, y) => ({mills: start + minutes * 60000, y, device: 'synthetic'});
          const sensor = (minutes, filtered, type = 'sgv') => ({mills: start + minutes * 60000, filtered, type});
          const data = {
            '2015-08-08': {sgv: [sensor(3, 60000), sensor(0, 58000), sensor(0, 99999, 'rawbg')],
              mbg: [meter(1, 108), meter(4, 110)], cal: [{mills: start + 60001, scale: 1, intercept: 0, slope: 1000}],
              treatments: [{mills: start + 120000, eventType: 'Sensor Start'}]},
            '2015-08-09': {sgv: [sensor(1443, 62000), sensor(1440, 59000)],
              mbg: [meter(1441, 112), meter(1444, 114), meter(1455, 116)],
              cal: [{mills: start + 1441 * 60000 + 1, scale: 1, intercept: 0, slope: 1000}], treatments: []}
          };
          const plugin = window.Nightscout.report_plugins('calibrations');
          document.getElementById('calibrations-placeholder').innerHTML = plugin.html(client);
          window.renderCalibrationFixture = newestFirst => plugin.report(data,
            newestFirst ? ['2015-08-09', '2015-08-08'] : ['2015-08-08', '2015-08-09']);
          window.calibrationDataUnchanged = () => JSON.stringify(data) === original;
          const original = JSON.stringify(data);
          window.renderCalibrationFixture(true);
        }, theme);
        const requestCount = requests.length;
        const expectedRaw = ['58000', '60000', '59000', '62000', 'Not available'];
        const raw = () => page.locator('.calibrations-mbg td:last-child').allTextContents();
        assert.deepEqual(await raw(), expectedRaw);
        assert.equal(await page.locator('.calibrations-checkbox:checked').count(), 3);
        assert.equal(await page.locator('.calibrations-point').count(), 2);
        assert.equal(await page.locator('.calibrations-curve').count(), 1);
        assert.ok((await page.locator('.calibrations-help').allTextContents()).join(' ').includes('selected automatically'));
        assert.ok((await page.locator('.calibrations-help').allTextContents()).join(' ').includes('only change this display'));
        assert.deepEqual(await page.locator('.calibrations-table th').allTextContents(),
          ['Show in chart', 'Date / time', 'Meter glucose (mg/dL)', 'Raw signal']);
        assert.ok((await page.locator('.calibrations-event').textContent()).includes('Sensor Start'));
        const checks = page.locator('.calibrations-checkbox');
        for (let i = 0; i < 5; i++) await checks.nth(i).uncheck();
        assert.equal(await page.locator('.calibrations-point, .calibrations-curve').count(), 0);
        assert.match(await page.locator('#calibrations-status').textContent(), /Select a meter reading/);
        await checks.first().focus();
        await page.keyboard.press('Space');
        assert.equal(await page.locator('.calibrations-point').count(), 1);
        assert.equal(await page.locator('.calibrations-curve').count(), 1);
        await checks.first().uncheck();
        await checks.last().check();
        assert.match(await page.locator('#calibrations-status').textContent(), /No matching raw sensor data/);
        await page.evaluate(() => window.renderCalibrationFixture(false));
        assert.deepEqual(await raw(), expectedRaw);
        assert.equal(await page.evaluate(() => window.calibrationDataUnchanged()), true);
        assert.equal(requests.length, requestCount, 'selection changes only the display');
        if (process.env.NIGHTSCOUT_CALIBRATION_SCREENSHOTS) {
          await page.locator('#calibrations-placeholder').screenshot({path: process.env.NIGHTSCOUT_CALIBRATION_SCREENSHOTS + '/' + theme + '-desktop.png'});
        }
        for (const width of [375, 320]) {
          await page.setViewportSize({width, height: 812});
          const layout = await page.locator('.calibrations-layout').evaluate(node => {
            const list = node.querySelector('#calibrations-list').getBoundingClientRect();
            const chart = node.querySelector('#calibrations-chart-panel').getBoundingClientRect();
            return {width: node.clientWidth, scroll: node.scrollWidth, listBottom: list.bottom, chartTop: chart.top};
          });
          assert.ok(layout.chartTop >= layout.listBottom, JSON.stringify(layout));
          assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout));
          assert.equal(await checks.first().isVisible(), true);
        }
        if (process.env.NIGHTSCOUT_CALIBRATION_SCREENSHOTS) {
          await page.locator('#calibrations-placeholder').screenshot({path: process.env.NIGHTSCOUT_CALIBRATION_SCREENSHOTS + '/' + theme + '-phone.png'});
        }
        await page.emulateMedia({media: 'print'});
        assert.equal(await page.locator('#calibrations-chart svg').isVisible(), true);
        assert.equal(await page.locator('#calibrations-list').evaluate(node => getComputedStyle(node).maxHeight), 'none');
      });
    });
  }

  for (const theme of ['default', 'modern']) {
    it('opens hourly basal adjustments directly and preserves them across tab and range changes in ' + theme, async function () {
      const key = queryKey('/api/v1/treatments.json?find[created_at][$gte]=2015-08-08T00:00:00.000Z&find[created_at][$lt]=2015-08-09T00:00:00.000Z&count=1000');
      const previous = responses.get(key);
      responses.set(key, previous.concat([
        {eventType: 'Temp Basal', created_at: '2015-08-08T00:00:00.000Z', duration: 30, absolute: 0},
        {eventType: 'Temp Basal', created_at: '2015-08-08T01:00:00.000Z', duration: 30, absolute: 1.1}
      ]));
      try {
        await withReports(async page => {
          await page.addStyleTag({url: origin + '/css/modern-reports.css'});
          await page.evaluate(theme => {
            window.Nightscout.client.settings.theme = theme;
            document.documentElement.classList.toggle('modern-ui', theme === 'modern');
            document.body.classList.add('report-page');
            document.getElementById('rp_optionsbasal').checked = false;
          }, theme);
          await page.locator('#rp_to').fill('2015-08-09');
          await page.locator('#hourlystats').click();
          await show(page);
          assert.equal(await page.locator('#daytodaycharts svg').count(), 0, 'Day to Day has never been drawn');
          const section = page.locator('#hourly-basal-adjustments');
          assert.equal(await section.locator('h2').textContent(), 'Hourly basal adjustments (U)');
          const row = section.locator('tbody tr').filter({hasText: '08/08/2015'});
          assert.equal(await row.locator('td').nth(0).locator('.basal-net').textContent(), '-0.05');
          assert.equal(await row.locator('td').nth(1).locator('.basal-net').textContent(), '0.50');
          const baseline = await row.locator('td').allTextContents();
          const requestCount = requests.length;
          await page.locator('#daytoday').click();
          await page.locator('#daytodaycharts svg').first().waitFor();
          await page.locator('#hourlystats').click();
          assert.deepEqual(await row.locator('td').allTextContents(), baseline);
          assert.equal(requests.length, requestCount, 'Tab changes use the loaded data');
          await page.locator('#daytoday').click();
          await page.locator('#rp_optionsbasal').check();
          await show(page);
          await page.locator('#hourlystats').click();
          assert.deepEqual(await row.locator('td').allTextContents(), baseline, 'Drawing basal charts leaves statistics unchanged');
          if (process.env.NIGHTSCOUT_HOURLY_SCREENSHOTS) {
            await section.screenshot({path: process.env.NIGHTSCOUT_HOURLY_SCREENSHOTS + '/' + theme + '-desktop.png'});
          }
          await page.setViewportSize({width: 375, height: 812});
          const scroll = section.locator('.hourly-basal-scroll');
          assert.equal(await scroll.evaluate(node => node.scrollWidth > node.clientWidth), true);
          await scroll.focus(); await page.keyboard.press('ArrowRight');
          await page.waitForFunction(() => document.querySelector('.hourly-basal-scroll').scrollLeft > 0);
          if (process.env.NIGHTSCOUT_HOURLY_SCREENSHOTS) {
            await section.screenshot({path: process.env.NIGHTSCOUT_HOURLY_SCREENSHOTS + '/' + theme + '-phone.png'});
          }
          await page.locator('#rp_from').fill('2015-08-09');
          await show(page);
          assert.equal(await section.locator('tbody tr').count(), 1);
          assert.equal(await section.locator('tbody .basal-net').first().textContent(), '0.00');
          assert.equal(await section.locator('.hourly-basal-unavailable').count(), 0);
        });
      } finally {responses.set(key, previous);}
    });
  }

  for (const theme of ['default', 'modern']) {
    it('preserves profile switches through report tabs and a note-only edit in ' + theme, async function () {
      const key = queryKey('/api/v1/treatments.json?find[created_at][$gte]=2015-08-08T00:00:00.000Z&find[created_at][$lt]=2015-08-09T00:00:00.000Z&count=1000');
      const previous = responses.get(key);
      const embedded = {timezone: 'UTC', units: 'mg/dl', basal: [{time: '00:00', value: 0.05}]};
      const treatment = {_id: 'report-switch', eventType: 'Profile Switch', created_at: '2015-08-08T06:00:00.000Z',
        duration: 60, profile: 'Exercise', profileJson: JSON.stringify(embedded), notes: 'Original note'};
      responses.set(key, [treatment]);
      try {
        await withReports(async page => {
          await page.evaluate(({theme, embedded}) => {
            const client = window.Nightscout.client;
            client.settings.theme = theme;
            client.sbx.data.profile.data[0].store.Exercise = embedded;
          }, {theme, embedded});
          await page.locator('#rp_to').fill('2015-08-08');
          await page.locator('#treatments').click(); await show(page);
          const edit = page.locator('.editTreatment[data*="report-switch"]');
          assert.equal(JSON.parse(await edit.getAttribute('data')).profile, 'Exercise');
          await page.locator('#daytoday').click();
          await page.locator('#rp_optionsbasal').check(); await show(page);
          await page.locator('#hourlystats').click();
          const hour = page.locator('#hourly-basal-adjustments tbody tr td').nth(6);
          assert.equal(await hour.locator('.basal-net').textContent(), '0.00');
          await page.locator('#loopalyzer').click(); await show(page);
          assert.equal(await page.evaluate(() => window.Nightscout.client.sbx.data.profile.profiletreatments.length), 0);
          await page.locator('#treatments').click();
          assert.equal(JSON.parse(await edit.getAttribute('data')).profile, 'Exercise');
          await edit.click();
          assert.equal(await page.locator('#rped_profile').inputValue(), 'Exercise');
          await page.locator('#rped_adnotes').fill('Changed note only');
          await page.locator('.ui-dialog-buttonpane button').filter({hasText: 'Save'}).click();
          await idle(page);
          const saved = requests.find(request => request.method === 'PUT').body;
          assert.equal(saved.profile, 'Exercise');
          assert.equal(saved.profileJson, treatment.profileJson);
          assert.equal(saved.notes, 'Changed note only');
          assert.equal(saved.eventTime, treatment.created_at);
        });
      } finally {responses.set(key, previous);}
    });

    it('keeps report timezones and filtered results stable across refreshes in ' + theme, async function () {
      const start = Date.parse('2015-08-08T00:00:00Z');
      const key = queryKey('/api/v1/entries.json?find[date][$gte]=' + start + '&find[date][$lt]=' + (start + 86400000) + '&count=10000');
      const previous = responses.get(key), previousZone = reportProfile.store.Default.timezone;
      reportProfile.store.Default.timezone = 'America/New_York';
      responses.set(key, [0, 5, 10, 720, 725, 730].map((minute, index) => ({type: 'sgv',
        date: start + minute * 60000, sgv: index < 3 ? 60 : 200, dateString: new Date(start + minute * 60000).toISOString()})));
      try {
        await withReports(async page => {
          await page.evaluate(theme => {window.Nightscout.client.settings.theme = theme;}, theme);
          await page.locator('#rp_to').fill('2015-08-08');
          await page.locator('#glucosedistribution').click();
          await page.locator('#glucosedistribution-0').uncheck(); await show(page);
          const distribution = page.locator('#glucosedistribution-report');
          const first = await distribution.textContent();
          assert.ok(first.includes('100.0%3'), first);
          assert.equal(await page.evaluate(() => window.Nightscout.client.sbx.data.profile.getTimezone()), 'UTC');
          await show(page);
          assert.equal(await distribution.textContent(), first);
          await page.locator('#daytoday').click(); await show(page);
          await page.locator('#loopalyzer').click(); await idle(page);
          await page.locator('#glucosedistribution').click();
          assert.equal(await distribution.textContent(), first);
          assert.equal(await page.evaluate(() => window.Nightscout.client.sbx.data.profile.getTimezone()), 'UTC');
          // Fetch another day after the historical calculation: query boundaries
          // must still use the timezone that loaded the original report period.
          await page.locator('#rp_to').fill('2015-08-09'); await show(page);
          const queries = requests.filter(request => request.url.startsWith('/api/v1/entries.json'))
            .map(request => new URL(request.url, origin).searchParams.get('find[date][$gte]'));
          assert.ok(queries.includes(String(start + 86400000)));
          assert.ok(!queries.includes(String(start + 86400000 + 4 * 3600000)));
        });
      } finally {responses.set(key, previous); reportProfile.store.Default.timezone = previousZone;}
    });
  }

  async function renderPentagonFixture(page) {
    await page.locator('#glucosedistribution').click();
    await page.evaluate(() => {
      window.renderPentagonFixture = (count = 288) => {
        const profile = window.Nightscout.client.sbx.data.profile;
        const start = profile.parseInTimezone('2015-08-08').valueOf();
        const records = Array.from({length: count}, (_, i) => ({
          displayTime: new Date(start + i * 300000), bgValue: i < 144 ? 60 : 200, sgv: i < 144 ? 60 : 200
        }));
        window.Nightscout.report_plugins('glucosedistribution').report(
          {allstatsrecords: records, alldays: 1}, ['2015-08-08'], {targetLow: 70, targetHigh: 180});
      };
      window.renderPentagonFixture();
    });
  }

  it('renders and updates the glucose pentagon in the Distribution report', async function () {
    await withReports(async page => {
      await renderPentagonFixture(page);
      assert.match(await page.locator('.gd-pentagon-score').textContent(), /^PGR: /);
      assert.equal(await page.locator('.gd-pentagon-values dt').count(), 5);
      assert.equal(await page.locator('.gd-pentagon-chart svg').getAttribute('role'), 'img');
      const firstFiveMinutes = await page.evaluate(() => window.Nightscout.client.sbx.data.profile.parseInTimezone('2015-08-08').valueOf() + 300000);
      await page.clock.setFixedTime(new Date(firstFiveMinutes));
      await page.evaluate(() => window.renderPentagonFixture(1));
      assert.equal(await page.locator('.gd-pentagon-score').count(), 0);
      assert.match(await page.locator('.gd-pentagon-coverage').textContent(), /100\.0%/);
      assert.match(await page.locator('.gd-pentagon-message').textContent(), /16 hours 48 minutes/);
      await page.clock.setFixedTime(new Date('2025-01-01T12:00:00Z'));
      await page.evaluate(() => window.renderPentagonFixture());
      await page.locator('#glucosedistribution-0').uncheck();
      assert.equal(await page.locator('.gd-pentagon-score').count(), 0);
      assert.match(await page.locator('.gd-pentagon-message').textContent(), /all 24 hours/);
      await page.locator('#glucosedistribution-0').check();
      assert.match(await page.locator('.gd-pentagon-score').textContent(), /^PGR: /);
      if (process.env.NIGHTSCOUT_PENTAGON_SCREENSHOT) await page.locator('.gd-pentagon').screenshot({path: process.env.NIGHTSCOUT_PENTAGON_SCREENSHOT});
      await page.addStyleTag({url: origin + '/css/modern-reports.css'});
      await page.evaluate(() => {
        document.documentElement.classList.add('modern-ui', 'report-ui');
        document.body.classList.add('report-page');
        window.Nightscout.client.settings.theme = 'modern';
      });
      for (const [name, size] of [['desktop', {width: 1440, height: 1100}], ['mobile', {width: 390, height: 844}]]) {
        await page.setViewportSize(size);
        const chart = page.locator('.gd-pentagon-chart svg');
        assert.equal(await chart.isVisible(), true);
        const bounds = await chart.evaluate(svg => {
          const chartRect = svg.getBoundingClientRect(), cardRect = svg.closest('.gd-pentagon').getBoundingClientRect();
          const labels = Array.from(svg.closest('.gd-pentagon-chart').querySelectorAll('.gd-pentagon-label'), label => label.getBoundingClientRect());
          return {left: chartRect.left - cardRect.left, right: cardRect.right - chartRect.right,
            labelsFit: labels.every(label => label.left >= cardRect.left && label.right <= cardRect.right)};
        });
        assert.ok(bounds.left >= 0 && bounds.right >= 0 && bounds.labelsFit, name + ' chart and labels fit within the card');
        if (process.env.NIGHTSCOUT_PENTAGON_SCREENSHOTS) {
          await page.locator('.gd-pentagon').screenshot({path: process.env.NIGHTSCOUT_PENTAGON_SCREENSHOTS + '/modern-' + name + '.png'});
          if (name === 'desktop') await page.locator('#glucosedistribution-placeholder').screenshot({path: process.env.NIGHTSCOUT_PENTAGON_SCREENSHOTS + '/modern-report-desktop.png'});
        }
      }
    });
  });

  it('wraps translated pentagon labels and preserves report content in print', async function () {
    await withReports(async page => {
      await renderPentagonFixture(page);
      const score = await page.locator('.gd-pentagon-score').textContent();
      const polygon = await page.locator('.gd-pentagon-patient').getAttribute('points');
      await page.addStyleTag({url: origin + '/css/modern-reports.css'});
      for (const modern of [false, true]) {
        await page.evaluate(modern => {
          document.documentElement.classList.toggle('modern-ui', modern);
          document.documentElement.classList.toggle('report-ui', modern);
          document.body.classList.toggle('report-page', modern);
        }, modern);
        // Pseudolocales exercise expansion, unspaced Unicode and bidi text;
        // these are test data, not medical translations for publication.
        for (const locale of ['expanded', 'unspaced', 'rtl']) {
          await page.evaluate(locale => {
            const names = ['Time out of range', 'Glucose variability', 'Low glucose intensity', 'High glucose intensity', 'Mean glucose'];
            const prefix = locale === 'rtl' ? 'العربية עברית ' : locale === 'unspaced' ? '漢字'.repeat(16) : 'é 👩‍⚕️ ';
            window.Nightscout.client.translate = text => names.includes(text) ? prefix + text + ' ' + text : text;
            window.renderPentagonFixture();
            document.querySelector('.gd-pentagon').dir = locale === 'rtl' ? 'rtl' : 'ltr';
          }, locale);
          for (const width of [320, 390, 1440]) {
            await page.setViewportSize({width, height: 1100});
            const layout = await page.locator('.gd-pentagon').evaluate(card => {
              const bounds = card.getBoundingClientRect();
              const chart = card.querySelector('svg').getBoundingClientRect();
              const labels = Array.from(card.querySelectorAll('.gd-pentagon-label'), label => {
                const range = document.createRange(); range.selectNodeContents(label);
                const r = range.getBoundingClientRect();
                return {fits: r.left >= bounds.left - 1 && r.right <= bounds.right + 1,
                  overlaps: r.left < chart.right && r.right > chart.left && r.top < chart.bottom && r.bottom > chart.top,
                  direction: getComputedStyle(label).direction};
              });
              return {labels, overflow: card.scrollWidth - card.clientWidth};
            });
            assert.equal(layout.labels.length, 5);
            assert.ok(layout.labels.every(label => label.fits && !label.overlaps), JSON.stringify({modern, locale, width, layout}));
            assert.ok(layout.overflow <= 1, JSON.stringify({modern, locale, width, layout}));
            if (locale === 'rtl') assert.ok(layout.labels.every(label => label.direction === 'rtl'));
            assert.equal(await page.locator('.gd-pentagon-score').textContent(), score);
            assert.equal(await page.locator('.gd-pentagon-patient').getAttribute('points'), polygon);
          }
        }
        await page.setViewportSize({width: 794, height: 1123});
        await page.emulateMedia({media: 'print'});
        assert.equal(await page.locator('.gd-pentagon-chart svg').isVisible(), true);
        assert.equal(await page.locator('.gd-pentagon-values dd').count(), 5);
        assert.equal(await page.locator('.gd-pentagon-score').textContent(), score);
        assert.equal(await page.locator('.gd-pentagon-note').first().isVisible(), true);
        assert.match(await page.locator('.gd-pentagon-note').first().textContent(), /not a validated prediction/);
        assert.match(await page.locator('.gd-pentagon-legend').textContent(), /Dashed green: reference · Solid yellow: selected data/);
        const styles = await page.locator('.gd-pentagon').evaluate(card => ({
          breakInside: getComputedStyle(card).breakInside,
          reference: getComputedStyle(card.querySelector('.gd-pentagon-reference')).strokeDasharray,
          selected: getComputedStyle(card.querySelector('.gd-pentagon-patient')).strokeDasharray
        }));
        assert.equal(styles.breakInside, 'avoid');
        assert.notEqual(styles.reference, 'none');
        assert.equal(styles.selected, 'none');
        await page.emulateMedia({media: 'screen'});
      }
    });
  });

  it('should produce week to week report', async function () {
    await withReports(async page => {
      await page.locator('#weektoweek').click();
      for (const scale of ['wrp_log', 'wrp_linear']) {
        await page.locator('#' + scale).check(); await show(page);
        const colors = await page.locator('#weektoweek-placeholder circle[cx][cy]').evaluateAll(nodes => nodes.filter(node => node.__data__.type === 'sgv').map(node => node.getAttribute('fill')));
        assert.equal(colors.length, 16);
        for (const color of ['31, 119, 180', '255, 127, 14', '44, 160, 44', '214, 39, 40', '148, 103, 189', '140, 86, 75', '23, 190, 207']) assert.ok(colors.includes('rgb(' + color + ')'));
      }
    });
  });

  for (const units of ['mg/dl', 'mmol']) {
    it('renders empty report periods repeatedly in ' + units, async function () {
      await withReports(async page => {
        await page.evaluate(units => {window.Nightscout.client.settings.units = units;}, units);
        await page.locator('#rp_from').fill('2025-01-01');
        await page.locator('#rp_to').fill('2025-01-01');
        await page.locator('#hourlystats').click();
        let count;
        for (let cycle = 0; cycle < 2; cycle++) {
          await show(page);
          // CHANGED at the cut 5 merge: dev draws this chart with D3 (#8542),
          // so the repeated render is checked on its SVG rather than a canvas.
          const next = await page.locator('#hourlystats-overviewchart svg').count();
          assert.ok(next > 0);
          if (count !== undefined) assert.equal(next, count, 'Repeated rendering replaces the chart');
          count = next;
          assert.deepEqual(networkDiagnostics.get(page).consoleErrors, []);
        }
      });
    });

    it('preserves plotted report data and finite axes in ' + units + ' over repeated renders', async function () {
      this.timeout(90000);
      await withReports(async page => {
        await page.evaluate(units => {
          window.Nightscout.client.settings.units = units;
          const original = $.plot;
          window.reportPlots = {};
          $.plot = Object.assign(function (placeholder, data, options) {
            const plot = original(placeholder, data, options);
            const id = $(placeholder).attr('id');
            const axes = Object.fromEntries(Object.entries(plot.getAxes()).filter(([, axis]) => axis.used).map(([name, axis]) => [name, {
              min: axis.min, max: axis.max, mode: axis.options.mode,
              ticks: (axis.ticks || []).map(tick => ({v: tick.v, label: tick.label}))
            }]));
            const normalized = JSON.parse(JSON.stringify(data));
            for (const series of normalized) {
              if (series.bars && Array.isArray(series.bars.barWidth) && series.bars.barWidth[1] === true) {
                series.bars.barWidth = series.bars.barWidth[0];
              }
            }
            window.reportPlots[id] = {data: normalized, axes,
              width: plot.width(), height: plot.height(),
              canvases: $(placeholder).find('canvas').length};
            return plot;
          }, original);
        }, units);
        await page.locator('#rp_to').fill('2015-08-14');
        await page.locator('#loopalyzer').click();
        let initial;
        for (let cycle = 0; cycle < 2; cycle++) {
          await page.evaluate(() => {window.reportPlots = {};});
          await show(page);
          // CHANGED at the cut 5 merge: dev's AGP work (#8542) draws the daily,
          // hourly, percentile and distribution charts with D3, so Loopalyzer is
          // the only report still plotted with Flot. The characterized series
          // are compared for Loopalyzer only, against this branch's goldens
          // unchanged; the other charts' golden entries describe Flot charts dev
          // no longer draws.
          const flotCharts = ['loopalyzer-basal', 'loopalyzer-bg', 'loopalyzer-tempbasal', 'loopalyzer-iob', 'loopalyzer-cob'];
          await page.waitForFunction(() => Boolean(window.reportPlots['loopalyzer-cob']));
          const plots = await page.evaluate(() => window.reportPlots);
          assert.deepEqual(Object.keys(plots).sort(), flotCharts.slice().sort(), 'Only Loopalyzer is plotted with Flot');
          const data = Object.fromEntries(Object.entries(plots).map(([id, plot]) => [id, plot.data]));
          const golden = path.join(__dirname, 'report-plot-data-' + (units === 'mmol' ? 'mmol' : 'mgdl') + '.json');
          // dev's restyle (#8542) changed Loopalyzer's series colours and nothing
          // else in these series, so colour is left out of the comparison.
          const uncoloured = charts => Object.fromEntries(Object.entries(charts).map(([id, series]) =>
            [id, series.map(({color, ...rest}) => rest)]));
          const characterized = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(golden, 'utf8')))
            .filter(([id]) => flotCharts.includes(id)));
          assert.deepEqual(uncoloured(data), uncoloured(characterized), 'Report series match characterized output');
          if (initial) assert.deepEqual(data, initial, 'Repeated rendering preserves series');
          initial = data;
          for (const [id, plot] of Object.entries(plots)) {
            assert.ok(plot.width > 0 && plot.height > 0 && plot.canvases > 0, id + ' renders a visible canvas');
            for (const axis of Object.values(plot.axes)) {
              assert.ok(Number.isFinite(axis.min) && Number.isFinite(axis.max), id + ' finite axis bounds');
              assert.ok(axis.ticks.every(tick => Number.isFinite(tick.v)), id + ' finite tick values');
              if (axis.mode === 'time') assert.ok(axis.ticks.every(tick => !/Invalid|NaN/.test(tick.label)), id + ' valid dates');
              if (axis.mode === 'time' && id.startsWith('loopalyzer-')) {
                assert.ok(axis.max - axis.min <= 86400000, id + ' retains a single day, including absolute bar widths');
                assert.ok(axis.ticks.length <= 26, id + ' does not generate thousands of hourly labels');
              }
            }
          }
          assert.equal(plots['loopalyzer-bg'].axes.yaxis.max, units === 'mmol' ? 20 : 400);
          assert.equal(plots['loopalyzer-tempbasal'].axes.yaxis.min, -1);
          assert.equal(plots['loopalyzer-tempbasal'].axes.yaxis.max, 1);
          const labels = await page.locator('#loopalyzer-cob .flot-x-axis .tickLabel').evaluateAll(elements => elements.map(element => {
            const style = getComputedStyle(element), rect = element.getBoundingClientRect();
            return {text: element.textContent, width: rect.width, height: rect.height,
              color: element.namespaceURI === 'http://www.w3.org/2000/svg' ? style.fill : style.color};
          }).filter(label => label.width > 0 && label.height > 0));
          assert.ok(labels.some(label => label.text === '12:00'), 'Time labels are rendered');
          assert.ok(labels.every(label => label.color !== 'rgb(255, 255, 255)'), 'Report labels contrast with the white background');
          assert.ok((await page.locator('#loopalyzer-bg .legend').textContent()).includes('Blood Glucose'), 'Legend remains enabled');
          assert.deepEqual(networkDiagnostics.get(page).consoleErrors, []);
          if (process.env.NIGHTSCOUT_REPORT_PLOT_EVIDENCE) fs.writeFileSync(
            process.env.NIGHTSCOUT_REPORT_PLOT_EVIDENCE + '-' + (units === 'mmol' ? 'mmol' : 'mgdl') + '.json',
            JSON.stringify(plots, null, 2) + '\n');
          if (cycle === 1 && process.env.NIGHTSCOUT_REPORT_SCREENSHOTS) {
            for (const tab of ['loopalyzer']) {
              await page.locator('#' + tab).click();
              fs.writeFileSync(process.env.NIGHTSCOUT_REPORT_SCREENSHOTS + '-' + tab + '-labels.json', JSON.stringify(await page.locator('#' + tab + '-placeholder').evaluate(root =>
                [...root.querySelectorAll('.flot-svg text')].slice(0, 30).map(element => ({text: element.textContent,
                  html: element.outerHTML, font: getComputedStyle(element).font, fill: getComputedStyle(element).fill,
                  rect: element.getBoundingClientRect().toJSON(), svg: element.closest('svg').getBoundingClientRect().toJSON()}))), null, 2));
              await page.locator('#' + tab + '-placeholder').screenshot({path:
                process.env.NIGHTSCOUT_REPORT_SCREENSHOTS + '-' + tab + '-' + (units === 'mmol' ? 'mmol' : 'mgdl') + '.png'});
            }
          }
        }
      });
    });
  }
});
