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

function queryKey(value) {
  const url = new URL(value, 'http://127.0.0.1');
  url.searchParams.delete('_');
  url.searchParams.sort();
  return url.pathname + '?' + url.searchParams.toString();
}

describe('legacy reports in a real browser', function () {
  let server, origin, markup, requests;
  before(async function () {
    const root = path.resolve(__dirname, '../..'), file = path.join(root, 'views/reportindex.html');
    markup = ejs.render(fs.readFileSync(file, 'utf8'), {type: 'reports', title: '', bundle: '/bundle'}, {filename: file});
    const cssNames = ['main', 'drawer', 'report', 'dropdown', 'ui-lightness/jquery-ui.min'];
    const css = new Map(cssNames.map(name => ['/css/' + name + '.css', fs.readFileSync(path.join(root, 'static/css', name + '.css'), 'utf8')
      .split('\n').filter(line => ![
        "@import url('https://fonts.googleapis.com/css?family=Ubuntu:400,700');",
        '@import url("//fonts.googleapis.com/css?family=Ubuntu:300,400,500,700,300italic,400italic,500italic,700italic");',
        '@import url("//fonts.googleapis.com/css?family=Open+Sans:300italic,400italic,600italic,700italic,300,400,600,700,800");'
      ].includes(line)).join('\n')]));
    const html = '<!doctype html><html><head><meta charset="utf-8">' + cssNames.map(name => '<link rel="stylesheet" href="/css/' + name + '.css">').join('') + '</head><body></body></html>';
    const responses = new Map(Object.entries(fixtures.someData).map(([url, data]) => [queryKey(url), data]));
    const settings = structuredClone(require('../fixtures/default-server-settings'));
    const app = express();
    app.use(express.json()); app.use(express.urlencoded({extended: true}));
    app.get('/', (request, response) => response.type('html').send(html));
    app.use((request, response, next) => {
      if (request.path.startsWith('/api/') || request.path.startsWith('/translations/')) {
        requests.push({method: request.method, url: request.originalUrl, body: request.body});
      }
      next();
    });
    app.get('/api/v1/status.json', (request, response) => response.json(settings));
    app.get('/api/v1/verifyauth', (request, response) => response.json({message: 'OK'}));
    app.get('/api/v1/adminnotifies', (request, response) => response.json({message: {notifies: [], notifyCount: 0}}));
    app.get('/translations/*', (request, response) => response.json({}));
    app.get(['/api/v1/entries.json', '/api/v1/treatments.json', '/api/v1/food/regular.json', '/api/v1/profiles', '/api/v1/devicestatus.json'],
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
    await withPage(origin, async ({page}) => {
      await page.clock.setFixedTime(new Date('2025-01-01T12:00:00Z'));
      await page.goto(origin);
      await page.evaluate(markup => {
        const parsed = new DOMParser().parseFromString(markup, 'text/html');
        parsed.querySelectorAll('script').forEach(script => script.remove());
        parsed.querySelectorAll('audio').forEach(audio => {audio.preload = 'none';});
        document.body.replaceChildren(...parsed.body.childNodes);
      }, markup);
      await page.addScriptTag({url: origin + '/bundle/js/bundle.app.js'});
      await page.addScriptTag({url: origin + '/report/js/flotcandle.js'});
      await page.addScriptTag({url: origin + '/report/js/loopalyzer.js'});
      await page.evaluate(() => {
        window.reportFixture = {emitted: []};
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
      assert.equal(await page.locator('#tabnav .menutab').count(), 11);
      await run(page);
    }, {timezoneId: 'UTC'});
  }

  async function show(page) {
    await page.locator('#rp_show').click();
    await idle(page);
  }

  async function idle(page) {
    await page.waitForFunction(() => window.$.active === 0 && window.$('#rp_show').is(':visible') && window.$('#info').text() === '');
  }

  it('should produce some html', async function () {
    await withReports(async page => {
      await page.locator('#daytoday').click();
      await page.locator('#rp_optionsnotes').check();
      await page.locator('#rp_optionscarbs').check();
      await page.locator('#rp_notes').fill('something');
      await page.locator('#rp_eventtype').selectOption('BG Check');
      for (const id of ['rp_optionsraw', 'rp_optionsiob', 'rp_optionscob', 'rp_enableeventtype', 'rp_enablenotes', 'rp_optionsopenaps']) await page.locator('#' + id).check();
      await page.locator('#rp_enablefood').check(); await page.locator('#rp_enablefood').uncheck();
      for (const scale of ['rp_log', 'rp_linear']) {
        await page.locator('#' + scale).check(); await show(page);
        const text = await page.locator('#daytoday-placeholder').textContent();
        assert.ok(text.includes('Milk now')); assert.ok(text.includes('50 g'));
        assert.ok(text.includes('TDD average: 2.9U'));
      }
      await page.locator('#treatments').click(); await show(page);
      const cells = await page.locator('#treatments-report tr.border_bottom').evaluateAll(rows => rows.map(row => Array.from(row.cells, cell => cell.textContent)));
      assert.ok(cells.some(row => row[2] === 'Correction Bolus' && row[3] === '250 (Sensor)' && row[4] === '0.75'));
      for (let cycle = 1; cycle <= 2; cycle++) {
        const deletesBefore = requests.filter(r => r.method === 'DELETE').length;
        const confirmation = page.waitForEvent('dialog').then(async dialog => {
          assert.equal(dialog.type(), 'confirm'); assert.ok(dialog.message().includes('Delete this treatment?'));
          await dialog.dismiss();
        });
        await page.locator('img.deleteTreatment').first().click(); await confirmation;
        assert.equal(requests.filter(r => r.method === 'DELETE').length, deletesBefore);
        const accepted = page.waitForEvent('dialog').then(async dialog => {
          assert.equal(dialog.type(), 'confirm'); assert.ok(dialog.message().includes('Meal Bolus'));
          await dialog.accept();
        });
        await page.locator('img.deleteTreatment').first().click(); await accepted;
        await idle(page);
        assert.equal(requests.filter(r => r.method === 'DELETE').length, deletesBefore + 1);
        assert.equal(requests.filter(r => r.method === 'DELETE').at(-1).url, '/api/v1/treatments/55ce59bb925aa80e7071e5ba');
        await page.locator('img.editTreatment').first().click();
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
      // interpolation/cleaning. Preserve both original regression expectations.
      assert.equal(daily.length, 31);
      assert.equal(daily.filter(row => row[2] === 'No data available').length, 23);
      const populated = daily.filter(row => row.length === 15);
      assert.equal(populated.length, 8);
      assert.equal(populated.reduce((sum, row) => sum + Number(row[5]), 0), 16);
      const distribution = await page.locator('#glucosedistribution-report tr').evaluateAll(rows => rows.map(row => Array.from(row.cells, cell => cell.textContent)));
      assert.ok(distribution.some(row => row[0].trim() === 'In Range:' && row[1] === '47.6%' && row[2] === '10'));
      const hourly = await page.locator('#hourlystats-report td').allTextContents();
      assert.ok(hourly.includes('16 (100%)'));
      assert.equal(await page.locator('#success-grid').count(), 1);
      assert.ok((await page.locator('#calibrations-placeholder').textContent()).includes('CAL:  Scale: 1.10 Intercept: 31102 Slope: 776.91'));

    });
  });

  it('should produce week to week report', async function () {
    await withReports(async page => {
      await page.locator('#weektoweek').click();
      for (const scale of ['wrp_log', 'wrp_linear']) {
        await page.locator('#' + scale).check(); await show(page);
        const colors = await page.locator('#weektoweek-placeholder circle[cx][cy]').evaluateAll(nodes => nodes.filter(node => node.__data__.type === 'sgv').map(node => node.getAttribute('fill')));
        assert.equal(colors.length, 16);
        for (const color of ['73, 22, 153', '34, 201, 228', '0, 153, 123', '135, 135, 228', '135, 49, 204', '36, 36, 228', '0, 234, 188']) assert.ok(colors.includes('rgb(' + color + ')'));
      }
    });
  });
});
