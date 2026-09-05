'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {withPage} = require('./fixture');
const {buildModules} = require('./modules');

const profileNames = ['A&B', 'A&amp;B', '"><img src=x onerror="window.profileInjected=true">Unsafe'];
function makeProfile() {
  return {
    dia: 3, carbratio: [{time: '00:00', value: 10}], carbs_hr: 20, delay: 20,
    sens: [{time: '00:00', value: 50}], timezone: 'UTC', perGIvalues: false,
    carbs_hr_high: 30, carbs_hr_medium: 30, carbs_hr_low: 30,
    delay_high: 15, delay_medium: 20, delay_low: 20,
    basal: [{time: '00:00', value: 1}], target_low: [{time: '00:00', value: 90}],
    target_high: [{time: '00:00', value: 110}], startDate: '2025-01-01T00:00:00.000Z'
  };
}

describe('profile and settings components in a real browser', function () {
  let server, origin, html, records, requests;
  before(async function () {
    const app = fs.readFileSync(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public/js/bundle.app.js'));
    const modules = await buildModules();
    server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/bundle.js' || url.pathname === '/modules.js') {
        response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        response.end(url.pathname === '/bundle.js' ? app : modules);
      } else if (url.pathname === '/api/v1/profile.json') {
        requests.push({method: request.method, url});
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify(records));
      } else if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><html><head><meta charset="utf-8"></head><body>' + html + '</body></html>');
      } else response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  async function withProfile(markup, run, profileRecords = []) {
    html = markup;
    records = profileRecords;
    requests = [];
    await withPage(origin, async ({page}) => {
      await page.goto(origin);
      await page.addScriptTag({url: origin + '/bundle.js'});
      await page.addScriptTag({url: origin + '/modules.js'});
      await page.evaluate(({names, profile}) => {
        window.profileFixture = {names, profile, scripts: Array.from(document.scripts)};
      }, {names: profileNames, profile: makeProfile()});
      await run(page);
    });
  }

  async function assertOptions(page, selector, offset = 0) {
    const result = await page.evaluate(({selector}) => {
      const select = document.querySelector(selector);
      return {
        values: Array.from(select.options, option => option.value),
        labels: Array.from(select.options, option => option.textContent),
        unsafe: Array.from(document.querySelectorAll('script,[onerror],[onload]'))
          .filter(element => !window.profileFixture.scripts.includes(element)).length,
        injected: window.profileInjected
      };
    }, {selector});
    assert.equal(result.values.length, profileNames.length + offset);
    if (offset) assert.equal(result.values[0], '');
    assert.deepEqual(result.values.slice(offset), profileNames);
    assert.deepEqual(result.labels.slice(offset), ['A&B', 'A&B', profileNames[2]]);
    assert.equal(result.unsafe, 0);
    assert.equal(result.injected, undefined);
  }

  async function assertSelectableNames(page, selector) {
    // A&B and A&amp;B intentionally share a label but are distinct stored keys.
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const name of profileNames) {
        await page.locator(selector).selectOption(name);
        assert.equal(await page.locator(selector).inputValue(), name);
        await assertOptions(page, selector);
      }
    }
  }

  describe('profile-derived browser sinks', function () {
    it('keeps care portal profile option values exact while rendering names as text', async function () {
      await withProfile('<select id="profile"></select>', async page => {
        await page.evaluate(() => {
          const names = window.profileFixture.names;
          const client = {
            authorized: false, ctx: {moment: window.moment}, plugins: {getAllEventTypes: () => []},
            profilefunctions: {activeProfileToTime: () => names[0], listBasalProfiles: () => names},
            settings: {units: 'mg/dl'}, translate: value => value, utils: {}
          };
          window.NightscoutTestModules.careportal(client, window.$).prepare();
        });
        await assertOptions(page, '#profile');
        assert.equal(await page.locator('#profile').inputValue(), profileNames[0]);
        await assertSelectableNames(page, '#profile');
      });
    });

    it('keeps bolus calculator profile option values exact while rendering names as text', async function () {
      await withProfile('<select id="bc_profile"></select><div id="bc_profileLabel"></div>', async page => {
        await page.evaluate(() => {
          const names = window.profileFixture.names;
          const client = {
            browserUtils: {}, ctx: {moment: window.moment}, entries: [], plugins: () => ({}),
            profilefunctions: {activeProfileToTime: () => names[0], listBasalProfiles: () => names},
            sbx: {data: {food: []}}, settings: {enable: ['profile'], extendedSettings: {profile: {multiple: true}}, units: 'mg/dl'},
            translate: value => value, utils: {}
          };
          const calculator = window.NightscoutTestModules.boluscalc(client, window.$);
          calculator.eventTimeTypeChange = () => {};
          calculator.updateVisualisations = () => {};
          calculator.calculateInsulin = () => {};
          calculator.prepare();
        });
        await assertOptions(page, '#bc_profile');
        assert.equal(await page.locator('#bc_profile').inputValue(), profileNames[0]);
        await assertSelectableNames(page, '#bc_profile');
      });
    });

    it('renders profile report names and values as text', async function () {
      await withProfile('<select id="profiles-databaserecords"></select><span id="profiles-default"></span><div id="profiles-chart"></div>', async page => {
        const unsafeTime = '<svg onload="window.profileInjected=true">00:00</svg>';
        await page.evaluate(unsafeTime => {
          const {names, profile} = window.profileFixture;
          profile.units = 'Fish &amp; Chips &lt; 70';
          profile.basal[0].time = unsafeTime;
          window.Nightscout.client = {sbx: {data: {profile: {applyTimezone: value => value}}}, translate: value => value};
          const plugins = window.Nightscout.report_plugins_preinit({language: {translate: value => value}});
          plugins('profiles').report({profiles: [{defaultProfile: 'A&amp;B', startDate: '2025-01-01T00:00:00.000Z', store: {[names[2]]: profile}}]});
        }, unsafeTime);
        assert.equal(await page.locator('#profiles-default').textContent(), 'A&B');
        assert.equal(await page.locator('#profiles-chart b').first().textContent(), profileNames[2]);
        const text = await page.locator('#profiles-chart').textContent();
        assert.ok(text.includes('Fish & Chips < 70'));
        assert.ok(text.includes(unsafeTime));
        assert.equal(await page.locator('#profiles-chart img, #profiles-chart svg, #profiles-chart script, #profiles-chart [onerror]').count(), 0);
        assert.equal(await page.evaluate(() => window.profileInjected), undefined);
      });
    });

    it('renders loopalyzer profile names and range times as text', async function () {
      await withProfile('<div id="loopalyzer-profiles"></div>', async page => {
        const unsafeTime = '<img src=x onerror="window.profileInjected=true">00:00';
        await page.evaluate(unsafeTime => {
          const {names, profile} = window.profileFixture;
          profile.basal[0].time = unsafeTime;
          const client = {sbx: {data: {profile: {
            applyTimezone: value => window.moment.utc(value), parseInTimezone: value => window.moment.utc(value)
          }}}, translate: value => value};
          window.Nightscout.client = client;
          const plugins = window.Nightscout.report_plugins_preinit({language: {translate: client.translate}});
          plugins('loopalyzer').renderProfilesTable([{startDate: '2024-12-31T00:00:00.000Z', store: {[names[2]]: profile}}], ['2025-01-01'], client);
        }, unsafeTime);
        assert.ok((await page.locator('#loopalyzer-profiles-table caption').first().textContent()).startsWith(profileNames[2]));
        assert.ok((await page.locator('#loopalyzer-profiles-table').textContent()).includes(unsafeTime));
        assert.equal(await page.locator('#loopalyzer-profiles-table img, #loopalyzer-profiles-table script, #loopalyzer-profiles-table [onerror]').count(), 0);
        assert.equal(await page.evaluate(() => window.profileInjected), undefined);
      });
    });

    it('keeps treatment editor profile option values exact while rendering names as text', async function () {
      await withProfile('', async page => {
        await page.evaluate(() => {
          const client = {
            careportal: {events: [], resolveEventName: value => value},
            profilefunctions: {listBasalProfiles: () => window.profileFixture.names},
            sbx: {data: {profile: {applyTimezone: value => value, parseInTimezone: value => window.moment(value)}}},
            settings: {timeFormat: 24, units: 'mg/dl'}, translate: value => value, utils: {}
          };
          const Nightscout = window.Nightscout;
          Nightscout.client = client;
          Nightscout.report_plugins = Nightscout.report_plugins_preinit({language: {translate: client.translate}});
          const plugin = Nightscout.report_plugins('treatments');
          window.$('body').append(plugin.html(client));
          plugin.report({'2025-01-01': {treatments: [{_id: 'treatment-id', created_at: '2025-01-01T00:00:00.000Z', eventType: 'Note'}]}}, ['2025-01-01'], {order: 'oldest', units: 'mg/dl'});
        });
        await page.locator('.editTreatment').click();
        await assertOptions(page, '#rped_profile', 1);
        assert.equal(await page.locator('.ui-dialog:visible').count(), 1);
      });
    });

    it('keeps profile editor option values exact while rendering names as text', async function () {
      const store = Object.fromEntries(profileNames.map(name => [name, makeProfile()]));
      const record = {defaultProfile: profileNames[0], startDate: '2025-01-01T00:00:00.000Z', store};
      const template = fs.readFileSync(path.resolve(__dirname, '../../views/profileindex.html'), 'utf8');
      const form = template.match(/<form id="pe_form">[\s\S]*?<\/form>/)?.[0];
      assert.ok(form, 'Production profile form is present');
      await withProfile(form, async page => {
        await page.evaluate(() => {
          const ctx = {moment: window.moment, timezones: ['UTC'], settings: {units: 'mg/dl'}, language: {translate: value => value}};
          const client = {
            ctx, headers: () => ({}), init: callback => callback(),
            profilefunctions: {data: [], loadData(records) {this.data = records;}},
            settings: {customTitle: 'Nightscout', extendedSettings: {profile: {history: true, multiple: true}}, timeFormat: 24, units: 'mg/dl'},
            translate: value => value, utils: window.NightscoutTestModules.utils(ctx)
          };
          window.Nightscout.client = client;
          window.Nightscout.profileclient();
        });
        await page.waitForFunction(() => window.$.active === 0 && document.querySelector('#pe_profiles').options.length === 3);
        await assertOptions(page, '#pe_profiles');
        assert.equal(await page.locator('#pe_profiles').inputValue(), profileNames[0]);
        await assertSelectableNames(page, '#pe_profiles');
        assert.equal(requests.length, 1);
        assert.equal(requests[0].method, 'GET');
        assert.equal(requests[0].url.pathname, '/api/v1/profile.json');
        assert.equal(requests[0].url.searchParams.get('count'), '20');
      }, [record]);
    });
  });

  describe('browser settings', function () {
    it('sorts bolus render-over options numerically in descending order', async function () {
      await withProfile('<select id="bolusRenderOver"></select><select id="bolusRenderFormat"></select><select id="bolusRenderFormatSmall"></select>', async page => {
        await page.evaluate(() => {
          const translate = (text, options) => options?.params ? text.replace('%1', options.params[0]) : text;
          const client = {browserUtils: {reload: () => {}}, language: {languages: [], translate}, plugins: {specialPlugins: [], eachEnabledPlugin: () => {}}, translate, utils: {scaleMgdl: value => value}};
          const serverSettings = {settings: {enable: 'bolus', showPlugins: 'bolus', thresholds: {bgHigh: 260, bgTargetTop: 180, bgTargetBottom: 80, bgLow: 55}, units: 'mg/dl'}, extendedSettings: {bolus: {renderOver: 10, renderFormat: 'default', renderFormatSmall: 'default'}}};
          const browserSettings = window.NightscoutTestModules.browserSettings;
          client.settings = browserSettings(client, serverSettings, window.$);
          browserSettings.loadAndWireForm();
        });
        assert.deepEqual(await page.locator('#bolusRenderOver option').evaluateAll(options => options.map(option => Number(option.value))), [10, 5, 1, 0.5, 0.1]);
        assert.equal(await page.locator('#bolusRenderOver').inputValue(), '10');
      });
    });
  });
});
