'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {withPage} = require('./fixture');

describe('clock client in a real browser', function () {
  let server, origin, properties, requests;
  before(async function () {
    const source = fs.readFileSync(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public/js/bundle.clock.js'));
    server = http.createServer((request, response) => {
      if (request.url === '/clock.js') {
        response.setHeader('Content-Type', 'application/javascript');
        response.end(source);
      } else if (request.url.startsWith('/api/')) {
        requests.push({method: request.method, url: request.url});
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(properties));
      } else if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><div id="inner"></div></body></html>');
      } else {
        response.writeHead(404).end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  async function render(serverUnits, browserUnits, scaled, delta, options = {}) {
    properties = {bgnow: {sgvs: [{mgdl: 100, scaled, mills: Date.now(), direction: 'Flat'}]}, delta: {mgdl: 5, display: delta}};
    requests = [];
    return withPage(origin, async ({page}) => {
      await page.goto(origin);
      await page.addScriptTag({url: origin + '/clock.js'});
      await page.evaluate(({serverUnits, browserUnits, options}) => {
        const inner = document.getElementById('inner');
        inner.setAttribute('data-face', options.face || 'bn0-sg40-dt14-ag6-ar25');
        if (options.config) inner.setAttribute('data-face-config', options.config);
        window.serverSettings = {settings: {units: serverUnits, showClockDelta: true, showClockLastTime: false}};
        window.Nightscout.client.settings = {units: browserUnits, thresholds: {bgHigh: 260, bgLow: 55, bgTargetBottom: 80, bgTargetTop: 180}, timeFormat: 12};
        window.Nightscout.client.unitMismatch = browserUnits !== serverUnits;
      }, {serverUnits, browserUnits, options});
      const snapshots = [];
      // Preserve the old assertions and repeat the real AJAX/render cycle to
      // detect duplicate clock components or state retained between updates.
      for (let pass = 0; pass < 2; pass++) {
        const [response] = await Promise.all([
          page.waitForResponse(origin + '/api/v2/properties'),
          page.evaluate(() => window.Nightscout.client.query())
        ]);
        assert.equal(response.status(), 200);
        assert.deepEqual(await response.json(), properties);
        await page.waitForFunction(() => window.$.active === 0 && document.querySelector('#inner .sg'));
        snapshots.push(await page.evaluate(() => {
          const inner = document.getElementById('inner');
          const style = selector => inner.querySelector(selector)?.style;
          return {
            classes: Array.from(inner.children, child => child.className),
            sgSize: style('.sg')?.fontSize, dtSize: style('.dt')?.fontSize,
            nlSize: style('.nl')?.fontSize, arHeight: style('.ar')?.height, tmSize: style('.tm')?.fontSize,
            unsafe: inner.querySelectorAll('img, script, [onclick], [onerror]').length,
            text: inner.textContent,
            sg: inner.querySelector('.sg')?.innerHTML, dt: inner.querySelector('.dt')?.innerHTML
          };
        }));
      }
      assert.deepEqual(requests, Array.from({length: 2}, () => ({method: 'GET', url: '/api/v2/properties'})));
      return snapshots;
    });
  }

  it('constructs every supported face component with bounded numeric sizing', async function () {
    for (const result of await render('mg/dl', 'mg/dl', '100', '+5', {face: 'bn0-sg40-dt14-nl-ar25-ag6-tm10-em40'})) {
      assert.deepEqual(result.classes, ['sg', 'dt', 'nl', 'ar', 'ag', 'tm', 'em']);
      assert.equal(result.sgSize, '40vmin');
      assert.equal(result.dtSize, '14vmin');
      assert.equal(result.nlSize, '');
      assert.equal(result.arHeight, '25vmin');
    }
  });

  it('does not interpret face configuration as markup, classes, or styles', async function () {
    const options = {face: 'config', config: 'cy10-sg40-xx99-sg40" onclick="alert(1)-ar25;background:red-<img src=x onerror=alert(1)>-tm10'};
    for (const result of await render('mg/dl', 'mg/dl', '100', '+5', options)) {
      assert.deepEqual(result.classes, ['sg', 'tm']);
      assert.equal(result.unsafe, 0);
      assert.equal(result.sgSize, '40vmin');
      assert.equal(result.tmSize, '10vmin');
      assert.doesNotMatch(result.text, /alert|onerror|onclick/);
    }
  });

  for (const scenario of [
    {name: 'should render browser mmol preference when server units are mg/dl', server: 'mg/dl', browser: 'mmol', scaled: 100, delta: '+5', expectedBg: '5.6', expectedDelta: '+0.3'},
    {name: 'should render browser mg/dl preference when server units are mmol', server: 'mmol', browser: 'mg/dl', scaled: '5.6', delta: '+0.3', expectedBg: '100', expectedDelta: '+5'},
    {name: 'should use server-scaled values when browser and server units match', server: 'mmol', browser: 'mmol', scaled: '5.6', delta: '+0.3', expectedBg: '5.6', expectedDelta: '+0.3'}
  ]) {
    it(scenario.name, async function () {
      for (const result of await render(scenario.server, scenario.browser, scenario.scaled, scenario.delta)) {
        assert.equal(result.sg, scenario.expectedBg);
        assert.equal(result.dt, scenario.expectedDelta);
      }
    });
  }
});
