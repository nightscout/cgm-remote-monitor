'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const express = require('express');
const {withPage} = require('./fixture');

describe('Production D3 surface', function () {
  let server, origin;
  before(async function () {
    const app = express();
    app.get('/', (request, response) => response.type('html').send('<!doctype html><html><head><meta charset="utf-8"></head><body><svg><rect x="0" width="10" height="10"></rect></svg></body></html>'));
    app.use('/bundle', express.static(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public')));
    server = http.createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
  });
  async function loaded(run, options) {
    await withPage(origin, async ({page}) => {
      await page.goto(origin);
      await page.addScriptTag({url: origin + '/bundle/js/bundle.app.js'});
      await run(page);
    }, options);
  }
  it('preserves color parsing and interpolation in the shipped bundle', async function () {
    await loaded(async page => {
      assert.deepEqual(await page.evaluate(() => ({
        green: window.d3.color('green').formatHex(),
        alpha: window.d3.color('rgba(255, 0, 0, 0.5)').opacity,
        mixed: window.d3.interpolateRgb('white', '#0099ff')(0.5),
        invalid: window.d3.color('invalid'),
        pathological: window.d3.color('hsl(' + '1'.repeat(1000000) + '!')
      })), {green: '#008000', alpha: 0.5, mixed: 'rgb(128, 204, 255)', invalid: null, pathological: null});
    });
  });
  it('retains selection transition and interruption across two cycles', async function () {
    await loaded(async page => {
      assert.deepEqual(await page.evaluate(async () => {
        const results = [];
        for (let cycle = 0; cycle < 2; cycle++) {
          const rect = window.d3.select('rect').attr('x', 0);
          let ended = 0;
          await rect.transition().duration(20).attr('x', 20).on('end', () => ended++).end();
          const value = rect.attr('x');
          const pending = rect.transition('cancel').duration(1000).attr('x', 99).end();
          rect.interrupt('cancel');
          let cancelled = false;
          try {await pending;} catch (_) {cancelled = true;}
          results.push({value, ended, cancelled, final: rect.attr('x')});
        }
        return results;
      }), Array.from({length: 2}, () => ({value: '20', ended: 1, cancelled: true, final: '20'})));
    });
  });
  for (const zone of [
    {timezoneId: 'America/Los_Angeles', dates: ['2025-03-09', '2025-11-02'], hours: [23, 25]},
    {timezoneId: 'Europe/London', dates: ['2025-03-30', '2025-10-26'], hours: [23, 25]},
    {timezoneId: 'UTC', dates: ['2025-03-09', '2025-11-02'], hours: [24, 24]}
  ]) {
    it('preserves local day boundaries and time scales in ' + zone.timezoneId, async function () {
      await loaded(async page => {
        const result = await page.evaluate(dates => dates.map(date => {
          const d3 = window.d3, start = new Date(date + 'T00:00:00');
          const end = d3.timeDay.offset(start, 1);
          const scale = d3.scaleTime().domain([start, end]).range([0, 100]);
          return {hours: (end - start) / 3600000, start: d3.timeFormat('%Y-%m-%d %H:%M')(start),
            midnight: d3.timeFormat('%H:%M')(end), positions: [scale(start), scale(end)],
            midpoint: +scale.invert(50) === (+start + +end) / 2};
        }), zone.dates);
        assert.deepEqual(result, zone.dates.map((date, index) => ({hours: zone.hours[index],
          start: date + ' 00:00', midnight: '00:00', positions: [0, 100], midpoint: true})));
      }, {timezoneId: zone.timezoneId});
    });
  }

});
