'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {withPage} = require('./fixture');
const {buildModules} = require('./modules');
const fixture = require('../fixtures/unnamed-profile.json');

describe('Unnamed profile editor in a real browser', function () {
  let server, origin, form, record, writes;
  before(async function () {
    const root = path.resolve(__dirname, '../..');
    form = fs.readFileSync(path.join(root, 'views/profileindex.html'), 'utf8').match(/<form id="pe_form">[\s\S]*?<\/form>/)[0];
    const scripts = new Map(['app', 'profile', 'reports'].map(name => ['/' + name + '.js',
      fs.readFileSync(path.join(root, 'node_modules/.cache/_ns_cache/public/js/bundle.' + name + '.js'))]));
    scripts.set('/modules.js', await buildModules());
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (scripts.has(url.pathname)) {
        res.setHeader('Content-Type', 'application/javascript');
        return res.end(scripts.get(url.pathname));
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/profile.json') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify([record]));
      }
      if (req.method === 'PUT' && url.pathname === '/api/v1/profile/') {
        let body = '';
        for await (const chunk of req) body += chunk;
        writes.push(JSON.parse(body));
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({_id: fixture._id}));
      }
      if (url.pathname === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end('<!doctype html><html><body>' + form + '</body></html>');
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () { if (server) await new Promise(resolve => server.close(resolve)); });

  async function openEditor(run, pointer = '') {
    record = structuredClone(fixture);
    record.defaultProfile = pointer;
    writes = [];
    await withPage(origin, async ({page}) => {
      await page.goto(origin);
      for (const name of ['app', 'profile', 'reports', 'modules']) await page.addScriptTag({url: origin + '/' + name + '.js'});
      await page.evaluate(() => {
        const ctx = {moment: window.moment, timezones: ['UTC']};
        window.alert = () => {};
        window.$.fx.off = true;
        window.Nightscout.client = {
          ctx, headers: () => ({}), init: callback => callback(),
          hashauth: {isAuthenticated: () => true},
          profilefunctions: window.NightscoutTestModules.profilefunctions(null, ctx),
          settings: {customTitle: 'Test', units: 'mmol', timeFormat: 24,
            extendedSettings: {profile: {history: true, multiple: true}}},
          translate: value => value,
          utils: {cloneDeep: value => structuredClone(value), mergeInputTime: (time, date) => date + 'T' + time + ':00Z'}
        };
        window.Nightscout.profileclient();
      });
      await page.waitForFunction(() => window.$.active === 0 && document.querySelector('#pe_profiles').options.length === 2);
      await run(page);
    });
  }

  async function save(page) {
    const before = writes.length;
    await page.locator('#pe_form button').first().click();
    await page.waitForFunction(() => window.$.active === 0 && document.querySelector('#pe_form').style.display !== 'none');
    assert.equal(writes.length, before + 1);
    return writes.at(-1);
  }

  it('loads the unnamed selection and correct values without writing', async function () {
    await openEditor(async page => {
      assert.deepEqual(await page.locator('#pe_profiles option').evaluateAll(options => options.map(option => option.value)), ['', 'Named']);
      assert.equal(await page.locator('#pe_profiles').inputValue(), '');
      assert.equal(await page.locator('#pe_profiles option').first().textContent(), '(unnamed)');
      assert.equal(await page.locator('#pe_dia').inputValue(), '6');
      assert.equal(await page.locator('#pe_basal_val_0').inputValue(), '0.5');
      assert.equal(await page.locator('#pe_isf_val_0').inputValue(), '2.5');
      assert.equal(writes.length, 0);
      assert.deepEqual(record, fixture);
    });
  });
  it('preserves the empty key and settings over repeated unchanged saves', async function () {
    await openEditor(async page => {
      for (let cycle = 0; cycle < 2; cycle++) {
        const saved = await save(page);
        assert.equal(saved.defaultProfile, '');
        assert.deepEqual(Object.keys(saved.store), ['', 'Named']);
        assert.equal(saved.store[''].dia, 6);
        assert.equal(saved.store[''].basal[0].value, 0.5);
        assert.equal(saved.store[''].units, 'mmol');
      }
    });
  });
  it('renames explicitly without overwriting an existing profile', async function () {
    await openEditor(async page => {
      await page.locator('#pe_profile_name').fill('Named');
      const saved = await save(page);
      assert.equal(saved.defaultProfile, 'Named1');
      assert.deepEqual(Object.keys(saved.store), ['Named', 'Named1']);
      assert.equal(saved.store.Named.dia, 5);
      assert.equal(saved.store.Named1.dia, 6);
    });
  });
  it('does not turn a named profile into a blank name', async function () {
    await openEditor(async page => {
      await page.locator('#pe_profile_name').fill('');
      const saved = await save(page);
      assert.equal(saved.defaultProfile, 'Named');
      assert.deepEqual(Object.keys(saved.store), ['', 'Named']);
      assert.equal(saved.store.Named.dia, 5);
    }, 'Named');
  });
  it('keeps both raw profiles in the Profile report', async function () {
    await openEditor(async page => {
      await page.evaluate(fixture => {
        window.$('body').append('<select id="profiles-databaserecords"></select><span id="profiles-default"></span><div id="profiles-chart"></div>');
        const client = window.Nightscout.client;
        client.sbx = {data: {profile: client.profilefunctions}};
        const plugins = window.Nightscout.report_plugins_preinit({language: {translate: value => value}});
        plugins('profiles').report({profiles: [fixture]});
      }, fixture);
      // Browsers insert tbody while parsing tables, unlike the old DOM fixture.
      assert.equal(await page.locator('#profiles-chart > table > tbody > tr > td, #profiles-chart > table > tr > td').count(), 2);
      assert.ok((await page.locator('#profiles-chart').textContent()).includes('Named'));
      assert.equal(writes.length, 0);
    });
  });
  it('requires explicit selection for a dangling default pointer', async function () {
    await openEditor(async page => {
      assert.equal(await page.locator('#pe_form button').first().isDisabled(), true);
      assert.equal(writes.length, 0);
      await page.locator('#pe_profiles').selectOption('');
      assert.equal(await page.locator('#pe_dia').inputValue(), '6');
      assert.equal(await page.locator('#pe_form button').first().isDisabled(), false);
    }, 'Missing');
  });
});
