'use strict';

// Regressions brought in from dev, exercised with modernization's real-browser
// harness instead of restoring the retired jsdom fixtures.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {once} = require('node:events');
const {withPage} = require('./fixture');
const {buildModules} = require('./modules');

describe('dev integration browser regressions', function () {
  let server, origin;
  before(async function () {
    const app = fs.readFileSync(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public/js/bundle.app.js'));
    const modules = await buildModules();
    server = http.createServer((req, res) => {
      if (req.url === '/app.js' || req.url === '/modules.js') {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(req.url === '/app.js' ? app : modules);
      } else res.end('<!doctype html><html><body></body></html>');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
  });
  async function runInBrowser(run) {
    await withPage(origin, async ({page}) => {
      await page.goto(origin);
      await page.addScriptTag({url: origin + '/app.js'});
      await page.addScriptTag({url: origin + '/modules.js'});
      await run(page);
    });
  }

  it('parses valueless query parameters without corrupting access tokens', async function () {
    await runInBrowser(async page => {
      const result = await page.evaluate(() => {
        const utils = window.NightscoutTestModules.browserUtils(window.$);
        return ['', '?token=abc', '?token=abc&units=mmol', '?name=a_b+c', '?token=mom_phone-89e123456789abcd', '?debug', '?token&mute', '?', '?token=abc&', '?token=abc&&mute'].map(search => {
          history.replaceState(null, '', '/' + search);
          return utils.queryParms();
        });
      });
      assert.deepEqual(result, [{}, {token: 'abc'}, {token: 'abc', units: 'mmol'}, {name: 'a_b c'},
        {token: 'mom_phone-89e123456789abcd'}, {debug: ''}, {token: '', mute: ''}, {}, {token: 'abc'}, {token: 'abc', mute: ''}]);
    });
  });

  for (const scenario of ['empty', 'pending', 'failed', 'unset', 'save', 'existing']) {
    it('preserves profile loading and save safeguards: ' + scenario, async function () {
      await runInBrowser(async page => {
        const result = await page.evaluate(scenario => {
          const $ = window.$;
          $.fx.off = true;
          document.body.innerHTML = '<form id="pe_form"><button type="submit">Save</button>' +
            '<span class="pe_status"></span><select id="pe_profiles"></select><select id="pe_timezone"></select>' +
            '<select id="pe_databaserecords"></select>' +
            ['pe_time', 'pe_date', 'pe_profile_name', 'pe_dia', 'pe_hr'].map(id => '<input id="' + id + '">').join('') +
            ['pe_basal_placeholder', 'pe_ic_placeholder', 'pe_isf_placeholder', 'pe_targetbg_placeholder'].map(id => '<div id="' + id + '"></div>').join('') + '</form>';
          const writes = [], alerts = [];
          window.alert = message => alerts.push(message);
          const client = window.Nightscout.client = {
            ctx: {moment: window.moment, timezones: ['UTC']},
            headers: () => ({}), init: callback => callback(),
            hashauth: {isAuthenticated: () => true},
            profilefunctions: window.NightscoutTestModules.profilefunctions(null, {moment: window.moment}),
            settings: {customTitle: 'Test', units: 'mg/dl', timeFormat: 24, extendedSettings: {profile: {history: true, multiple: true}}},
            translate: value => value,
            utils: {cloneDeep: value => JSON.parse(JSON.stringify(value)), mergeInputTime: (time, date) => date + 'T' + time + ':00Z'}
          };
          let response;
          $.ajax = (url, options) => {
            if (typeof url === 'object') {
              writes.push(JSON.parse(url.data));
              return $.Deferred().promise();
            }
            response = $.Deferred();
            response.done(options.success).fail(options.error);
            return response.promise();
          };
          window.NightscoutTestModules.profileeditor();
          const submit = $.Event('submit');
          $('#pe_form').trigger(submit);
          const pending = {enabled: $('#pe_form :input:enabled').length, prevented: submit.isDefaultPrevented()};
          if (scenario === 'failed') response.reject();
          else if (scenario === 'existing') {
            // An existing record is deliberately different from the defaults.
            const profile = {dia: 5, carbratio: [{time: '00:00', value: 10}], sens: [{time: '00:00', value: 50}],
              basal: [{time: '00:00', value: 1}], target_low: [{time: '00:00', value: 90}], target_high: [{time: '00:00', value: 110}], timezone: 'UTC'};
            response.resolve([{defaultProfile: 'Existing', store: {Existing: profile}, startDate: '2026-01-01T00:00:00Z'}]);
          } else response.resolve([]);
          if (scenario === 'unset') $('#pe_dia').val('');
          if (['failed', 'unset', 'save', 'existing'].includes(scenario)) $('#pe_form button').trigger('click');
          const failedSubmit = $.Event('submit');
          if (scenario === 'failed') $('#pe_form').trigger(failedSubmit);
          return {pending, writes, alerts, status: $('.pe_status').text(), dia: $('#pe_dia').val(),
            enabled: $('#pe_form :input:enabled').length, options: $('#pe_profiles option').length,
            ranges: $('#pe_basal_val_0').length, prevented: failedSubmit.isDefaultPrevented(),
            hasData: client.profilefunctions.hasData()};
        }, scenario);
        assert.deepEqual(result.pending, {enabled: 0, prevented: true});
        if (scenario === 'failed') {
          assert.equal(result.status, 'Your profile could not be loaded. Reload before editing.');
          assert.equal(result.dia, '');
          assert.equal(result.enabled + result.options + result.ranges + result.writes.length, 0);
          assert.equal(result.prevented, true);
          assert.deepEqual(result.alerts, []);
        } else if (scenario === 'unset') {
          assert.equal(result.writes.length, 0);
          assert.deepEqual(result.alerts, ['Enter every profile value before saving.']);
        } else if (scenario === 'save' || scenario === 'existing') {
          assert.equal(result.writes.length, 1);
          assert.deepEqual(result.alerts, []);
          assert.equal(result.writes[0].store[scenario === 'existing' ? 'Existing' : 'Default'].dia, scenario === 'existing' ? 5 : 3);
        } else {
          assert.equal(result.status, 'Default values used.');
          assert.equal(result.dia, '3');
          assert.ok(result.enabled > 0);
          assert.equal(result.writes.length, 0);
        }
      });
    });
  }

  for (const scenario of ['filter', 'first', 'last', 'hidden', 'order', 'empty']) {
    it('preserves quick-pick record identity and ordering: ' + scenario, async function () {
      await runInBrowser(async page => {
        const result = await page.evaluate(scenario => {
          const $ = window.$;
          document.body.innerHTML = '<select id="bc_quickpick"></select>';
          const resolved = [];
          function pick(name, carbs, extra) {
            const record = Object.assign({_id: name, type: 'quickpick', name, carbs, position: carbs}, extra);
            Object.defineProperty(record, 'foods', {get() {resolved.push(name); return [{name, carbs, portion: 1, portions: 1}];}});
            return record;
          }
          let food = [{type: 'food', name: 'Apple', carbs: 12}, pick('Breakfast', 45), pick('Lunch', 70)];
          if (scenario === 'hidden') food = [pick('Visible', 10), pick('HiddenBoolean', 20, {hidden: true}), pick('HiddenString', 30, {hidden: 'true'}), pick('NotHiddenString', 40, {hidden: 'false'}), pick('NoFlagAtAll', 50)];
          if (scenario === 'order') food = [pick('Tenth', 1, {position: '10'}), pick('Second', 2, {position: 2}), pick('First', 3, {position: '1'})];
          if (scenario === 'empty') food = [];
          const client = {translate: value => value, plugins: () => ({}), settings: {enable: [], extendedSettings: {}, units: 'mg/dl'}, sbx: {data: {food}}, ctx: {moment: window.moment}, utils: {}, headers: () => ({})};
          const calc = window.NightscoutTestModules.boluscalc(client, $);
          calc.calculateInsulin = () => {};
          calc.loadFoodQuickpicks();
          const options = () => $('#bc_quickpick option').toArray().map(o => ({value: o.value, label: o.textContent}));
          if (scenario === 'first' || scenario === 'last') {
            const name = scenario === 'first' ? 'Breakfast' : 'Lunch';
            $('#bc_quickpick').val(options().find(o => o.label.startsWith(name)).value).trigger('change');
          }
          if (scenario === 'empty') {delete client.sbx.data.food; calc.loadFoodQuickpicks();}
          return {labels: options().map(o => o.label), resolved: [...new Set(resolved)]};
        }, scenario);
        const expected = scenario === 'hidden' ? ['(none)', 'Visible (10 g)', 'NotHiddenString (40 g)', 'NoFlagAtAll (50 g)'] :
          scenario === 'order' ? ['(none)', 'First (3 g)', 'Second (2 g)', 'Tenth (1 g)'] :
          scenario === 'empty' ? ['(none)'] : ['(none)', 'Breakfast (45 g)', 'Lunch (70 g)'];
        assert.deepEqual(result.labels, expected);
        if (scenario === 'first' || scenario === 'last') assert.deepEqual(result.resolved, [scenario === 'first' ? 'Breakfast' : 'Lunch']);
      });
    });
  }

  it('keeps zero-height chart geometry nonnegative and recovers after layout', async function () {
    await runInBrowser(async page => {
      const result = await page.evaluate(() => {
        const client = window.NightscoutTestModules.makeChart(window.d3, window);
        const element = document.querySelector('#chartContainer');
        element.getBoundingClientRect = () => ({width: 900, height: 0});
        client.chart.update(false);
        const zero = [client.chart.contextHeight, client.chart.focusHeight, +client.chart.theBrush.selectAll('rect').attr('height')];
        element.getBoundingClientRect = () => ({width: 900, height: 600});
        client.chart.update(false);
        return {zero, measured: [client.chart.focusHeight, client.chart.contextHeight]};
      });
      assert.ok(result.zero.every(value => value >= 0));
      assert.deepEqual(result.measured, [(600 - 30) * .7, (600 - 30) * .3]);
    });
  });

  it('switches native and custom pill tooltips without retaining handlers', async function () {
    await runInBrowser(async page => {
      const result = await page.evaluate(() => {
        const $ = window.$;
        const container = $('<div>').appendTo('body');
        const tooltip = $('<div>').appendTo(container);
        const base = window.NightscoutTestModules.pluginbase(container, container, container, container, window.d3.select(tooltip[0]), null, value => 'translated ' + value);
        const plugin = {name: 'delta', label: 'BG Delta'};
        base.updatePillText(plugin, {label: 'mg/dl', value: 5});
        const pill = container.find('.delta');
        const title = pill.attr('title');
        base.updatePillText(plugin, {label: 'mg/dl', value: 5, info: [{label: 'Device', value: 'CGM'}]});
        const removed = !pill.attr('title');
        pill.trigger($.Event('mouseover', {pageX: 0, pageY: 0}));
        const text = tooltip.text();
        base.updatePillText(plugin, {label: 'mg/dl', value: 6});
        pill.trigger('mouseover');
        const hidden = tooltip.css('display') === 'none';
        base.updatePillText({name: 'unlabelled'}, {label: 'X', value: 1});
        return {title, removed, text, hidden, fallback: container.find('.unlabelled').attr('title')};
      });
      assert.deepEqual(result, {title: 'translated BG Delta', removed: true, text: 'Device CGM', hidden: true, fallback: 'translated unlabelled'});
    });
  });
});
