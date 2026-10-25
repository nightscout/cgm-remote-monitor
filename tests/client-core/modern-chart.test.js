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
    it('passes through every reading without overshoot on ' + scaleY + ' scales in ' + units, function () {
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
        let previous;
        let index = 0;
        for (const command of path.getAttribute('d').matchAll(/([MLC])([^MLCZ]*)/g)) {
          const values = command[2].split(',').map(Number);
          const end = values.slice(-2);
          end.forEach((value, axis) => assert.ok(Math.abs(value - expected[index][axis]) < 0.001));
          if (command[1] === 'C') {
            // A cubic remains within its control-point hull. Keeping the controls
            // between the observed endpoints prevents invented peaks or troughs.
            for (let control = 0; control < 4; control += 2) {
              [0, 1].forEach(axis => {
                assert.ok(values[control + axis] >= Math.min(previous[axis], end[axis]) - 0.001);
                assert.ok(values[control + axis] <= Math.max(previous[axis], end[axis]) + 0.001);
              });
            }
          }
          previous = end;
          index++;
        }
        assert.strictEqual(index, client.entries.length);
      });
      assert.deepStrictEqual(client.entries.map(p => [p.mills, p.mgdl]), original);
    });
  }));
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
