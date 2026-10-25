'use strict';

const assert = require('assert');
const d3 = require('../fixtures/d3');
const {createSecureDOM} = require('../fixtures/secure-jsdom');
const {installDomGlobals, restoreDomGlobals} = require('../fixtures/dom-globals');
const makeChart = require('../fixtures/d3-chart');

describe('modern basal rendering', function () {
  let env, state;
  beforeEach(function () {
    env = createSecureDOM();
    state = installDomGlobals(env);
    env.window.SVGElement.prototype.getBBox = () => ({width: 70});
  });
  afterEach(function () { restoreDomGlobals(state); env.cleanup(); });

  function render (theme, mode, zero) {
    const client = makeChart(d3, env.window, 'mmol', {width: 390, theme});
    const range = client.chart.createAdjustedRange().map(d => +d);
    const middle = (range[0] + range[1]) / 2;
    client.settings.isEnabled = () => true;
    client.settings.extendedSettings = {basal: {render: mode}};
    client.sbx.data = {profile: {
      activeProfileToTime: () => ({}),
      getBasalRenderTimes: () => [range[0], middle],
      getTempBasal: date => ({basal: zero ? 0 : 1, totalbasal: zero || date >= middle ? 0 : 1, treatment: date >= middle})
    }};
    client.ddata.tempbasalTreatments = [
      {mills: middle, duration: 30, absolute: 0},
      // Mostly outside the viewport: its label must fit the visible interval.
      {mills: range[0] - 3600000, duration: 61, absolute: 1}
    ];
    client.renderer.addBasals(client);
    return client;
  }

  ['default', 'icicle'].forEach(mode => {
    it('preserves exact stepped rates and suspension in ' + mode + ' mode', function () {
      const client = render('modern', mode);
      const line = env.document.querySelector('.basalline');
      const path = line.getAttribute('d');
      assert.ok(path.includes('L') && !/[CQ]|NaN|Infinity/.test(path));
      const range = client.chart.createAdjustedRange().map(d => +d);
      const middleX = client.chart.xScaleBasals((range[0] + range[1]) / 2);
      const scheduledY = client.chart.yScaleBasals(1);
      const suspendedY = client.chart.yScaleBasals(0);
      assert.strictEqual(path, d3.line().x(d => d[0]).y(d => d[1]).curve(d3.curveStepAfter)([
        [client.chart.xScaleBasals(range[0]), scheduledY], [middleX, suspendedY],
        [client.chart.xScaleBasals(range[1]), suspendedY]
      ]));
      assert.strictEqual(scheduledY < suspendedY, mode === 'default');
      assert.ok(client.chart.basalsHeight <= 72);
      assert.ok(line.compareDocumentPosition(env.document.querySelector('.tempbasalarea')) & 2,
        'fills stay below delivery boundaries');
      assert.strictEqual(env.document.querySelector('.tempbasaltext').textContent, '0.00 U/h');
      assert.strictEqual(env.document.querySelectorAll('.tempbasaltext')[1].getAttribute('display'), 'none');
      client.renderer.addBasals(client);
      assert.strictEqual(env.document.querySelectorAll('#modern-basal-fill').length, 1);
    });
    it('handles an entirely zero-rate profile in ' + mode + ' mode', function () {
      const client = render('modern', mode, true);
      assert.ok(!/NaN|Infinity/.test(env.document.querySelector('.basalline').getAttribute('d')));
      assert.strictEqual(client.chart.yScaleBasals(0), mode === 'icicle' ? 24 : client.chart.basalsHeight);
    });
  });

  it('keeps classic chart sizing, paint and labels unchanged', function () {
    const client = render('colors', 'default');
    assert.strictEqual(client.chart.basalsHeight, client.chart.focusHeight / 4);
    assert.deepStrictEqual(client.chart.yScaleBasals.range(), [0, client.chart.focusHeight / 4]);
    assert.strictEqual(env.document.querySelector('.basalarea').getAttribute('fill'), '#0099ff');
    assert.strictEqual(env.document.querySelector('.tempbasaltext').textContent, '0.00U');
    assert.strictEqual(env.document.querySelector('#modern-basal-fill'), null);
  });
});
