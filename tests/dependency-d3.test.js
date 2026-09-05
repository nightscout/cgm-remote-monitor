'use strict';

const assert = require('assert');
const d3 = require('./fixtures/d3');
const { createSecureDOM } = require('./fixtures/secure-jsdom');
const { installDomGlobals, restoreDomGlobals } = require('./fixtures/dom-globals');
const makeChart = require('./fixtures/d3-chart');

describe('D3 chart interaction compatibility', function () {
  let env, state, client, errors;
  beforeEach(function () {
    env = createSecureDOM('<!DOCTYPE html><html><body></body></html>');
    state = installDomGlobals(env);
    errors = [];
    env.window.addEventListener('error', event => { errors.push(event.error); event.preventDefault(); });
    client = makeChart(d3, env.window);
  });
  afterEach(function () {
    restoreDomGlobals(state);
    assert.deepStrictEqual(errors, [], 'DOM event handlers must not throw');
  });
  function mouse(target, type, x, y, buttons) {
    target.dispatchEvent(new env.window.MouseEvent(type, {
      bubbles: true, cancelable: true, view: env.window,
      clientX: x, clientY: y, buttons: buttons || 0
    }));
  }
  function touch(target, type, x, y) {
    const point = {identifier: 1, target: target, clientX: x, clientY: y, pageX: x, pageY: y};
    const event = new env.window.Event(type, {bubbles: true, cancelable: true});
    Object.defineProperties(event, {
      touches: {value: type === 'touchend' ? [] : [point]},
      changedTouches: {value: [point]}, targetTouches: {value: type === 'touchend' ? [] : [point]}
    });
    target.dispatchEvent(event);
  }
  ['mg/dl', 'mmol'].forEach(function (units) {
    it('preserves glucose/forecast positions and hover data in ' + units, function () {
      client = makeChart(d3, env.window, units);
      const entry = {type: 'sgv', mills: client.now - 3600000, mgdl: 126, color: 'green'};
      client.entries = [entry];
      client.chart.getForecastData = () => [{type: 'forecast', forecastType: 'IOB', mills: client.now, mgdl: 144, color: 'blue'}];
      client.renderer.addFocusCircles();
      const dot = client.chart.focus.select('.entry-dot');
      assert.strictEqual(+dot.attr('cx'), 600);
      assert.strictEqual(+dot.attr('cy'), client.chart.yScale(units === 'mmol' ? 7 : 126));
      [dot.node(), client.chart.focus.select('.forecast-dot').node()].forEach(function (node, i) {
        mouse(node, 'mouseover', 100 + i * 750, 50 + i * 20);
        assert.strictEqual(client.tooltip.style('display'), 'block');
        assert.strictEqual(client.tooltip.style('left'), i ? '740px' : '100px');
        assert.strictEqual(client.tooltip.style('top'), i ? '85px' : '65px');
        assert.ok(client.tooltip.text().includes(i ? 'IOB' : String(units === 'mmol' ? 7 : 126)));
        mouse(node, 'mouseout', 0, 0);
        assert.strictEqual(client.tooltip.style('display'), 'none');
      });
      client.entries = [];
      client.renderer.addFocusCircles();
      assert.strictEqual(client.chart.focus.selectAll('.entry-dot').size(), 0);
    });
  });
  ['mouse', 'touch'].forEach(function (input) {
    it('centers, clamps and moves the context brush repeatedly using ' + input, function () {
      const overlay = client.chart.theBrush.select('.overlay').node();
      [450, 10, 890].forEach(function (x) {
        if (input === 'mouse') {
          mouse(overlay, 'mousedown', x, 50, 1);
          mouse(env.window, 'mouseup', x, 50);
        } else {
          touch(overlay, 'touchstart', x, 50);
          touch(overlay, 'touchend', x, 50);
        }
        const left = Math.max(0, Math.min(675, x - 112.5));
        assert.deepStrictEqual(d3.brushSelection(client.chart.theBrush.node()), [left, left + 225]);
        const range = client.chart.createBrushedRange();
        assert.strictEqual(range[1] - range[0], client.focusRangeMS);
      });
    });
  });
  ['mouse', 'touch'].forEach(function (input) {
    it('drags the selected context window using ' + input, function () {
      const overlay = client.chart.theBrush.select('.overlay').node();
      if (input === 'mouse') {
        mouse(overlay, 'mousedown', 450, 50, 1);
        mouse(env.window, 'mousemove', 550, 50, 1);
        mouse(env.window, 'mouseup', 550, 50);
      } else {
        touch(overlay, 'touchstart', 450, 50);
        touch(overlay, 'touchmove', 550, 50);
        touch(overlay, 'touchend', 550, 50);
      }
      assert.deepStrictEqual(d3.brushSelection(client.chart.theBrush.node()), [437.5, 662.5]);
    });
  });
  function treatment(editMode) {
    client.editMode = editMode;
    client.renderer.drawTreatment({_id: 'treatment-1', NSCLIENT_ID: 'old-id', eventType: 'Meal Bolus',
      mills: client.now - 3600000, mgdl: 100, carbs: 20, insulin: 2},
    {scale: 2, showLabels: false, treatments: 1}, 10, {});
    return client.chart.focus.select('.draggable-treatment').node();
  }
  it('keeps treatments read-only when editing is disabled', function () {
    const node = treatment(false);
    assert.strictEqual(d3.select(node).on('mousedown.drag'), undefined);
    mouse(node, 'mouseover', 120, 80);
    assert.ok(client.tooltip.text().includes('Carbs: 20'));
    assert.strictEqual(client.tooltip.style('top'), '95px');
  });
  it('moves a treatment by touch and restores the chart on cancel', function () {
    const emitted = [];
    client.socket = {emit: (...args) => emitted.push(args)};
    env.window.confirm = () => false;
    const node = treatment(true);
    touch(node, 'touchstart', 600, 200);
    touch(node, 'touchmove', 400, 150);
    assert.ok(client.tooltip.text().includes('Move'));
    touch(node, 'touchend', 400, 150);
    assert.deepStrictEqual(emitted, []);
    assert.strictEqual(client.chart.basals.attr('display'), '');
    assert.strictEqual(client.chart.drag.selectAll('.drag-droparea,.arrow').size(), 0);
  });
  it('preserves duration treatment geometry and hover details', function () {
    client.ddata.treatments = [{eventType: 'Exercise', notes: 'Walk & rest',
      mills: client.now - 3600000, duration: 30}];
    client.ddata.tempTargetTreatments = [];
    client.renderer.addTreatmentCircles(new Date(client.now));
    const duration = client.chart.focus.select('.g-duration');
    assert.strictEqual(+duration.select('rect').attr('width'), 150);
    mouse(duration.node(), 'mouseover', 110, 90);
    assert.ok(client.tooltip.text().includes('Walk & rest'));
    assert.strictEqual(client.tooltip.style('left'), '110px');
    assert.strictEqual(client.tooltip.style('top'), '105px');
    mouse(duration.node(), 'mouseout', 0, 0);
    assert.strictEqual(client.tooltip.style('display'), 'none');
  });
  it('preserves profile switch hover details and literal text', function () {
    client.settings.extendedSettings = {basal: {render: 'default'}};
    client.profilefunctions = {listBasalProfiles: () => ['Default', 'Exercise'], activeProfileToTime: () => 'Default'};
    client.ddata.profileTreatments = [{eventType: 'Profile Switch', profile: 'Exercise & rest',
      mills: client.now - 3600000, notes: '<b>literal</b>'}];
    client.renderer.addTreatmentProfiles(client);
    const profile = client.chart.basals.select('.g-profile').node();
    mouse(profile, 'mouseover', 120, 80);
    assert.ok(client.tooltip.text().includes('Exercise & rest'));
    assert.ok(client.tooltip.text().includes('<b>literal</b>'));
    assert.strictEqual(client.tooltip.style('left'), '120px');
    assert.strictEqual(client.tooltip.style('top'), '95px');
    mouse(profile, 'mouseout', 0, 0);
    assert.strictEqual(client.tooltip.style('display'), 'none');
  });
  [
    ['Move', 400, 150, 'dbUpdate'], ['Remove', 20, 150, 'dbRemove'],
    ['Remove carbs', 20, 20, 'dbUpdateUnset'], ['Remove insulin', 20, 380, 'dbUpdateUnset'],
    ['Move carbs', 400, 20, 'dbUpdateUnset'], ['Move insulin', 400, 380, 'dbUpdateUnset']
  ].forEach(function ([operation, x, y, eventName]) {
    [true, false].forEach(function (confirmed) {
      it(operation + ' emits the correct treatment operation only when confirmed=' + confirmed, function () {
        const emitted = [];
        client.socket = {emit: (name, payload, callback) => {
          emitted.push([name, payload]);
          if (callback) callback('ok');
        }};
        env.window.confirm = () => confirmed;
        // Exercise twice to detect retained drag state and listeners.
        for (let i = 0; i < 2; i++) {
          client.chart.focus.selectAll('.draggable-treatment').remove();
          const node = treatment(true);
          mouse(node, 'mousedown', 600, 200, 1);
          assert.strictEqual(client.chart.basals.attr('display'), 'none');
          mouse(env.window, 'mousemove', x, y, 1);
          assert.ok(client.tooltip.text().includes(operation));
          mouse(env.window, 'mouseup', x, y);
          assert.strictEqual(client.chart.drag.selectAll('.drag-droparea,.arrow').size(), 0);
          assert.strictEqual(client.chart.basals.attr('display'), '');
        }
        if (!confirmed) return assert.deepStrictEqual(emitted, []);
        const split = operation === 'Move carbs' || operation === 'Move insulin';
        assert.strictEqual(emitted.length, split ? 4 : 2);
        assert.strictEqual(emitted[0][0], eventName);
        assert.strictEqual(emitted[0][1]._id, 'treatment-1');
        assert.strictEqual(emitted[0][1].collection, 'treatments');
        const movedAt = client.chart.xScale.invert(x).toISOString();
        if (operation === 'Move') assert.deepStrictEqual(emitted[0][1].data, {created_at: movedAt});
        if (operation.includes('carbs')) assert.deepStrictEqual(emitted[0][1].data, {carbs: 1});
        if (operation.includes('insulin')) assert.deepStrictEqual(emitted[0][1].data, {insulin: 1});
        if (split) {
          assert.strictEqual(emitted[1][0], 'dbAdd');
          const data = emitted[1][1].data;
          assert.strictEqual(data.created_at, movedAt);
          assert.strictEqual(data._id, undefined);
          assert.strictEqual(data.NSCLIENT_ID, undefined);
          assert.strictEqual(data.carbs, operation === 'Move carbs' ? 20 : undefined);
          assert.strictEqual(data.insulin, operation === 'Move insulin' ? 2 : undefined);
        }
      });
    });
  });
});

describe('D3 color compatibility and security', function () {
  it('preserves chart colors and interpolation', function () {
    assert.strictEqual(d3.color('green').formatHex(), '#008000');
    assert.strictEqual(d3.color('#0099ff').formatRgb(), 'rgb(0, 153, 255)');
    assert.strictEqual(d3.color('rgba(255, 0, 0, 0.5)').opacity, 0.5);
    assert.strictEqual(d3.interpolateRgb('white', '#0099ff')(0.5), 'rgb(128, 204, 255)');
    assert.strictEqual(d3.color('invalid'), null);
  });

  it('rejects pathological color input without catastrophic backtracking', function () {
    // Separate process gives a hard upper bound even if vulnerable parsing returns.
    this.timeout(6000);
    const result = require('child_process').spawnSync(process.execPath, [
      '-e', "const d3 = require('./tests/fixtures/d3'); const assert = require('assert'); " +
        "assert.strictEqual(d3.color('hsl(' + '1'.repeat(1000000) + '!'), null);"
    ], {cwd: require('path').resolve(__dirname, '..'), timeout: 4000, encoding: 'utf8'});
    assert.ifError(result.error);
    assert.strictEqual(result.status, 0, result.stderr);
  });
});
