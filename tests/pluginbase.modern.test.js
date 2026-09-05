'use strict';

/*
 * pluginbase.modern.test.js
 *
 * Track 1, Phase 3.2 — modern jsdom replacement for pluginbase.test.js.
 *
 * pluginbase.js manipulates jQuery selections directly (find, append,
 * attr, html, ...). We use real jQuery on a hermetic jsdom rather than
 * the legacy bundle path, so the same lib code runs against real DOM
 * APIs without dragging in benv or the webpack bundle.
 */

const should = require('should');
const { createSecureDOM } = require('./fixtures/secure-jsdom');
const { installDomGlobals, restoreDomGlobals } = require('./fixtures/dom-globals');

describe('pluginbase (modern jsdom)', function () {

  let env, $, state;

  function d3Selection (element) {
    const selection = {
      node: function () {
        return element[0];
      },
      style: function (name, value) {
        element.css(name, value);
        return selection;
      }
    };

    return selection;
  }

  beforeEach(function () {
    env = createSecureDOM('<!DOCTYPE html><html><body></body></html>');
    state = installDomGlobals(env);
    $ = env.window.$;
  });

  afterEach(function () {
    restoreDomGlobals(state);
    delete require.cache[require.resolve('../lib/plugins/pluginbase')];
  });

  it('updatePillText creates a pill in the matching container', function () {
    function div (clazz) {
      return $('<div class="' + clazz + '"></div>');
    }

    const container   = div('container');
    const bgStatus    = div('bgStatus').appendTo(container);
    const majorPills  = div('majorPills').appendTo(bgStatus);
    const minorPills  = div('minorPills').appendTo(bgStatus);
    const statusPills = div('statusPills').appendTo(bgStatus);
    const tooltip     = div('tooltip').appendTo(container);

    const fake = {
      name: 'fake',
      label: 'Insulin-on-Board',
      pluginType: 'pill-major'
    };

    const pluginbase = require('../lib/plugins/pluginbase')(
      majorPills, minorPills, statusPills, bgStatus, tooltip
    );

    pluginbase.updatePillText(fake, {
      value: '123',
      label: 'TEST',
      info: [{ label: 'Label', value: 'Value' }]
    });

    majorPills.length.should.equal(1);
    majorPills.find('span.pill.fake').length.should.equal(1);
    majorPills.find('span.pill.fake em').text().should.equal('123');
  });

  it('renders tooltip labels and values as text inside owned markup', function () {
    function div (clazz) {
      return $('<div class="' + clazz + '"></div>');
    }

    const container   = div('container').appendTo('body');
    const bgStatus    = div('bgStatus').appendTo(container);
    const majorPills  = div('majorPills').appendTo(bgStatus);
    const minorPills  = div('minorPills').appendTo(bgStatus);
    const statusPills = div('statusPills').appendTo(bgStatus);
    const tooltipNode = div('tooltip').appendTo(container);
    const tooltip     = d3Selection(tooltipNode);

    const fake = {
      name: 'fake',
      pluginType: 'pill-major'
    };

    const pluginbase = require('../lib/plugins/pluginbase')(
      majorPills, minorPills, statusPills, bgStatus, tooltip
    );

    pluginbase.updatePillText(fake, {
      value: '123',
      label: 'TEST',
      info: [
        {
          label: '<img src=x onerror="window.injected=true">Label',
          value: '<script>window.injected=true</script>Value'
        },
        {
          label: 'Encoded &amp; label',
          value: 'Fish &amp; Chips &lt; 70'
        }
      ]
    });

    majorPills.find('span.pill.fake').trigger($.Event('mouseover', {pageX: 10, pageY: 20}));

    tooltipNode.find('strong').length.should.equal(2);
    tooltipNode.find('br').length.should.equal(1);
    tooltipNode.find('img, script').length.should.equal(0);
    tooltipNode.find('strong').eq(0).text().should.equal('<img src=x onerror="window.injected=true">Label');
    tooltipNode[0].childNodes[1].textContent.should.equal(' <script>window.injected=true</script>Value');
    tooltipNode.find('strong').eq(1).text().should.equal('Encoded & label');
    tooltipNode[0].lastChild.textContent.should.equal(' Fish & Chips < 70');
    should(env.window.injected).equal(undefined);
  });

  it('keeps one handler per event and only the latest tooltip data after repeated updates', function () {
    const container = $('<div>').appendTo('body');
    const major = $('<div>').appendTo(container);
    const tooltipNode = $('<div>').appendTo(container);
    let renders = 0;
    const tooltip = d3Selection(tooltipNode);
    const style = tooltip.style;
    tooltip.style = function (name, value) {
      if (name === 'display' && value === 'block') renders++;
      return style(name, value);
    };
    const base = require('../lib/plugins/pluginbase')(major, major, major, major, tooltip);
    const plugin = {name: 'repeat', pluginType: 'pill-major'};
    let foreignOver = 0, foreignOut = 0;
    base.updatePillText(plugin, {info: [{label: 'Update', value: 0}]});
    const pill = major.find('.repeat');
    pill.on('mouseover.anotherPlugin', function () { foreignOver++; });
    pill.on('mouseout.anotherPlugin', function () { foreignOut++; });

    [1, 2, 100].forEach(function (count) {
      for (let i = 1; i <= count; i++) {
        base.updatePillText(plugin, {info: [{label: 'Update', value: i}]});
      }
      const events = $._data(pill[0], 'events');
      const previousRenders = renders;
      pill.trigger($.Event('mouseover', {pageX: 10, pageY: 20}));
      renders.should.equal(previousRenders + 1);
      events.mouseover.length.should.equal(2);
      events.mouseout.length.should.equal(2);
      tooltipNode.text().should.equal('Update ' + count);
      tooltipNode.css('display').should.equal('block');
      pill.trigger('mouseout');
      tooltipNode.css('display').should.equal('none');
    });
    foreignOver.should.equal(3);
    foreignOut.should.equal(3);

    // Removing info while visible clears both owned handlers and the visible tooltip.
    pill.trigger($.Event('mouseover', {pageX: 10, pageY: 20}));
    base.updatePillText(plugin, {});
    tooltipNode.css('display').should.equal('none');
    Object.values($._data(pill[0], 'events')).flat().filter(handler => handler.namespace === 'pillTooltip').length.should.equal(0);
    const previousRenders = renders;
    pill.trigger('mouseover');
    pill.trigger('mouseout');
    renders.should.equal(previousRenders);
    foreignOver.should.equal(5);
    foreignOut.should.equal(4);

    base.updatePillText(plugin, {info: [{label: 'New', value: 'current'}]});
    pill.trigger($.Event('mouseover', {pageX: 10, pageY: 20}));
    tooltipNode.text().should.equal('New current');
    const node = pill[0];
    pill.remove();
    should($._data(node, 'events')).equal(undefined);
  });

  it('does not hide another pill tooltip when an inactive pill loses its info', function () {
    const container = $('<div>').appendTo('body');
    const pills = $('<div>').appendTo(container);
    const tooltipNode = $('<div>').appendTo(container);
    const base = require('../lib/plugins/pluginbase')(pills, pills, pills, pills, d3Selection(tooltipNode));
    const first = {name: 'first'}, second = {name: 'second'};
    base.updatePillText(first, {info: [{label: 'First', value: 1}]});
    base.updatePillText(second, {info: [{label: 'Second', value: 2}]});
    pills.find('.second').trigger($.Event('mouseover', {pageX: 10, pageY: 20}));
    base.updatePillText(first, {info: []});
    tooltipNode.css('display').should.equal('block');
    tooltipNode.text().should.equal('Second 2');
  });

});
