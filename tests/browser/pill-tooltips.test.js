'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {withPage} = require('./fixture');
const {buildModules} = require('./modules');

describe('pluginbase in a real browser', function () {
  let server, origin;
  before(async function () {
    const app = fs.readFileSync(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public/js/bundle.app.js'));
    const modules = await buildModules();
    server = http.createServer((request, response) => {
      if (request.url === '/bundle.js' || request.url === '/modules.js') {
        response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        response.end(request.url === '/bundle.js' ? app : modules);
      } else if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
      } else response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  async function withPills(run) {
    await withPage(origin, async ({page}) => {
      await page.goto(origin);
      await page.addScriptTag({url: origin + '/bundle.js'});
      await page.addScriptTag({url: origin + '/modules.js'});
      await page.evaluate(() => {
        const $ = window.$;
        const container = $('<div style="width:900px">').appendTo('body');
        const bgStatus = $('<div class="bgStatus">').appendTo(container);
        const major = $('<div class="majorPills">').appendTo(bgStatus);
        const minor = $('<div class="minorPills">').appendTo(bgStatus);
        const status = $('<div class="statusPills">').appendTo(bgStatus);
        const tooltipNode = $('<div class="tooltip" style="position:absolute">').appendTo(container);
        const tooltip = window.d3.select(tooltipNode[0]);
        const fixture = {major, minor, status, bgStatus, tooltipNode, tooltip, renders: 0};
        const style = tooltip.style;
        tooltip.style = function (name, value) {
          if (name === 'display' && value === 'block') fixture.renders++;
          return style.apply(this, arguments);
        };
        fixture.base = window.NightscoutTestModules.pluginbase(major, minor, status, bgStatus, tooltip);
        fixture.mouse = (pill, type) => pill[0].dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true, view: window, clientX: 10, clientY: 20
        }));
        window.pillFixture = fixture;
      });
      await run(page);
    });
  }

  it('updatePillText creates a pill in the matching container', async function () {
    await withPills(async page => {
      const result = await page.evaluate(() => {
        const {base, major} = window.pillFixture;
        base.updatePillText({name: 'fake', label: 'Insulin-on-Board', pluginType: 'pill-major'}, {
          value: '123', label: 'TEST', info: [{label: 'Label', value: 'Value'}]
        });
        return {containers: major.length, pills: major.find('span.pill.fake').length, value: major.find('span.pill.fake em').text()};
      });
      assert.deepEqual(result, {containers: 1, pills: 1, value: '123'});
    });
  });

  it('renders tooltip labels and values as text inside owned markup', async function () {
    await withPills(async page => {
      const result = await page.evaluate(() => {
        const {base, major, mouse, tooltipNode} = window.pillFixture;
        base.updatePillText({name: 'fake', pluginType: 'pill-major'}, {
          value: '123', label: 'TEST', info: [
            {label: '<img src=x onerror="window.injected=true">Label', value: '<script>window.injected=true</script>Value'},
            {label: 'Encoded &amp; label', value: 'Fish &amp; Chips &lt; 70'}
          ]
        });
        mouse(major.find('span.pill.fake'), 'mouseover');
        return {
          labels: tooltipNode.find('strong').map(function () {return this.textContent;}).get(),
          breaks: tooltipNode.find('br').length, unsafe: tooltipNode.find('img,script').length,
          firstValue: tooltipNode[0].childNodes[1].textContent, lastValue: tooltipNode[0].lastChild.textContent,
          injected: window.injected
        };
      });
      assert.deepEqual(result.labels, ['<img src=x onerror="window.injected=true">Label', 'Encoded & label']);
      assert.equal(result.breaks, 1);
      assert.equal(result.unsafe, 0);
      assert.equal(result.firstValue, ' <script>window.injected=true</script>Value');
      assert.equal(result.lastValue, ' Fish & Chips < 70');
      assert.equal(result.injected, undefined);
    });
  });

  it('keeps one handler per event and only the latest tooltip data after repeated updates', async function () {
    await withPills(async page => {
      await page.evaluate(() => {
        const f = window.pillFixture, plugin = {name: 'repeat', pluginType: 'pill-major'};
        f.plugin = plugin;
        f.foreignOver = f.foreignOut = 0;
        f.base.updatePillText(plugin, {info: [{label: 'Update', value: 0}]});
        f.pill = f.major.find('.repeat');
        f.pill.on('mouseover.anotherPlugin', () => f.foreignOver++);
        f.pill.on('mouseout.anotherPlugin', () => f.foreignOut++);
      });
      for (const count of [1, 2, 100]) {
        const result = await page.evaluate(count => {
          const f = window.pillFixture;
          for (let i = 1; i <= count; i++) f.base.updatePillText(f.plugin, {info: [{label: 'Update', value: i}]});
          const events = window.$._data(f.pill[0], 'events'), previous = f.renders;
          f.mouse(f.pill, 'mouseover');
          const result = {renders: f.renders - previous, over: events.mouseover.length, out: events.mouseout.length,
            text: f.tooltipNode.text(), visible: f.tooltipNode.css('display')};
          f.mouse(f.pill, 'mouseout');
          result.hidden = f.tooltipNode.css('display');
          return result;
        }, count);
        assert.deepEqual(result, {renders: 1, over: 2, out: 2, text: 'Update ' + count, visible: 'block', hidden: 'none'});
      }
      assert.deepEqual(await page.evaluate(() => [window.pillFixture.foreignOver, window.pillFixture.foreignOut]), [3, 3]);
      const removed = await page.evaluate(() => {
        const f = window.pillFixture;
        f.mouse(f.pill, 'mouseover');
        f.base.updatePillText(f.plugin, {});
        const result = {display: f.tooltipNode.css('display'), owned: Object.values(window.$._data(f.pill[0], 'events')).flat().filter(handler => handler.namespace === 'pillTooltip').length};
        const previous = f.renders;
        f.mouse(f.pill, 'mouseover');
        f.mouse(f.pill, 'mouseout');
        return {...result, renders: f.renders - previous, foreign: [f.foreignOver, f.foreignOut]};
      });
      assert.deepEqual(removed, {display: 'none', owned: 0, renders: 0, foreign: [5, 4]});
      const restored = await page.evaluate(() => {
        const f = window.pillFixture;
        f.base.updatePillText(f.plugin, {info: [{label: 'New', value: 'current'}]});
        f.mouse(f.pill, 'mouseover');
        const text = f.tooltipNode.text(), node = f.pill[0];
        f.pill.remove();
        return {text, events: window.$._data(node, 'events')};
      });
      assert.equal(restored.text, 'New current');
      assert.equal(restored.events, undefined);
    });
  });

  it('does not hide another pill tooltip when an inactive pill loses its info', async function () {
    await withPills(async page => {
      const result = await page.evaluate(() => {
        const {base, minor, mouse, tooltipNode} = window.pillFixture;
        const first = {name: 'first'}, second = {name: 'second'};
        base.updatePillText(first, {info: [{label: 'First', value: 1}]});
        base.updatePillText(second, {info: [{label: 'Second', value: 2}]});
        mouse(minor.find('.second'), 'mouseover');
        base.updatePillText(first, {info: []});
        return {display: tooltipNode.css('display'), text: tooltipNode.text()};
      });
      assert.deepEqual(result, {display: 'block', text: 'Second 2'});
    });
  });
});
