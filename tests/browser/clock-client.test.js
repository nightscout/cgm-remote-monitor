'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {withPage} = require('./fixture');

describe('clock client in a real browser', function () {
  let server, origin, properties, requests, failing = false;
  before(async function () {
    const source = fs.readFileSync(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public/js/bundle.clock.js'));
    server = http.createServer((request, response) => {
      if (request.url === '/clock.js') {
        response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        response.end(source);
      } else if (request.url.startsWith('/api/')) {
        requests.push({method: request.method, url: request.url});
        if (failing) return response.writeHead(503).end();
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(properties));
      } else if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="inner"></div></body></html>');
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
    properties = {bgnow: {sgvs: [{mgdl: options.bg ?? 100, scaled, mills: Date.now() - (options.stale ? 20 * 60 * 1000 : 0), direction: Object.hasOwn(options, 'direction') ? options.direction : 'Flat'}]}, delta: {mgdl: 5, display: delta}};
    if (properties.bgnow.sgvs[0].direction === undefined) delete properties.bgnow.sgvs[0].direction;
    requests = [];
    return withPage(origin, async ({page}) => {
      await page.goto(origin);
      assert.equal(await page.evaluate(() => document.characterSet), 'UTF-8');
      await page.addScriptTag({url: origin + '/clock.js'});
      await page.evaluate(({serverUnits, browserUnits, options}) => {
        const inner = document.getElementById('inner');
        inner.setAttribute('data-face', options.face || 'bn0-sg40-dt14-ag6-ar25');
        if (options.config) inner.setAttribute('data-face-config', options.config);
        window.serverSettings = {settings: {units: serverUnits, showClockDelta: true, showClockLastTime: false}};
        window.Nightscout.client.settings = {units: browserUnits, thresholds: {bgHigh: 260, bgLow: 55, bgTargetBottom: options.lowerTarget ?? 80, bgTargetTop: 180}, timeFormat: 12};
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
            em: inner.querySelector('.em')?.textContent,
            arrow: inner.querySelector('.ar img')?.getAttribute('src'),
            sg: inner.querySelector('.sg')?.innerHTML, dt: inner.querySelector('.dt')?.innerHTML
          };
        }));
      }
      assert.deepEqual(requests, Array.from({length: 2}, () => ({method: 'GET', url: '/api/v2/properties'})));
      return snapshots;
    });
  }


  describe('low and falling emoji', function () {
    async function check(bg, direction, expected, options = {}) {
      const results = await render('mg/dl', options.browser || 'mg/dl', bg, '-5', {
        face: 'bn10-sg40-em40-ar25', bg, direction, ...options
      });
      for (const result of results) assert.equal(result.em, expected);
      return results;
    }
    for (const direction of ['FortyFiveDown', 'SingleDown', 'DoubleDown', 'TripleDown', 'down', 'slightdown']) {
      it('shows concern at 74 with direction ' + direction, async function () {
        await check(74, direction, '😟');
      });
    }
    for (const direction of ['Flat', 'SingleUp', 'NONE', 'NOT COMPUTABLE', undefined]) {
      it('preserves the existing face without a falling trend: ' + direction, async function () {
        await check(74, direction, '😊');
      });
    }
    it('uses the configured lower target and its boundary', async function () {
      await check(89, 'SingleDown', '😟', {lowerTarget: 90});
      await check(90, 'SingleDown', '😊', {lowerTarget: 90});
      await check(89, 'SingleDown', '😊', {lowerTarget: 80});
    });
    it('preserves existing low-value faces', async function () {
      await check(72, 'SingleDown', '😱');
      await check(54, 'DoubleDown', '🥶');
      await check(40, 'DoubleDown', '❌');
    });
    it('uses mg/dL internally when displaying mmol/L', async function () {
      for (const result of await check(74, 'SingleDown', '😟', {browser: 'mmol'})) assert.equal(result.sg, '4.1');
    });
    it('keeps stale data ahead of the trend warning', async function () {
      await check(74, 'SingleDown', '🤷', {stale: true});
    });
    it('uses the same normalized direction for the arrow', async function () {
      for (const result of await check(74, 'down', '😟')) assert.equal(result.arrow, '/images/SingleDown.svg');
    });
  });

  it('constructs every supported face component with bounded numeric sizing', async function () {
    for (const result of await render('mg/dl', 'mg/dl', '100', '+5', {face: 'bn0-sg40-dt14-nl-ar25-ag6-tm10-em40'})) {
      assert.deepEqual(result.classes, ['sg', 'dt', 'nl', 'ar', 'ag', 'tm', 'em']);
      assert.equal(result.sgSize, '40vmin');
      assert.equal(result.dtSize, '14vmin');
      assert.equal(result.nlSize, '');
      assert.equal(result.arHeight, '25vmin');
      assert.equal(result.em, '🦄');
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
  describe('low and falling emoji', function () {
    // One page; each case serves a new reading and runs the page's own query and render.
    async function withEmoji(run) {
      requests = [];
      await withPage(origin, async ({page}) => {
        await page.goto(origin);
        await page.addScriptTag({url: origin + '/clock.js'});
        await page.evaluate(() => document.getElementById('inner').setAttribute('data-face', 'bn10-sg40-em40-ar25'));
        await run(async (bg, direction, {lowerTarget = 80, browserUnits = 'mg/dl', stale = false} = {}) => {
          properties = {bgnow: {sgvs: [{mgdl: bg, scaled: bg, direction,
            mills: Date.now() - (stale ? 20 * 60 * 1000 : 0)}]}, delta: {mgdl: 5, display: '-5'}};
          await page.evaluate(({lowerTarget, browserUnits}) => {
            window.serverSettings = {settings: {units: 'mg/dl', showClockDelta: true, showClockLastTime: false}};
            window.Nightscout.client.settings = {units: browserUnits, timeFormat: 12,
              thresholds: {bgHigh: 260, bgLow: 55, bgTargetBottom: lowerTarget, bgTargetTop: 180}};
            window.Nightscout.client.unitMismatch = browserUnits !== 'mg/dl';
          }, {lowerTarget, browserUnits});
          await Promise.all([
            page.waitForResponse(origin + '/api/v2/properties'),
            page.evaluate(() => window.Nightscout.client.query())
          ]);
          await page.waitForFunction(() => window.$.active === 0);
          return page.evaluate(() => ({
            em: document.querySelector('#inner .em').textContent,
            sg: document.querySelector('#inner .sg').textContent,
            arrow: document.querySelector('#inner .ar img')?.getAttribute('src')
          }));
        });
      });
    }

    it('shows concern at 74 with a falling direction', async function () {
      await withEmoji(async emoji => {
        for (const direction of ['FortyFiveDown', 'SingleDown', 'DoubleDown', 'TripleDown', 'down', 'slightdown']) {
          assert.equal((await emoji(74, direction)).em, '😟', direction);
        }
      });
    });

    it('preserves the existing face without a falling trend', async function () {
      await withEmoji(async emoji => {
        for (const direction of ['Flat', 'SingleUp', 'NONE', 'NOT COMPUTABLE', undefined]) {
          assert.equal((await emoji(74, direction)).em, '😊', String(direction));
        }
      });
    });

    it('uses the configured lower target and its boundary', async function () {
      await withEmoji(async emoji => {
        assert.equal((await emoji(89, 'SingleDown', {lowerTarget: 90})).em, '😟');
        assert.equal((await emoji(90, 'SingleDown', {lowerTarget: 90})).em, '😊');
        assert.equal((await emoji(89, 'SingleDown', {lowerTarget: 80})).em, '😊');
      });
    });

    it('preserves the existing low-value faces', async function () {
      await withEmoji(async emoji => {
        assert.equal((await emoji(72, 'SingleDown')).em, '😱');
        assert.equal((await emoji(54, 'DoubleDown')).em, '🥶');
        assert.equal((await emoji(40, 'DoubleDown')).em, '❌');
      });
    });

    it('uses mg/dL internally when the browser displays mmol/L', async function () {
      await withEmoji(async emoji => {
        assert.deepEqual(await emoji(74, 'SingleDown', {browserUnits: 'mmol'}), {em: '😟', sg: '4.1', arrow: '/images/SingleDown.svg'});
      });
    });

    it('keeps stale data ahead of the trend warning', async function () {
      await withEmoji(async emoji => {
        assert.equal((await emoji(74, 'SingleDown', {stale: true})).em, '🤷');
      });
    });

    it('uses the same normalized direction for the arrow', async function () {
      await withEmoji(async emoji => {
        const result = await emoji(74, 'down');
        assert.equal(result.em, '😟');
        assert.equal(result.arrow, '/images/SingleDown.svg');
      });
    });
  });

  describe('when the data fetch fails', function () {
    const T0 = Date.parse('2026-09-24T12:00:00Z');
    afterEach(function () { failing = false; });

    // The page's own setInterval timers and Date run on Playwright's clock;
    // fetches go to the fixture server, which answers 503 while failing.
    async function withClock(face, showClockLastTime, run, {failFirst = false} = {}) {
      requests = [];
      failing = failFirst;
      properties = {bgnow: {sgvs: [{mgdl: 120, scaled: 120, mills: T0, direction: 'Flat'}]}, delta: {mgdl: 0, display: '+0'}};
      await withPage(origin, async ({page}) => {
        page.on('console', () => {});
        await page.clock.install({time: T0});
        await page.goto(origin);
        await page.addScriptTag({url: origin + '/clock.js'});
        await page.evaluate(({face, showClockLastTime}) => {
          document.getElementById('inner').setAttribute('data-face', face);
          window.serverSettings = {settings: {units: 'mg/dl', showClockDelta: true, showClockLastTime, timeFormat: 24,
            thresholds: {bgHigh: 260, bgLow: 55, bgTargetBottom: 80, bgTargetTop: 180}}};
        }, {face, showClockLastTime});
        await Promise.all([
          page.waitForResponse(response => response.url() === origin + '/api/v2/properties'),
          page.evaluate(() => window.Nightscout.client.init())
        ]);
        await page.waitForFunction(() => window.$.active === 0);
        const state = () => page.evaluate(() => ({
          // nothing is drawn before the first successful fetch
          stale: !!document.querySelector('#inner .sg.stale'),
          sg: document.querySelector('#inner .sg')?.textContent ?? '',
          ag: document.querySelector('#inner .ag')?.textContent,
          background: getComputedStyle(document.body).backgroundColor
        }));
        const advance = async minutes => {
          await page.clock.runFor(minutes * 60 * 1000);
          await page.waitForFunction(() => window.$.active === 0);
        };
        await run({state, advance});
      });
    }

    for (const face of ['bgclock', 'clock-color']) {
      it('turns the ' + face + ' face stale when fetches fail after the last reading', async function () {
        await withClock(face, false, async ({state, advance}) => {
          const before = await state();
          assert.equal(before.stale, false);
          assert.equal(before.ag, '');
          failing = true;
          await advance(30);
          assert.ok(requests.length > 80, requests.length + ' fetches');
          const after = await state();
          assert.equal(after.stale, true);
          assert.equal(after.ag, '30 minutes ago');
          assert.equal(after.background, 'rgb(128, 128, 128)');
        });
      });
    }

    it('keeps the age text moving on a face that always shows it', async function () {
      await withClock('cy13-sg40-ag6-tm10', true, async ({state, advance}) => {
        assert.equal((await state()).ag, 'Just now');
        failing = true;
        await advance(5);
        let current = await state();
        assert.equal(current.ag, '5 minutes ago');
        assert.equal(current.stale, false);
        await advance(10);
        current = await state();
        assert.equal(current.ag, '15 minutes ago');
        assert.equal(current.stale, true);
      });
    });

    it('draws nothing and does not throw when no fetch has succeeded yet', async function () {
      await withClock('clock-color', false, async ({state, advance}) => {
        await advance(5);
        assert.ok(requests.length > 10, requests.length + ' fetches');
        assert.equal((await state()).sg, '');
      }, {failFirst: true});
    });

    it('control: fetches that succeed with the same reading turn it stale', async function () {
      await withClock('clock-color', false, async ({state, advance}) => {
        await advance(30);
        const after = await state();
        assert.equal(after.stale, true);
        assert.equal(after.ag, '30 minutes ago');
        assert.equal(after.background, 'rgb(128, 128, 128)');
      });
    });
  });
});
