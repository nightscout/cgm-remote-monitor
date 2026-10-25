'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {withPage} = require('./fixture');
const {buildModules} = require('./modules');

describe('stored-data browser output encoding in a real browser', function () {
  let server, origin, html, requests;
  before(async function () {
    const app = fs.readFileSync(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public/js/bundle.app.js'));
    const modules = await buildModules();
    const css = fs.readFileSync(path.resolve(__dirname, '../../static/css/main.css'), 'utf8')
      .replace("@import url('https://fonts.googleapis.com/css?family=Ubuntu:400,700');", '');
    server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/bundle.js' || url.pathname === '/modules.js') {
        response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        response.end(url.pathname === '/bundle.js' ? app : modules);
      } else if (url.pathname === '/main.css') {
        response.setHeader('Content-Type', 'text/css; charset=utf-8'); response.end(css);
      } else if (url.pathname === '/api/v1/adminnotifies') {
        requests.push({method: request.method, path: url.pathname});
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({message: {notifies: [{
          title: '<img src=x onerror="window.injected=true">Title',
          message: 'Fish &amp; Chips <script>window.injected=true</script>Message',
          count: 1, lastRecorded: Date.now(), persistent: true
        }], notifyCount: 1}}));
      } else if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><html><head><meta charset="utf-8"></head><body>' + html + '</body></html>');
      } else response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  async function withSink(markup, run, chart = false) {
    html = markup; requests = [];
    await withPage(origin, async ({page}) => {
      await page.goto(origin);
      await page.addScriptTag({url: origin + '/bundle.js'});
      await page.addScriptTag({url: origin + '/modules.js'});
      if (chart) await page.addStyleTag({url: origin + '/main.css'});
      await page.evaluate(chart => {
        function translate(value, options) {
          return options?.params ? options.params.reduce((text, param, index) => text.replace('%' + (index + 1), param), value) : value;
        }
        const plugins = window.Nightscout.report_plugins_preinit({language: {translate}});
        plugins.utils.localeDate = value => value;
        window.Nightscout.report_plugins = plugins;
        window.sinkFixture = {plugins, scripts: Array.from(document.scripts)};
        window.sinkFixture.reportClient = () => ({
          careportal: {resolveEventName: value => value}, profilefunctions: {listBasalProfiles: () => []},
          sbx: {data: {profile: {applyTimezone: value => window.moment(value)}}},
          settings: {timeFormat: 24, units: 'mg/dl'}, translate, utils: {}
        });
        if (chart) window.sinkFixture.client = window.NightscoutTestModules.makeChart(window.d3, window);
      }, chart);
      await run(page);
      assert.equal(await page.evaluate(() => window.injected), undefined);
    });
  }

  it('renders legacy treatment report fields as literal text', async function () {
    await withSink('', async page => {
      const result = await page.evaluate(() => {
        const $ = window.$, client = window.sinkFixture.reportClient();
        window.Nightscout.client = client;
        const plugin = window.sinkFixture.plugins('treatments');
        $('body').append(plugin.html(client));
        plugin.report({'2025-01-01': {treatments: [{
          _id: 'legacy-treatment', created_at: '2025-01-01T00:00:00.000Z',
          eventType: '<img src=x onerror="window.injected=true">Event', reason: '<script>window.injected=true</script>Reason',
          glucose: 'Fish &amp; Chips', glucoseType: '<svg onload="window.injected=true">Type</svg>',
          carbs: '<img src=x onerror="window.injected=true">Carbs', foodType: 'Food &amp; More',
          protein: '<b>Protein</b>', fat: '<i>Fat</i>', percent: '<u>Percent</u>', profile: 'A&amp;B',
          enteredBy: '<em>Uploader</em>', notes: '<script>window.injected=true</script>Notes'
        }, {_id: 'legacy-treatment-without-glucose-type', created_at: '2025-01-01T00:01:00.000Z', glucose: 100}]}},
        ['2025-01-01'], {order: 'oldest', units: 'mg/dl'});
        return {cells: $('#treatments-report tr.border_bottom td').map(function () {return this.textContent;}).get(),
          secondGlucose: $('#treatments-report tr.border_bottom').eq(1).find('td').eq(3).text(),
          unsafe: $('#treatments-report').find('script,svg,[onerror],[onload],img[src="x"]').length};
      });
      assert.ok(result.cells[2].includes('<img src=x onerror="window.injected=true">Event'));
      assert.ok(result.cells[2].includes('<script>window.injected=true</script>Reason'));
      for (const [index, expected] of [[3, 'Fish & Chips (<svg onload="window.injected=true">Type</svg>)'],
        [5, '<img src=x onerror="window.injected=true">Carbs Food & More'], [6, '<b>Protein</b>'], [7, '<i>Fat</i>'],
        [9, '<u>Percent</u>'], [11, 'A&B'], [12, '<em>Uploader</em>'], [13, '<script>window.injected=true</script>Notes']]) {
        assert.equal(result.cells[index], expected);
      }
      assert.equal(result.secondGlucose, '100'); assert.equal(result.unsafe, 0);
    });
  });

  it('filters treatment report rows without retaining empty day headings', async function () {
    await withSink('', async page => {
      await page.evaluate(() => {
        const $ = window.$, client = window.sinkFixture.reportClient(), plugin = window.sinkFixture.plugins('treatments');
        window.Nightscout.client = client; $('body').append(plugin.html(client));
        const data = {'2025-01-01': {treatments: [
          {_id: 'exercise-1', created_at: '2025-01-01T01:00:00.000Z', eventType: 'Exercise'},
          {_id: 'exercise-2', created_at: '2025-01-01T02:00:00.000Z', eventType: 'Exercise'},
          {_id: 'untyped', created_at: '2025-01-01T03:00:00.000Z'}
        ]}, '2025-01-02': {treatments: [{_id: 'note', created_at: '2025-01-02T01:00:00.000Z', eventType: 'Note &amp; More'}]}};
        window.sinkFixture.data = data;
        plugin.report(data, ['2025-01-01', '2025-01-02'], {order: 'oldest', units: 'mg/dl'});
      });
      const rows = () => page.locator('#treatments-report tr.border_bottom').count();
      const headings = () => page.locator('#treatments-report td[colspan="12"]').allTextContents();
      assert.equal(await rows(), 4); assert.equal((await headings()).length, 2);
      assert.equal(await page.locator('#treatments-eventtype option').count(), 4);
      assert.equal((await page.locator('#treatments-eventtype option').allTextContents()).filter(text => text === 'Note & More (1)').length, 1);
      assert.equal(await page.locator('#treatments-report .recordcount').textContent(), 'Showing 4 of 4 records');
      await page.locator('#treatments-eventtype').selectOption('Exercise');
      assert.equal(await rows(), 2); assert.deepEqual(await headings(), ['2025-01-01']);
      assert.equal(await page.locator('#treatments-report .recordcount').textContent(), 'Showing 2 of 4 records');
      await page.locator('#treatments-eventtype').selectOption({label: '(none) (1)'});
      assert.equal(await rows(), 1); assert.deepEqual(await headings(), ['2025-01-01']);
      await page.locator('#treatments-eventtype').selectOption('Exercise');
      await page.evaluate(() => window.sinkFixture.plugins('treatments').report(
        {'2025-01-02': window.sinkFixture.data['2025-01-02']}, ['2025-01-02'], {order: 'oldest', units: 'mg/dl'}));
      assert.equal(await page.locator('#treatments-eventtype').inputValue(), '\u0000all');
      assert.equal(await rows(), 1);
      assert.equal(await page.locator('#treatments-report .recordcount').textContent(), 'Showing 1 of 1 records');
    });
  });

  it('renders admin notification fields as literal text', async function () {
    await withSink('<button id="adminnotifies"></button><div id="adminNotifiesDrawer"></div>', async page => {
      await page.evaluate(() => {
        const client = {headers: () => ({}), translate: value => value};
        window.sinkFixture.notifies = window.NightscoutTestModules.adminnotifies(client, window.$);
      });
      await page.waitForFunction(() => window.$.active === 0 && window.sinkFixture.notifies.notifyCount === 1);
      for (let cycle = 0; cycle < 2; cycle++) {
        await page.evaluate(() => window.sinkFixture.notifies.prepare());
        assert.equal(await page.locator('#adminNotifiesDrawer b').last().textContent(), '<img src=x onerror="window.injected=true">Title');
        assert.equal(await page.locator('#adminNotifiesDrawer .adminNotifyMessage').textContent(), 'Fish & Chips <script>window.injected=true</script>Message');
        assert.equal(await page.locator('#adminNotifiesDrawer img,#adminNotifiesDrawer script,#adminNotifiesDrawer svg,#adminNotifiesDrawer [onerror],#adminNotifiesDrawer [onload]').count(), 0);
      }
      assert.deepEqual(requests, [{method: 'GET', path: '/api/v1/adminnotifies'}]);
    });
  });

  it('encodes legacy treatment glucose in the chart tooltip', async function () {
    await withSink('', async page => {
      const result = await page.evaluate(() => {
        const client = window.sinkFixture.client;
        client.editMode = false;
        client.renderer.drawTreatment({carbs: 10, eventType: 'Meal Bolus', mgdl: 100,
          glucose: '<img src=x onerror="window.injected=true">Fish &amp; Chips', mills: client.now},
        {scale: 2, showLabels: false, treatments: 1}, 10, {});
        client.chart.focus.select('.draggable-treatment').node().dispatchEvent(new MouseEvent('mouseover', {bubbles: true, clientX: 10, clientY: 10}));
        return {text: client.tooltip.text(), unsafe: client.tooltip.selectAll('img,script,svg,[onerror],[onload]').size()};
      });
      assert.ok(result.text.includes('<img src=x onerror="window.injected=true">Fish & Chips'));
      assert.equal(result.unsafe, 0);
    }, true);
  });

  it('renders stored annotations as literal text in chart tooltips', async function () {
    await withSink('', async page => {
      const result = await page.evaluate(() => {
        const client = window.sinkFixture.client;
        client.ddata.tempTargetTreatments = [];
        client.ddata.treatments = [{_id: 'legacy-tooltip-record', eventType: 'Note',
          enteredBy: '<svg onload="window.injected=true">Uploader</svg>', mills: client.now,
          notes: '<img src=x onerror="window.injected=true">&amp;Notes'}];
        client.renderer.addTreatmentCircles(new Date(client.now));
        client.chart.focus.select('.treatment-dot').node().dispatchEvent(new MouseEvent('mouseover', {bubbles: true, clientX: 10, clientY: 10}));
        return {text: client.tooltip.text(), unsafe: client.tooltip.selectAll('img,script,svg,[onerror],[onload]').size()};
      });
      assert.ok(result.text.includes('<svg onload="window.injected=true">Uploader</svg>'));
      assert.ok(result.text.includes('<img src=x onerror="window.injected=true">&Notes'));
      assert.equal(result.unsafe, 0);
    }, true);
  });

  it('renders stored annotations as literal SVG text in the day-to-day report', async function () {
    await withSink('<div id="daytodaycharts"></div>', async page => {
      const result = await page.evaluate(() => {
        const d3 = window.d3, moment = window.moment, day = '2025-01-01', firstTime = Date.parse(day + 'T00:00:00.000Z');
        const rawPayload = '<img src=x onerror="window.injected=true">Notes', encodedPayload = '&lt;img src=x onerror="window.injected=true"&gt;Notes';
        const profile = {applyTimezone: value => moment.utc(value), loadData: () => {}, parseInTimezone: value => moment.utc(value), updateTreatments: () => {}};
        const client = {plugins: () => ({isDeviceStatusAvailable: () => false}), profilefunctions: {activeProfileToTime: () => ''},
          sbx: {data: {profile}}, settings: {timeFormat: 24}, ticks: () => [], tooltip: d3.select('body').append('div'),
          translate: value => value, utils: {scaleMgdl: value => value, roundBGForDisplay: value => value}};
        window.Nightscout.client = client; window.Nightscout.predictions.offset = 0;
        window.sinkFixture.plugins.utils.scaledTreatmentBG = () => 100;
        const data = {alldays: 1, combobolusTreatments: [], devicestatus: [], profiles: [], profileSwitchTreatments: [], tempbasalTreatments: [], treatments: []};
        data[day] = {dailyCarbs: 0, dailyFat: 0, dailyProtein: 0, devicestatus: [], sgv: [
          {color: 'green', date: new Date(firstTime), mills: firstTime, sgv: 100, type: 'sgv', openaps: {suggested: {bg: 100, reason: rawPayload}}},
          {color: 'green', date: new Date(firstTime + 60000), mills: firstTime + 60000, sgv: 110, type: 'sgv'}
        ], treatments: [
          {_id: 'raw', eventType: 'Note', mills: firstTime + 10000, notes: rawPayload},
          {_id: 'encoded', eventType: 'Note', mills: firstTime + 20000, notes: encodedPayload},
          {_id: 'food', eventType: 'Meal Bolus', mills: firstTime + 30000, carbs: 10, foodType: 'Fish &amp; Chips'}
        ]};
        window.sinkFixture.plugins('daytoday').report(data, [day], {basal: false, bgcheck: false, carbs: true, cob: false,
          food: false, height: 250, insulin: false, insulindistribution: false, iob: false, maxCarbsValue: 20,
          maxDailyCarbsValue: 1, maxInsulinValue: 1, notes: true, openAps: true, othertreatments: false,
          predicted: false, raw: false, scale: 'linear', targetHigh: 180, targetLow: 80, width: 800});
        const dot = document.querySelector('#daytodaycharts circle');
        dot.dispatchEvent(new MouseEvent('mouseover', {bubbles: true, clientX: 120, clientY: 80}));
        const result = {hover: client.tooltip.text(), left: client.tooltip.style('left'), top: client.tooltip.style('top'),
          tooltipUnsafe: client.tooltip.selectAll('img,script').size(), texts: Array.from(document.querySelectorAll('#daytodaycharts svg text'), node => node.textContent),
          unsafe: window.$('#daytodaycharts').find('img,script,svg svg,[onerror],[onload]').length};
        dot.dispatchEvent(new MouseEvent('mouseout', {bubbles: true})); result.out = client.tooltip.style('display');
        return result;
      });
      const raw = '<img src=x onerror="window.injected=true">Notes';
      assert.ok(result.hover.includes(raw)); assert.equal(result.left, '120px'); assert.equal(result.top, '95px');
      assert.equal(result.tooltipUnsafe, 0); assert.equal(result.out, 'none');
      assert.equal(result.texts.filter(text => text === raw).length, 2);
      assert.ok(result.texts.includes(' 10 g Fish & Chips')); assert.equal(result.unsafe, 0);
    });
  });

  it('builds food quick-pick options without parsing their labels', async function () {
    await withSink('<select id="bc_quickpick"></select><select id="bc_filter_category"></select><select id="bc_filter_subcategory"></select><select id="bc_data"></select><input id="bc_filter_name"><input id="bc_addportions">', async page => {
      const result = await page.evaluate(() => {
        const $ = window.$, originalMap = Array.prototype.map;
        const client = {ctx: {moment: window.moment}, plugins: () => ({}), translate: value => value,
          sbx: {data: {food: [{type: 'quickpick', name: '<img src=x onerror="window.injected=true">Fish &amp; Chips', carbs: 10},
            {type: 'food', category: '__proto__', subcategory: 'map', name: 'Prototype test', portion: 1, unit: 'g', carbs: 1}]}}};
        try {
          const calculator = window.NightscoutTestModules.boluscalc(client, $);
          calculator.loadFoodQuickpicks(); calculator.loadFoodDatabase();
          return {label: $('#bc_quickpick option').eq(1).text(), category: $('#bc_filter_category option').eq(1).val(),
            mapUnchanged: Array.prototype.map === originalMap, unsafe: $('#bc_quickpick').find('img,script,[onerror]').length};
        } finally {Array.prototype.map = originalMap;}
      });
      assert.equal(result.label, '<img src=x onerror="window.injected=true">Fish & Chips (10 g)');
      assert.equal(result.category, '__proto__'); assert.equal(result.mapUnchanged, true); assert.equal(result.unsafe, 0);
    });
  });

  it('builds profile-derived Care Portal reason options without parsing them', async function () {
    await withSink('<select id="eventType"></select><select id="reason"></select>', async page => {
      const payload = 'x"></option></select><img src=x onerror="window.injected=true"><select><option value="x';
      const result = await page.evaluate(payload => {
        const client = {plugins: {getAllEventTypes: () => [{val: 'Temporary Override', name: 'Temporary Override', reasons: [{name: payload, displayName: payload}]}]},
          sbx: {}, settings: {units: 'mg/dl'}, translate: value => value};
        window.NightscoutTestModules.careportal(client, window.$).prepareEvents();
        return {count: window.$('#reason option').length, value: window.$('#reason option').val(), text: window.$('#reason option').text(),
          unsafe: Array.from(document.body.querySelectorAll('img,script,svg,[onerror],[onload]')).filter(node => !window.sinkFixture.scripts.includes(node)).length};
      }, payload);
      assert.deepEqual(result, {count: 1, value: payload, text: payload, unsafe: 0});
    });
  });
});
