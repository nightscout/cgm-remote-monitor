'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const express = require('express');
const {withPage} = require('./fixture');
const {buildModules} = require('./modules');

describe('Browser event bus contracts', function () {
  let server, origin;
  before(async function () {
    const modules = await buildModules();
    const app = express();
    app.get('/', (request, response) => response.type('html').send('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'));
    app.get('/modules.js', (request, response) => response.type('js').send(modules));
    app.use('/bundle', express.static(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public')));
    server = http.createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
  });
  async function withBus(run) {
    await withPage(origin, async ({page}) => {
      await page.clock.install({time: new Date('2026-01-01T00:00:00Z')});
      await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
      await page.goto(origin);
      await page.addScriptTag({url: origin + '/bundle/js/bundle.app.js'});
      await page.addScriptTag({url: origin + '/modules.js'});
      await run(page);
    });
  }

  it('preserves heartbeat payloads and stops old timers across two replacement cycles', async function () {
    await withBus(async page => {
      for (let cycle = 0; cycle < 2; cycle++) {
        const started = await page.evaluate(() => {
          const state = window.busFixture = {ticks: [], teardowns: 0, bus: window.NightscoutTestModules.makeBus({heartbeat: 1})};
          state.bus.on('tick', tick => state.ticks.push({...tick, now: tick.now.getTime(), started: tick.started.getTime()}));
          state.bus.on('teardown', () => state.teardowns++);
          state.bus.uptime();
          return Date.now();
        });
        await page.clock.runFor(1000);
        await page.clock.runFor(1000);
        const ticks = await page.evaluate(() => window.busFixture.ticks);
        assert.deepEqual(ticks, [0, 1, 2].map(beat => ({now: started + beat * 1000, type: 'heartbeat', sig: 'internal://heartbeat/' + beat, beat, interval: 1000, started})));
        await page.evaluate(() => {window.busFixture.bus.teardown(); window.busFixture.bus.teardown();});
        await page.clock.runFor(5000);
        assert.deepEqual(await page.evaluate(() => [window.busFixture.ticks.length, window.busFixture.teardowns]), [3, 2]);
      }
    });
  });

  it('preserves listener order, once/removal and handled/unhandled errors twice', async function () {
    await withBus(async page => {
      for (let cycle = 0; cycle < 2; cycle++) {
        const result = await page.evaluate(() => {
          const bus = window.NightscoutTestModules.makeBus({heartbeat: 1});
          try {
            const calls = [];
            const first = function (value) {calls.push(['first', value, this === bus]);};
            const second = function (value) {calls.push(['second', value, this === bus]);};
            bus.on('message', first); bus.once('message', second);
            bus.emit('message', 1); bus.emit('message', 2);
            bus.removeListener('message', first);
            const empty = bus.emit('message', 3);
            bus.on('message', first); bus.removeAllListeners('message');
            const error = new Error('bus error');
            let before = false, handled = false, after = false;
            try {bus.emit('error', error);} catch (caught) {before = caught === error;}
            bus.once('error', caught => {handled = caught === error;});
            bus.emit('error', error);
            try {bus.emit('error', error);} catch (caught) {after = caught === error;}
            return {calls, empty, remaining: bus.listenerCount('message'), errors: [before, handled, after]};
          } finally {bus.teardown();}
        });
        assert.deepEqual(result, {calls: [['first', 1, true], ['second', 1, true], ['first', 2, true]], empty: false, remaining: 0, errors: [true, true, true]});
      }
    });
  });
});
