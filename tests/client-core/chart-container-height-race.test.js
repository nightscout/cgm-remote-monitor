'use strict';

const assert = require('assert');
const d3 = require('../fixtures/d3');
const { createSecureDOM } = require('../fixtures/secure-jsdom');
const { installDomGlobals, restoreDomGlobals } = require('../fixtures/dom-globals');
const makeChart = require('../fixtures/d3-chart');

// Regression test for a race between chart.update() and the #chartContainer
// element's CSS layout: getBoundingClientRect() can report height:0 on the
// very first update() call (e.g. a cold page load, before layout settles).
// Before the fix, that produced a negative chart.contextHeight/focusHeight,
// which get applied as invalid negative-height <rect> attributes -- silently
// dropped by real browsers, but leaving the chart with degenerate geometry
// until a later update() call happens to measure the container correctly.
describe('chart.update() with an unmeasured (0-height) container', function () {
  let env, state, client;

  beforeEach(function () {
    env = createSecureDOM('<!DOCTYPE html><html><body></body></html>');
    state = installDomGlobals(env);
    client = makeChart(d3, env.window);
  });

  afterEach(function () {
    restoreDomGlobals(state);
  });

  it('never derives a negative contextHeight/focusHeight', function () {
    env.window.document.querySelector('#chartContainer').getBoundingClientRect =
      () => ({ width: 900, height: 0 });

    client.chart.update(false);

    assert.ok(client.chart.contextHeight >= 0,
      'contextHeight went negative: ' + client.chart.contextHeight);
    assert.ok(client.chart.focusHeight >= 0,
      'focusHeight went negative: ' + client.chart.focusHeight);
  });

  it('never applies a negative height to the brush rect', function () {
    env.window.document.querySelector('#chartContainer').getBoundingClientRect =
      () => ({ width: 900, height: 0 });

    client.chart.update(false);

    const brushHeight = +client.chart.theBrush.selectAll('rect').attr('height');
    assert.ok(brushHeight >= 0, 'brush rect height went negative: ' + brushHeight);
  });

  it('still renders correctly once the container is measured properly', function () {
    // simulates the container reporting 0 on the first pass, then a real
    // size on the next update() call -- the self-healing path this bug
    // relies on, which the fix must not break.
    env.window.document.querySelector('#chartContainer').getBoundingClientRect =
      () => ({ width: 900, height: 0 });
    client.chart.update(false);

    env.window.document.querySelector('#chartContainer').getBoundingClientRect =
      () => ({ width: 900, height: 600 });
    client.chart.update(false);

    assert.strictEqual(client.chart.focusHeight, (600 - 30) * .7);
    assert.strictEqual(client.chart.contextHeight, (600 - 30) * .3);
  });
});
