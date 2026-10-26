'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {withPage} = require('./fixture');

describe('admin actions in a real browser', function () {
  let server, origin, routes, requests;
  before(async function () {
    const bundle = fs.readFileSync(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public/js/bundle.app.js'));
    const pageBundle = fs.readFileSync(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public/js/bundle.admin.js'));
    server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/page.js') {
        response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        response.end(pageBundle); return;
      }
      if (url.pathname === '/bundle.js') {
        response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        response.end(bundle);
      } else if (url.pathname.startsWith('/api/')) {
        requests.push({method: request.method, url});
        const key = request.method + ' ' + url.pathname;
        if (!Object.prototype.hasOwnProperty.call(routes, key)) {
          response.writeHead(404).end();
          return;
        }
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify(routes[key]));
      } else if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
      } else response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  async function withPlugin(name, responses, run) {
    routes = responses;
    requests = [];
    return withPage(origin, async ({page}) => {
      await page.goto(origin);
      assert.equal(await page.evaluate(() => document.characterSet), 'UTF-8');
      await page.addScriptTag({url: origin + '/bundle.js'});
      await page.addScriptTag({url: origin + '/page.js'});
      await page.evaluate(name => {
        const plugin = window.Nightscout.admin_plugins(name);
        const client = {
          translate: (text, options) => options?.params ? options.params.reduce((result, value, index) => result.replace('%' + (index + 1), value), text) : text,
          headers: () => ({}), hashauth: {isAuthenticated: () => true},
          careportal: {resolveEventName: name => name},
          sbx: {data: {profile: {getTimezone: () => 'America/New_York'}}}
        };
        // Keep the original component fixture boundary: production plugin
        // actions operate on their real DOM containers, not a full admin boot.
        for (let index = 0; index < plugin.actions.length; index++) {
          for (const [tag, suffix] of [['div', 'html'], ['span', 'status']]) {
            const element = document.createElement(tag);
            element.id = 'admin_' + plugin.name + '_' + index + '_' + suffix;
            document.body.append(element);
          }
        }
        window.adminFixture = {plugin, client, callbacks: 0};
      }, name);
      await run(page);
    });
  }

  async function action(page, index, method) {
    await page.evaluate(({index, method}) => new Promise(resolve => {
      const fixture = window.adminFixture;
      fixture.plugin.actions[index][method](fixture.client, () => { fixture.callbacks++; resolve(); });
    }), {index, method});
    await page.waitForFunction(() => window.$.active === 0);
  }
  async function status(page, name, index = 0) {
    return page.locator('#admin_' + name + '_' + index + '_status').textContent();
  }
  async function label(page, index = 0) {
    return page.evaluate(index => window.adminFixture.plugin.actions[index].buttonLabel, index);
  }
  function query(method, pathname) {
    const matches = requests.filter(request => request.method === method && request.url.pathname === pathname);
    assert.equal(matches.length, 1, method + ' ' + pathname);
    return matches[0].url.searchParams;
  }

  describe('cleanstatusdb', function () {
    it('action[0]: counts devicestatus records on init then reports removal on code()', async function () {
      await withPlugin('cleanstatusdb', {'GET /api/v1/devicestatus.json': [{_id: 'a'}, {_id: 'b'}], 'DELETE /api/v1/devicestatus/*': {ok: true}}, async page => {
        await action(page, 0, 'init');
        assert.equal(await status(page, 'cleanstatusdb'), 'Database contains 2 records');
        assert.equal(await label(page), 'Delete all documents');
        assert.equal(query('GET', '/api/v1/devicestatus.json').get('count'), '500');
        await action(page, 0, 'code');
        assert.equal(await status(page, 'cleanstatusdb'), 'All records removed ...');
        query('DELETE', '/api/v1/devicestatus/*');
      });
    });
    it('action[1]: renders day-input on init then deletes on code()', async function () {
      await withPlugin('cleanstatusdb', {'DELETE /api/v1/devicestatus/': {n: 1}}, async page => {
        await action(page, 1, 'init');
        assert.equal(await status(page, 'cleanstatusdb', 1), '');
        assert.equal(await label(page, 1), 'Delete old documents');
        assert.equal(await page.locator('#admin_devicestatus_days').count(), 1);
        await action(page, 1, 'code');
        assert.equal(await status(page, 'cleanstatusdb', 1), '1 records deleted');
        assert.match(query('DELETE', '/api/v1/devicestatus/').get('find[created_at][$lte]'), /^\d{4}-\d{2}-\d{2}$/);
      });
    });
  });

  describe('futureitems', function () {
    it('action[0]: lists future treatments then reports removal on code()', async function () {
      const id = '5609a9203c8104a8195b1c1e';
      await withPlugin('futureitems', {'GET /api/v1/treatments.json': [{_id: id, eventType: 'Carb Correction', carbs: 3, created_at: '2025-09-28T20:54:00.000Z'}], ['DELETE /api/v1/treatments/' + id]: {ok: true}}, async page => {
        await action(page, 0, 'init');
        assert.equal(await status(page, 'futureitems'), 'Database contains 1 future records');
        assert.equal(await label(page), 'Remove treatments in the future');
        assert.ok(query('GET', '/api/v1/treatments.json').has('find[created_at][$gte]'));
        await action(page, 0, 'code');
        assert.equal(await status(page, 'futureitems'), 'Record ' + id + ' removed ...');
        query('DELETE', '/api/v1/treatments/' + id);
      });
    });
    it('action[0]: renders stored treatment fields as literal text', async function () {
      const treatment = {_id: 'future-treatment', eventType: '<img src=x onerror="window.injected=true">Event', glucose: '<svg onload="window.injected=true">Glucose</svg>', glucoseType: '<script>window.injected=true</script>Type', insulin: '<img src=x onerror="window.injected=true">Insulin', carbs: 'Fish &amp; Chips', enteredBy: '<b>Uploader</b>', notes: '<script>window.injected=true</script>Notes', created_at: '2025-09-28T20:54:00.000Z'};
      await withPlugin('futureitems', {'GET /api/v1/treatments.json': [treatment]}, async page => {
        await action(page, 0, 'init');
        const result = await page.evaluate(() => {
          const table = document.querySelector('#admin_futureitems_0_html table');
          return {cells: Array.from(table.querySelectorAll('tr')[1].querySelectorAll('td'), cell => cell.textContent), unsafe: table.querySelectorAll('img, script, svg, [onerror], [onload]').length, injected: window.injected};
        });
        assert.equal(result.cells.length, 7);
        assert.deepEqual(result.cells.slice(1), [treatment.eventType, treatment.glucose + ' (' + treatment.glucoseType + ')', treatment.insulin, 'Fish & Chips', treatment.enteredBy, treatment.notes]);
        assert.equal(result.unsafe, 0);
        assert.equal(result.injected, undefined);
      });
    });
    it('action[1]: lists future entries then reports removal on code()', async function () {
      const id = '560983f326c5a592d9b9ae0c';
      await withPlugin('futureitems', {'GET /api/v1/entries.json': [{_id: id, date: 1543464149000, sgv: 83}], ['DELETE /api/v1/entries/' + id]: {ok: true}}, async page => {
        await action(page, 1, 'init');
        assert.equal(await status(page, 'futureitems', 1), 'Database contains 1 future records');
        assert.equal(await label(page, 1), 'Remove entries in the future');
        assert.ok(query('GET', '/api/v1/entries.json').has('find[date][$gte]'));
        await action(page, 1, 'code');
        assert.equal(await status(page, 'futureitems', 1), 'Record ' + id + ' removed ...');
        query('DELETE', '/api/v1/entries/' + id);
      });
    });
  });

  for (const [name, collection, field] of [['cleantreatmentsdb', 'treatments', 'created_at'], ['cleanentriesdb', 'entries', 'date']]) {
    describe(name, function () {
      it('action[0]: renders day-input on init then deletes on code()', async function () {
        const pathname = '/api/v1/' + collection + '/';
        await withPlugin(name, {['DELETE ' + pathname]: {n: 1}}, async page => {
          await action(page, 0, 'init');
          assert.equal(await status(page, name), '');
          assert.equal(await label(page), 'Delete old documents');
          await action(page, 0, 'code');
          assert.equal(await status(page, name), '1 records deleted');
          assert.ok(query('DELETE', pathname).has('find[' + field + '][$lte]'));
        });
      });
    });
  }

  describe('daterangedelete admin plugin (TZ aware)', function () {
    const responses = {
      'GET /api/v1/entries.json': [{_id: 'e1', date: 1735689600000, sgv: 100, type: 'sgv'}, {_id: 'e2', date: 1735776000000, sgv: 110, type: 'sgv'}, {_id: 'e3', date: 1735862400000, sgv: 120, type: 'sgv'}],
      'GET /api/v1/treatments.json': [{_id: 't1', created_at: '2025-01-01T00:00:00.000Z', carbs: 10}, {_id: 't2', created_at: '2025-01-02T00:00:00.000Z', carbs: 20}],
      'GET /api/v1/devicestatus.json': [{_id: 'd1', created_at: '2025-01-01T00:00:00.000Z', uploaderBattery: 80}],
      'DELETE /api/v1/entries/*/': {n: 3}, 'DELETE /api/v1/treatments/': {n: 2}, 'DELETE /api/v1/devicestatus/': {n: 1}
    };
    async function dates(page, end = '2025-01-01', start = '2025-01-01') {
      await page.locator('#admin_daterange_collection').selectOption('all');
      await page.locator('#admin_daterange_start').fill(start);
      await page.locator('#admin_daterange_end').fill(end);
    }
    function bounds(params, field, end) {
      const start = '2025-01-01T05:00:00.000Z';
      const finish = end + 'T04:59:59.999Z';
      assert.equal(params.get('find[' + field + '][$gte]'), field === 'date' ? String(Date.parse(start)) : start);
      assert.equal(params.get('find[' + field + '][$lte]'), field === 'date' ? String(Date.parse(finish)) : finish);
    }

    it('should verify that queries respect America/New_York timezone', async function () {
      await withPlugin('daterangedelete', responses, async page => {
        await action(page, 0, 'init');
        await dates(page);
        await page.locator('.daterangePreviewButton').click();
        await page.waitForFunction(() => window.$.active === 0);
        bounds(query('GET', '/api/v1/entries.json'), 'date', '2025-01-02');
        bounds(query('GET', '/api/v1/treatments.json'), 'created_at', '2025-01-02');
      });
    });

    it('should delete matching records from all collections with timezone-aware bounds', async function () {
      await withPlugin('daterangedelete', responses, async page => {
        await action(page, 0, 'init');
        assert.equal(await page.evaluate(() => window.adminFixture.plugin.actions[0].confirmText), undefined);
        await dates(page, '2025-01-02');
        const dialogs = [];
        page.on('dialog', async dialog => { dialogs.push({type: dialog.type(), message: dialog.message()}); await dialog.accept(); });
        await action(page, 0, 'code');
        assert.equal(await page.evaluate(() => window.adminFixture.callbacks), 2);
        assert.equal(dialogs.length, 1);
        assert.equal(dialogs[0].type, 'confirm');
        for (const text of ['ALL collections', '2025-01-01', '2025-01-02']) assert.ok(dialogs[0].message.includes(text));
        assert.equal(requests.filter(request => request.method === 'DELETE').length, 3);
        for (const [pathname, field] of [['/api/v1/entries/*/', 'date'], ['/api/v1/treatments/', 'created_at'], ['/api/v1/devicestatus/', 'created_at']]) {
          const params = query('DELETE', pathname);
          bounds(params, field, '2025-01-03');
          assert.equal(params.get('count'), '100000');
        }
        assert.equal(await status(page, 'daterangedelete'), '6 records deleted total');
      });
    });

    for (const scenario of [
      {day: '2025-03-09', hours: 23, start: '2025-03-09T05:00:00.000Z', end: '2025-03-10T03:59:59.999Z'},
      {day: '2025-11-02', hours: 25, start: '2025-11-02T04:00:00.000Z', end: '2025-11-03T04:59:59.999Z'}
    ]) {
      it('previews the ' + scenario.hours + '-hour New York daylight-saving day with exact bounds', async function () {
        await withPlugin('daterangedelete', responses, async page => {
          await action(page, 0, 'init');
          await dates(page, scenario.day, scenario.day);
          await page.locator('.daterangePreviewButton').click();
          await page.waitForFunction(() => window.$.active === 0);
          for (const [pathname, field] of [['/api/v1/entries.json', 'date'], ['/api/v1/treatments.json', 'created_at'], ['/api/v1/devicestatus.json', 'created_at']]) {
            const params = query('GET', pathname);
            assert.equal(params.get('find[' + field + '][$gte]'), field === 'date' ? String(Date.parse(scenario.start)) : scenario.start);
            assert.equal(params.get('find[' + field + '][$lte]'), field === 'date' ? String(Date.parse(scenario.end)) : scenario.end);
          }
        });
      });
    }

    it('sends no deletion request when the native confirmation is cancelled', async function () {
      await withPlugin('daterangedelete', responses, async page => {
        await action(page, 0, 'init');
        await dates(page, '2025-01-02');
        const dialogs = [];
        page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
        await action(page, 0, 'code');
        assert.deepEqual(dialogs, ['confirm']);
        assert.equal(requests.length, 0);
        assert.equal(await page.evaluate(() => window.adminFixture.callbacks), 2);
        assert.equal(await status(page, 'daterangedelete'), '');
      });
    });

    it('should reject unexpected collection values', async function () {
      await withPlugin('daterangedelete', responses, async page => {
        await action(page, 0, 'init');
        await dates(page, '2025-01-02');
        await page.evaluate(() => document.querySelector('#admin_daterange_collection').append(new Option('Unknown', 'unknown')));
        await page.locator('#admin_daterange_collection').selectOption('unknown');
        await page.locator('.daterangePreviewButton').click();
        assert.equal(requests.length, 0);
        assert.equal(await page.locator('#admin_daterangedelete_info').textContent(), 'Please select a valid collection');
        const dialogs = [];
        page.on('dialog', async dialog => { dialogs.push({type: dialog.type(), message: dialog.message()}); await dialog.dismiss(); });
        await action(page, 0, 'code');
        assert.equal(await page.evaluate(() => window.adminFixture.callbacks), 2);
        assert.deepEqual(dialogs, [{type: 'alert', message: 'Please select a valid collection'}]);
        assert.equal(requests.length, 0);
      });
    });
  });
});
