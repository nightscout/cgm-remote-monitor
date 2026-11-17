'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const express = require('express');
const {withPage} = require('./fixture');

describe('Client startup retry contracts', function () {
  let server, origin, responses;
  before(async function () {
    const app = express();
    app.get('/', (request, response) => response.type('html').send('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="loadingMessageText"></div><div id="centerMessagePanel"></div><div id="page-ready"></div></body></html>'));
    app.get('/api/v1/status.json', (request, response) => {
      const next = responses.shift();
      if (!next) return response.status(500).json({error: 'Unexpected status request'});
      response.status(next.status || 200).json(next.body);
    });
    app.use('/bundle', express.static(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public')));
    server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {if (server) await new Promise(resolve => server.close(resolve));});

  async function withStartup(run) {
    responses = [];
    await withPage(origin, async ({page}) => {
      let attempts = 0, failures = 0;
      await page.route(url => url.origin === origin && url.pathname === '/api/v1/status.json', async route => {
        attempts++;
        if (failures > 0) {failures--; return route.abort('failed');}
        return route.fallback();
      });
      await page.clock.install({time: new Date('2026-01-01T00:00:00Z')});
      await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
      await page.goto(origin);
      await page.addScriptTag({url: origin + '/bundle/js/bundle.app.js'});
      await page.evaluate(() => {
        const client = window.Nightscout.client;
        window.startupFixture = {callbacks: [], deliveries: [], prompts: 0};
        // Test the init/loader boundary; complete page boot has separate coverage.
        client.loadLanguage = function (settings, callback) {
          window.startupFixture.deliveries.push(settings.marker);
          if (callback) callback();
        };
        client.hashauth.requestAuthentication = function (callback) {
          window.startupFixture.prompts++;
          window.startupFixture.authComplete = callback;
        };
      });
      await run({page, attempts: () => attempts, failNext: count => {failures = count;}});
    });
  }
  async function arm(page) {
    await page.evaluate(() => {
      window.startupFixture.settled = new Promise(resolve => window.$(document).one('ajaxStop.startupFixture', () => resolve(true)));
    });
  }
  async function settled(page) {
    // AJAX completion stays real while only the retry clock is advanced.
    await page.evaluate(() => window.startupFixture.settled);
  }
  async function start(page, cycle) {
    await arm(page);
    await page.evaluate(cycle => window.Nightscout.client.init(() => {
      window.startupFixture.callbacks.push(cycle);
      document.querySelector('#page-ready').textContent = 'Ready ' + cycle;
    }), cycle);
    await settled(page);
  }
  async function retryAfterFiveSeconds(page, attempts, expected) {
    await arm(page);
    await page.clock.runFor(4999);
    assert.equal(attempts(), expected, 'No early retry');
    await page.clock.runFor(1);
    await settled(page);
    assert.equal(attempts(), expected + 1, 'Exactly one retry after five seconds');
  }
  async function ready(page, cycle, attempts, count) {
    assert.equal(await page.locator('#page-ready').textContent(), 'Ready ' + cycle);
    assert.deepEqual(await page.evaluate(() => window.startupFixture.callbacks), Array.from({length: cycle}, (_, i) => i + 1));
    await page.clock.runFor(10000);
    assert.equal(attempts(), count, 'No stale retry after recovery');
  }

  for (const failure of ['loading', 'offline']) {
    it('waits five seconds and preserves the page callback after repeated ' + failure + ' responses', async function () {
      await withStartup(async ({page, attempts, failNext}) => {
        for (let cycle = 1; cycle <= 2; cycle++) {
          const before = attempts();
          if (failure === 'loading') responses.push({body: {runtimeState: 'loading'}}, {body: {runtimeState: 'loading'}});
          else failNext(2);
          responses.push({body: {runtimeState: 'loaded', marker: cycle}});
          await start(page, cycle);
          assert.equal(attempts(), before + 1, 'The first failure must not retry immediately');
          assert.match(await page.locator('#loadingMessageText').textContent(), failure === 'loading' ? /still starting/ : /retrying every 5 seconds/);
          await retryAfterFiveSeconds(page, attempts, before + 1);
          await retryAfterFiveSeconds(page, attempts, before + 2);
          await ready(page, cycle, attempts, before + 3);
        }
        assert.deepEqual(await page.evaluate(() => window.startupFixture.deliveries), [1, 2]);
        assert.equal(responses.length, 0);
      });
    });
  }
  it('retries immediately after authentication and preserves callbacks across two cycles', async function () {
    await withStartup(async ({page, attempts}) => {
      for (let cycle = 1; cycle <= 2; cycle++) {
        const before = attempts();
        responses.push({status: 401, body: {message: 'Authentication required'}}, {body: {runtimeState: 'loaded', marker: cycle}});
        await start(page, cycle);
        assert.equal(attempts(), before + 1);
        assert.equal(await page.evaluate(() => window.startupFixture.prompts), cycle);
        await arm(page);
        await page.evaluate(() => window.startupFixture.authComplete());
        await settled(page);
        assert.equal(attempts(), before + 2, 'Authentication completion retries immediately');
        await ready(page, cycle, attempts, before + 2);
      }
      assert.equal(responses.length, 0);
    });
  });
});
