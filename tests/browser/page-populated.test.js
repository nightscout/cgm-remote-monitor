'use strict';

const assert = require('node:assert/strict');
const {getBrowser} = require('./hooks');
const {createPageFixture, pages, hash} = require('../fixtures/page-startup/server');
const {workload, ready} = require('../../tools/measure-page-startup');
const {heapLimits} = require('../../tools/page-resource-acceptance');

describe('Populated application page budgets', function () {
  let fixture, data;
  before(async function () {data = workload(); fixture = await createPageFixture({...data, compress: true});});
  after(async function () {if (fixture) await new Promise(resolve => fixture.io.close(resolve));});
  for (const [url, , , entry] of pages) {
    it('initializes populated ' + entry + ' and bounds retained V8 heap where available', async function () {
      const browser = getBrowser();
      const context = await browser.newContext({serviceWorkers: 'block', viewport: {width: 1280, height: 900}, timezoneId: 'America/Los_Angeles'});
      const errors = [], external = [];
      context.on('request', request => {if (new URL(request.url()).origin !== fixture.origin) external.push(request.url());});
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(10000);
        page.on('pageerror', error => errors.push(error.message));
        await page.clock.setFixedTime(new Date(data.now));
        await page.addInitScript(hash => localStorage.setItem('apisecrethash', hash), hash);
        await page.goto(fixture.origin + url);
        await page.waitForFunction(ready, entry);
        assert.deepEqual(await page.evaluate(() => ({sgvs: window.Nightscout.client.ddata.sgvs.length,
          treatments: window.Nightscout.client.ddata.treatments.length, food: window.Nightscout.client.ddata.food.length})),
        {sgvs: 576, treatments: 48, food: 300});
        // V8 exposes precise post-GC counters through CDP. Other engines still
        // run the entire populated startup/data/UI contract above.
        if (browser.browserType().name() === 'chromium') {
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const session = await context.newCDPSession(page);
          await session.send('HeapProfiler.collectGarbage');
          const heap = await session.send('Runtime.getHeapUsage');
          assert.ok(heap.usedSize <= heapLimits[entry], entry + ': retained heap ' + heap.usedSize + ' exceeds ' + heapLimits[entry]);
        }
      } finally {await context.close();}
      assert.deepEqual(errors, [], 'Uncaught populated-page errors');
      assert.deepEqual(external, [], 'External populated-page requests');
    });
  }
});
