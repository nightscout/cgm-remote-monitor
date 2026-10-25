'use strict';

const assert = require('assert');
const trace = require('../../lib/client/glucose-trace');
const d3 = require('../fixtures/d3');
const {createSecureDOM} = require('../fixtures/secure-jsdom');
const {installDomGlobals, restoreDomGlobals} = require('../fixtures/dom-globals');
const makeChart = require('../fixtures/d3-chart');

const minute = 60000;
function point (time, mgdl, extra) {
  return Object.assign({mills: 1700000000000 + time * minute, mgdl: mgdl || 100, color: 'yellow', type: 'sgv'}, extra);
}

describe('glucose trace semantics', function () {
  it('breaks at a missing reading for both 1-minute and 5-minute sources', function () {
    [1, 5].forEach(cadence => {
      const runs = trace.segments([0, 1, 2, 4, 5, 6].map(time => point(time * cadence)));
      assert.strictEqual(runs.length, 2);
      assert.strictEqual(runs[0].points.length, 3);
      assert.strictEqual(runs[1].points.length, 3);
    });
  });
  it('does not connect across errors, invalid values, transparent points, or long gaps', function () {
    [point(2, 12), point(2, NaN, {mgdl: NaN}), point(2, 100, {color: 'transparent'})].forEach(bad => {
      const runs = trace.segments([point(0), point(1), bad, point(3), point(4)]);
      assert.strictEqual(runs.length, 2);
    });
    assert.strictEqual(trace.segments([point(0), point(30)]).length, 0);
  });
  it('sorts a copy, keeps exact sample values, and preserves colour transitions', function () {
    const points = [point(2, 160), point(0, 140, {color: 'green'}), point(1, 150, {color: 'green'})];
    const before = JSON.stringify(points);
    const runs = trace.segments(points);
    assert.strictEqual(JSON.stringify(points), before);
    assert.deepStrictEqual(runs.map(run => run.color), ['green', 'yellow']);
    assert.strictEqual(runs[0].points[0], points[1]);
    assert.strictEqual(runs[1].points[1], points[0]);
  });
  it('keeps forecast providers and AR2 cone branches separate, including low predictions', function () {
    const predictions = [];
    ['upper', 'lower'].forEach(branch => [5, 10, 15].forEach(time => {
      predictions.push(point(time, 36, {forecastSeries: branch, info: {type: 'ar2'}}));
    }));
    [5, 10].forEach(time => predictions.push(point(time, 100, {info: {type: 'loop'}})));
    const runs = trace.forecasts(predictions);
    assert.strictEqual(runs.length, 3);
    runs.forEach(run => {
      assert.strictEqual(new Set(run.points.map(p => JSON.stringify([p.info.type, p.forecastSeries]))).size, 1);
    });
  });
});

