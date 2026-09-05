'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {withPage} = require('./fixture');
const {buildModules} = require('./modules');

describe('D3 chart interaction compatibility in a real browser', function () {
  let server, origin;
  before(async function () {
    const app = fs.readFileSync(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public/js/bundle.app.js'));
    const modules = await buildModules();
    // Production loads this stylesheet outside webpack. Keep chart geometry
    // rules, omitting only the external font import from the isolated fixture.
    const css = fs.readFileSync(path.resolve(__dirname, '../../static/css/main.css'), 'utf8')
      .replace("@import url('https://fonts.googleapis.com/css?family=Ubuntu:400,700');", '');
    server = http.createServer((request, response) => {
      if (request.url === '/bundle.js' || request.url === '/modules.js') {
        response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        response.end(request.url === '/bundle.js' ? app : modules);
      } else if (request.url === '/main.css') {
        response.setHeader('Content-Type', 'text/css; charset=utf-8');
        response.end(css);
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

  async function withChart(run, units = 'mg/dl') {
    await withPage(origin, async ({page}) => {
      await page.goto(origin);
      await page.addScriptTag({url: origin + '/bundle.js'});
      await page.addScriptTag({url: origin + '/modules.js'});
      await page.addStyleTag({url: origin + '/main.css'});
      await page.evaluate(units => {
        const d3 = window.d3;
        const client = window.NightscoutTestModules.makeChart(d3, window, units);
        function point(x, y, space) {
          return space ? new DOMPoint(x, y).matrixTransform(space.getScreenCTM()) : {x, y};
        }
        function mouse(target, type, x, y, buttons = 0, space) {
          const p = point(x, y, space);
          target.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true, view: window, clientX: p.x, clientY: p.y, buttons}));
        }
        function treatment(editMode) {
          client.editMode = editMode;
          client.renderer.drawTreatment({_id: 'treatment-1', NSCLIENT_ID: 'old-id', eventType: 'Meal Bolus', mills: client.now - 3600000, mgdl: 100, carbs: 20, insulin: 2}, {scale: 2, showLabels: false, treatments: 1}, 10, {});
          return client.chart.focus.select('.draggable-treatment').node();
        }
        function tooltip() {
          return {text: client.tooltip.text(), display: client.tooltip.style('display'), left: client.tooltip.style('left'), top: client.tooltip.style('top')};
        }
        window.chartFixture = {client, d3, mouse, treatment, tooltip, emitted: []};
        client.socket = {emit(name, payload, callback) {window.chartFixture.emitted.push([name, payload]); if (callback) callback('ok');}};
      }, units);
      const geometry = await page.evaluate(() => {
        const {client} = window.chartFixture;
        const rect = document.querySelector('#chartContainer').getBoundingClientRect();
        return {width: rect.width, height: rect.height, focus: client.chart.focusHeight,
          touchListener: typeof client.chart.theBrush.on('touchstart.brush')};
      });
      assert.deepEqual([geometry.width, geometry.height], [900, 600]);
      assert.equal(geometry.focus, 399);
      assert.equal(geometry.touchListener, 'function');
      await run(page);
    }, {hasTouch: true});
  }

  for (const units of ['mg/dl', 'mmol']) {
    it('preserves glucose/forecast positions and hover data in ' + units, async function () {
      await withChart(async page => {
        const result = await page.evaluate(() => {
          const {client, mouse, tooltip} = window.chartFixture;
          client.entries = [{type: 'sgv', mills: client.now - 3600000, mgdl: 126, color: 'green'}];
          client.chart.getForecastData = () => [{type: 'forecast', forecastType: 'IOB', mills: client.now, mgdl: 144, color: 'blue'}];
          client.renderer.addFocusCircles();
          const dot = client.chart.focus.select('.entry-dot');
          const result = {cx: +dot.attr('cx'), cy: +dot.attr('cy'), expectedY: client.chart.yScale(client.settings.units === 'mmol' ? 7 : 126), hovers: []};
          [dot.node(), client.chart.focus.select('.forecast-dot').node()].forEach((node, index) => {
            mouse(node, 'mouseover', 100 + index * 750, 50 + index * 20);
            const over = tooltip();
            mouse(node, 'mouseout', 0, 0);
            result.hovers.push({over, out: tooltip().display});
          });
          client.entries = [];
          client.renderer.addFocusCircles();
          result.remaining = client.chart.focus.selectAll('.entry-dot').size();
          return result;
        });
        assert.equal(result.cx, 600);
        assert.equal(result.cy, result.expectedY);
        result.hovers.forEach(({over, out}, index) => {
          assert.equal(over.display, 'block');
          assert.equal(over.left, index ? '740px' : '100px');
          assert.equal(over.top, index ? '85px' : '65px');
          assert.ok(over.text.includes(index ? 'IOB' : String(units === 'mmol' ? 7 : 126)));
          assert.equal(out, 'none');
        });
        assert.equal(result.remaining, 0);
      }, units);
    });
  }

  async function touch(page, selector, type, x, y, space) {
    const coordinates = await page.evaluate(({x, y, space}) => {
      const point = new DOMPoint(x, y).matrixTransform(window.chartFixture.client.chart[space].node().getScreenCTM());
      return {clientX: point.x, clientY: point.y};
    }, {x, y, space});
    const contact = {identifier: 1, ...coordinates};
    // Playwright constructs the engine's native Touch/TouchList objects (WebKit
    // uses document.createTouch), preserving real DOM event handling.
    await page.locator(selector).first().dispatchEvent(type, {
      touches: type === 'touchend' ? [] : [contact],
      changedTouches: [contact], targetTouches: type === 'touchend' ? [] : [contact]
    });
  }

  async function brushGesture(page, input, x, endX = x) {
    if (input === 'mouse') {
      const points = await page.evaluate(({x, endX}) => {
        const overlay = window.chartFixture.client.chart.theBrush.select('.overlay').node();
        return [x, endX].map(value => {
          const point = new DOMPoint(value, 50).matrixTransform(overlay.getScreenCTM());
          return {x: point.x, y: point.y};
        });
      }, {x, endX});
      // Hit-test the actual overlay with browser mouse input, rather than
      // dispatching directly to a chosen DOM node.
      await page.mouse.move(points[0].x, points[0].y);
      await page.mouse.down();
      if (endX !== x) await page.mouse.move(points[1].x, points[1].y);
      await page.mouse.up();
    } else {
      const selector = '.chart-context .brush .overlay';
      await touch(page, selector, 'touchstart', x, 50, 'theBrush');
      if (endX !== x) await touch(page, selector, 'touchmove', endX, 50, 'theBrush');
      await touch(page, selector, 'touchend', endX, 50, 'theBrush');
    }
    return page.evaluate(() => {
      const {client, d3} = window.chartFixture;
      const range = client.chart.createBrushedRange();
      return {selection: d3.brushSelection(client.chart.theBrush.node()), range: range[1] - range[0], focus: client.focusRangeMS};
    });
  }

  for (const input of ['mouse', 'touch']) {
    it('centers, clamps and moves the context brush repeatedly using ' + input, async function () {
      await withChart(async page => {
        for (const x of [450, 10, 890]) {
          const result = await brushGesture(page, input, x);
          const left = Math.max(0, Math.min(675, x - 112.5));
          assert.deepEqual(result.selection, [left, left + 225]);
          assert.equal(result.range, result.focus);
        }
      });
    });
    it('drags the selected context window using ' + input, async function () {
      await withChart(async page => {
        const result = await brushGesture(page, input, 450, 550);
        assert.deepEqual(result.selection, [437.5, 662.5]);
      });
    });
  }

  it('keeps treatments read-only when editing is disabled', async function () {
    await withChart(async page => {
      const result = await page.evaluate(() => {
        const {d3, treatment, mouse, tooltip} = window.chartFixture;
        const node = treatment(false);
        mouse(node, 'mouseover', 120, 80);
        return {editable: !!d3.select(node).on('mousedown.drag'), tooltip: tooltip()};
      });
      assert.equal(result.editable, false);
      assert.ok(result.tooltip.text.includes('Carbs: 20'));
      assert.equal(result.tooltip.top, '95px');
    });
  });

  it('moves a treatment by touch and restores the chart on cancel', async function () {
    await withChart(async page => {
      const dialogs = [];
      page.on('dialog', async dialog => {dialogs.push(dialog.type()); await dialog.dismiss();});
      await page.evaluate(() => window.chartFixture.treatment(true));
      await touch(page, '.draggable-treatment', 'touchstart', 600, 200, 'focus');
      await touch(page, '.draggable-treatment', 'touchmove', 400, 150, 'focus');
      const text = await page.evaluate(() => window.chartFixture.tooltip().text);
      await touch(page, '.draggable-treatment', 'touchend', 400, 150, 'focus');
      const result = await page.evaluate(() => {
        const {client, emitted} = window.chartFixture;
        return {emitted, basals: client.chart.basals.attr('display'), drag: client.chart.drag.selectAll('.drag-droparea,.arrow').size()};
      });
      assert.ok(text.includes('Move'));
      assert.deepEqual(dialogs, ['confirm']);
      assert.deepEqual(result.emitted, []);
      assert.equal(result.basals, '');
      assert.equal(result.drag, 0);
    });
  });

  it('preserves duration treatment geometry and hover details', async function () {
    await withChart(async page => {
      const result = await page.evaluate(() => {
        const {client, mouse, tooltip} = window.chartFixture;
        client.ddata.treatments = [{eventType: 'Exercise', notes: 'Walk & rest', mills: client.now - 3600000, duration: 30}];
        client.ddata.tempTargetTreatments = [];
        client.renderer.addTreatmentCircles(new Date(client.now));
        const duration = client.chart.focus.select('.g-duration');
        mouse(duration.node(), 'mouseover', 110, 90);
        const over = tooltip();
        mouse(duration.node(), 'mouseout', 0, 0);
        return {width: +duration.select('rect').attr('width'), over, out: tooltip().display};
      });
      assert.equal(result.width, 150);
      assert.ok(result.over.text.includes('Walk & rest'));
      assert.equal(result.over.left, '110px');
      assert.equal(result.over.top, '105px');
      assert.equal(result.out, 'none');
    });
  });

  it('preserves profile switch hover details and literal text', async function () {
    await withChart(async page => {
      const result = await page.evaluate(() => {
        const {client, mouse, tooltip} = window.chartFixture;
        client.settings.extendedSettings = {basal: {render: 'default'}};
        client.profilefunctions = {listBasalProfiles: () => ['Default', 'Exercise'], activeProfileToTime: () => 'Default'};
        client.ddata.profileTreatments = [{eventType: 'Profile Switch', profile: 'Exercise & rest', mills: client.now - 3600000, notes: '<b>literal</b>'}];
        client.renderer.addTreatmentProfiles(client);
        const profile = client.chart.basals.select('.g-profile').node();
        mouse(profile, 'mouseover', 120, 80);
        const over = tooltip();
        mouse(profile, 'mouseout', 0, 0);
        return {over, out: tooltip().display};
      });
      assert.ok(result.over.text.includes('Exercise & rest'));
      assert.ok(result.over.text.includes('<b>literal</b>'));
      assert.equal(result.over.left, '120px');
      assert.equal(result.over.top, '95px');
      assert.equal(result.out, 'none');
    });
  });

  for (const [operation, x, y, eventName] of [
    ['Move', 400, 150, 'dbUpdate'], ['Remove', 20, 150, 'dbRemove'],
    ['Remove carbs', 20, 20, 'dbUpdateUnset'], ['Remove insulin', 20, 380, 'dbUpdateUnset'],
    ['Move carbs', 400, 20, 'dbUpdateUnset'], ['Move insulin', 400, 380, 'dbUpdateUnset']
  ]) {
    for (const confirmed of [true, false]) {
      it(operation + ' emits the correct treatment operation only when confirmed=' + confirmed, async function () {
        await withChart(async page => {
          const dialogs = [];
          page.on('dialog', async dialog => {dialogs.push(dialog.type()); await (confirmed ? dialog.accept() : dialog.dismiss());});
          for (let cycle = 0; cycle < 2; cycle++) {
            const result = await page.evaluate(({x, y}) => {
              const {client, treatment, mouse, tooltip} = window.chartFixture;
              client.chart.focus.selectAll('.draggable-treatment').remove();
              const node = treatment(true), space = client.chart.focus.node();
              mouse(node, 'mousedown', 600, 200, 1, space);
              const hidden = client.chart.basals.attr('display');
              mouse(window, 'mousemove', x, y, 1, space);
              const text = tooltip().text;
              mouse(window, 'mouseup', x, y, 0, space);
              return {hidden, text, drag: client.chart.drag.selectAll('.drag-droparea,.arrow').size(), basals: client.chart.basals.attr('display')};
            }, {x, y});
            assert.equal(result.hidden, 'none');
            assert.ok(result.text.includes(operation));
            assert.equal(result.drag, 0);
            assert.equal(result.basals, '');
          }
          assert.deepEqual(dialogs, ['confirm', 'confirm']);
          const {emitted, movedAt} = await page.evaluate(x => ({emitted: window.chartFixture.emitted, movedAt: window.chartFixture.client.chart.xScale.invert(x).toISOString()}), x);
          if (!confirmed) return assert.deepEqual(emitted, []);
          const split = operation === 'Move carbs' || operation === 'Move insulin';
          assert.equal(emitted.length, split ? 4 : 2);
          for (let index = 0; index < emitted.length; index += split ? 2 : 1) {
            const [name, payload] = emitted[index];
            assert.equal(name, eventName);
            assert.equal(payload._id, 'treatment-1');
            assert.equal(payload.collection, 'treatments');
            if (operation === 'Move') assert.deepEqual(payload.data, {created_at: movedAt});
            if (operation.includes('carbs')) assert.deepEqual(payload.data, {carbs: 1});
            if (operation.includes('insulin')) assert.deepEqual(payload.data, {insulin: 1});
            if (split) {
              assert.equal(emitted[index + 1][0], 'dbAdd');
              const data = emitted[index + 1][1].data;
              assert.equal(data.created_at, movedAt);
              assert.equal(data._id, undefined);
              assert.equal(data.NSCLIENT_ID, undefined);
              assert.equal(data.carbs, operation === 'Move carbs' ? 20 : undefined);
              assert.equal(data.insulin, operation === 'Move insulin' ? 2 : undefined);
            }
          }
        });
      });
    }
  }
});