describe('modern chart integration', function () {
  let env, state, client;
  beforeEach(function () {
    env = createSecureDOM('<!doctype html><html><body></body></html>');
    state = installDomGlobals(env);
    client = makeChart(d3, env.window, 'mmol', {width: 390, theme: 'modern'});
    const start = client.now - 30 * minute;
    client.entries = [0, 5, 10, 20, 25, 30].map(time => ({mills: start + time * minute, mgdl: 180 + time, type: 'sgv', color: 'yellow'}));
    client.latestSGV = client.entries[5];
  });
  afterEach(function () { restoreDomGlobals(state); });
  it('draws clipped curves with a visible gap and a latest-reading marker', function () {
    client.settings.showForecast = 'test';
    client.sbx.pluginBase.forecastPoints.test = [{mills: client.now + minute, mgdl: 210, type: 'forecast', color: 'cyan'}];
    client.renderer.addFocusCircles();
    const paths = env.window.document.querySelectorAll('.chart-focus .modern-trace');
    assert.strictEqual(paths.length, 2);
    paths.forEach(p => {
      assert.ok(/C/.test(p.getAttribute('d')), 'curves connect each uninterrupted run');
      assert.ok(!/NaN/.test(p.getAttribute('d')));
    });
    assert.ok(env.window.document.querySelector('.chart-focus .modern-plot').getAttribute('clip-path'));
    const dots = env.window.document.querySelectorAll('.entry-dot');
    assert.strictEqual(dots.length, 6);
    assert.strictEqual(+dots[5].getAttribute('r'), 4.5);
    assert.strictEqual(+dots[0].getAttribute('r'), 1.3);
    assert.strictEqual(+dots[0].getAttribute('stroke-width'), 12, 'small dots retain their touch targets');
    const forecast = env.window.document.querySelector('.forecast-dot');
    assert.ok(forecast.compareDocumentPosition(dots[5]) & 4, 'latest observation must be above forecast hit targets');
  });
  ['linear', 'log'].forEach(scaleY => ['mmol', 'mg/dl'].forEach(units => {
    it('smooths the trend within observed bounds while retaining exact readings on ' + scaleY + ' scales in ' + units, function () {
      client = makeChart(d3, env.window, units, {width: 900, theme: 'modern', scaleY});
      client.entries = [140, 300, 80, 80, 260, 40].map((mgdl, index) => ({
        mills: client.now - (5 - index) * 5 * minute, mgdl, type: 'sgv', color: 'yellow'
      }));
      const original = client.entries.map(p => [p.mills, p.mgdl]);
      client.latestSGV = client.entries[5];
      client.renderer.addFocusCircles();
      client.renderer.addContextCircles();
      ['focus', 'context'].forEach(layer => {
        const path = env.document.querySelector('.chart-' + layer + ' .modern-trace');
        const x = layer === 'focus' ? client.chart.xScale : client.chart.xScale2;
        const y = layer === 'focus' ? client.chart.yScale : client.chart.yScale2;
        const expected = client.entries.map(p => [x(new Date(p.mills)), y(client.sbx.scaleEntry(p))]);
        const commands = Array.from(path.getAttribute('d').matchAll(/([MLC])([^MLCZ]*)/g));
        commands.forEach(command => {
          const values = command[2].split(',').map(Number);
          // A basis curve stays within its observed control-point hull.
          for (let control = 0; control < values.length; control += 2) {
            [0, 1].forEach(axis => {
              assert.ok(values[control + axis] >= Math.min(...expected.map(p => p[axis])) - 0.001);
              assert.ok(values[control + axis] <= Math.max(...expected.map(p => p[axis])) + 0.001);
            });
          }
        });
        const first = commands[0][2].split(',').map(Number);
        const last = commands[commands.length - 1][2].split(',').map(Number).slice(-2);
        [0, 1].forEach(axis => {
          assert.ok(Math.abs(first[axis] - expected[0][axis]) < 0.001);
          assert.ok(Math.abs(last[axis] - expected[expected.length - 1][axis]) < 0.001);
        });
        const dots = env.document.querySelectorAll('.chart-' + layer + ' circle' + (layer === 'focus' ? '.entry-dot' : ''));
        assert.strictEqual(dots.length, client.entries.length);
        dots.forEach((dot, index) => {
          assert.ok(Math.abs(+dot.getAttribute('cx') - expected[index][0]) < 0.001);
          assert.ok(Math.abs(+dot.getAttribute('cy') - expected[index][1]) < 0.001);
        });
      });
      assert.deepStrictEqual(client.entries.map(p => [p.mills, p.mgdl]), original);
      assert.strictEqual(env.document.querySelector('.modern-trace-label').textContent, 'Smoothed trend');
    });
  }));
  it('keeps urgent, isolated and latest readings visible while hiding connected sample bumps', function () {
    client.entries[1].color = 'red';
    const isolated = {mills: client.now - 90 * minute, mgdl: 150, color: 'yellow', type: 'sgv'};
    client.entries.unshift(isolated);
    client.renderer.addFocusCircles();
    const dots = Array.from(env.document.querySelectorAll('.entry-dot'));
    dots.forEach(dot => {
      const p = dot.__data__;
      const shouldHide = p !== isolated && p.color !== 'red' && p !== client.latestSGV;
      assert.strictEqual(dot.classList.contains('modern-connected-sample'), shouldHide);
    });
  });
  it('curves forecast branches separately and keeps their hit targets', function () {
    client.settings.showForecast = 'test';
    client.sbx.pluginBase.forecastPoints.test = ['upper', 'lower'].flatMap((branch, index) => [0, 5, 10].map(time => ({
      mills: client.now + time * minute, mgdl: 210 + (index ? -time : time), type: 'forecast', color: 'cyan',
      forecastSeries: branch, info: {type: 'ar2'}
    })));
    client.renderer.addFocusCircles();
    const paths = env.document.querySelectorAll('.modern-forecast-line');
    assert.strictEqual(paths.length, 2);
    paths.forEach(path => assert.ok(/C/.test(path.getAttribute('d'))));
    assert.strictEqual(env.document.querySelectorAll('.forecast-dot').length, 6);
    assert.strictEqual(env.document.querySelector('.forecast-dot').getAttribute('fill'), 'transparent');
  });
  ['sgv', 'mbg', 'forecast'].forEach(type => {
    it('emphasizes the hovered ' + type + ' point at its exact coordinates without changing hit targets', function () {
      let selector = '.entry-dot';
      if (type === 'forecast') {
        selector = '.forecast-dot';
        client.settings.showForecast = 'test';
        client.sbx.pluginBase.forecastPoints.test = [{mills: client.now + minute, mgdl: 210, type, color: 'cyan'}];
      } else if (type === 'mbg') {
        client.entries.unshift({mills: client.now - minute, mgdl: 140, type, color: 'green', device: 'Meter'});
      }
      client.renderer.addFocusCircles();
      const dot = env.document.querySelector(selector);
      const radius = dot.getAttribute('r');
      const stroke = dot.getAttribute('stroke-width');
      dot.dispatchEvent(new env.window.MouseEvent('mouseover', {bubbles: true, clientX: 50, clientY: 80}));
      const marker = env.document.querySelector('.modern-hover-dot');
      assert.ok(marker);
      assert.strictEqual(marker.getAttribute('cx'), dot.getAttribute('cx'));
      assert.strictEqual(marker.getAttribute('cy'), dot.getAttribute('cy'));
      assert.strictEqual(marker.getAttribute('fill'), dot.__data__.color);
      assert.strictEqual(marker.getAttribute('pointer-events'), 'none');
      assert.ok(+marker.getAttribute('r') >= 5.5);
      assert.strictEqual(dot.getAttribute('r'), radius);
      assert.strictEqual(dot.getAttribute('stroke-width'), stroke);
      assert.ok(client.tooltip.text().includes('BG: ' + client.sbx.scaleEntry(dot.__data__)));
      dot.dispatchEvent(new env.window.MouseEvent('mouseout', {bubbles: true}));
      assert.strictEqual(env.document.querySelector('.modern-hover-dot'), null);
      assert.strictEqual(client.tooltip.style('display'), 'none');
      assert.strictEqual(dot.getAttribute('r'), radius);
    });
  });
  it('keeps latest-reading emphasis aligned through redraw and clears it when the source disappears', function () {
    client.renderer.addFocusCircles();
    const dot = Array.from(env.document.querySelectorAll('.entry-dot')).find(dot => +dot.getAttribute('r') === 4.5);
    dot.dispatchEvent(new env.window.MouseEvent('mouseover', {bubbles: true, clientX: 50, clientY: 80}));
    assert.strictEqual(+env.document.querySelector('.modern-hover-dot').getAttribute('r'), 6.5);
    client.layout.width = 1200;
    client.chart.update(false);
    client.renderer.addFocusCircles();
    assert.strictEqual(env.document.querySelector('.modern-hover-dot').getAttribute('cx'), dot.getAttribute('cx'));
    assert.strictEqual(+dot.getAttribute('r'), 4.5);
    client.entries = client.entries.filter(p => p !== client.latestSGV);
    client.renderer.addFocusCircles();
    assert.strictEqual(env.document.querySelector('.modern-hover-dot'), null);
    assert.strictEqual(client.tooltip.style('display'), 'none');
  });
  it('leaves classic point hover styling unchanged', function () {
    client.settings.theme = 'default';
    client.renderer.addFocusCircles();
    const dot = env.document.querySelector('.entry-dot');
    const radius = dot.getAttribute('r');
    dot.dispatchEvent(new env.window.MouseEvent('mouseover', {bubbles: true, clientX: 50, clientY: 80}));
    assert.strictEqual(env.document.querySelector('.modern-hover-dot'), null);
    assert.strictEqual(dot.getAttribute('r'), radius);
    assert.strictEqual(client.tooltip.style('display'), 'block');
  });
  it('keeps finger-stick points distinct and out of the connected trace', function () {
    client.entries.push({mills: client.now - minute, mgdl: 140, type: 'mbg', color: 'red'});
    client.renderer.addFocusCircles();
    assert.strictEqual(env.window.document.querySelectorAll('.entry-dot').length, 7);
    assert.strictEqual(env.window.document.querySelectorAll('.modern-trace[stroke="red"]').length, 0);
  });
  it('redraws coordinates and brush extent after a resize', function () {
    client.renderer.addFocusCircles();
    const before = env.window.document.querySelector('.modern-trace').getAttribute('d');
    client.layout.width = 1200;
    client.chart.update(false);
    client.renderer.addFocusCircles();
    assert.notStrictEqual(env.window.document.querySelector('.modern-trace').getAttribute('d'), before);
    assert.strictEqual(client.chart.prevChartWidth, 1176);
    assert.strictEqual(client.chart.brush.extent()()[1][0], 1176);
  });
  it('leaves classic rendering dot-only', function () {
    client.settings.theme = 'default';
    // An actual classic page starts without any modern layers.
    env.window.document.querySelectorAll('.modern-lines').forEach(el => el.remove());
    client.renderer.addFocusCircles();
    assert.strictEqual(env.window.document.querySelectorAll('.modern-trace').length, 0);
    assert.strictEqual(+env.window.document.querySelector('.entry-dot').getAttribute('r'), 2);
  });
});
