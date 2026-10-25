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

  it('titles a pill with its plugin label so the acronym is explained', function () {
    function div (clazz) {
      return $('<div class="' + clazz + '"></div>');
    }

    const container   = div('container').appendTo('body');
    const bgStatus    = div('bgStatus').appendTo(container);
    const majorPills  = div('majorPills').appendTo(bgStatus);
    const minorPills  = div('minorPills').appendTo(bgStatus);
    const statusPills = div('statusPills').appendTo(bgStatus);
    const tooltip     = div('tooltip').appendTo(container);

    const fake = {
      name: 'iage',
      label: 'Insulin Age',
      pluginType: 'pill-minor'
    };

    function translate (text) {
      return text === 'Insulin Age' ? 'Insulinalter' : text;
    }

    const pluginbase = require('../lib/plugins/pluginbase')(
      majorPills, minorPills, statusPills, bgStatus, tooltip, null, translate
    );

    pluginbase.updatePillText(fake, { value: '3d1h', label: 'IAGE' });

    minorPills.find('span.pill.iage').attr('title').should.equal('Insulinalter');
  });

  it('does not also set a title when the pill has its own tooltip', function () {
    function div (clazz) {
      return $('<div class="' + clazz + '"></div>');
    }

    const container   = div('container').appendTo('body');
    const bgStatus    = div('bgStatus').appendTo(container);
    const majorPills  = div('majorPills').appendTo(bgStatus);
    const minorPills  = div('minorPills').appendTo(bgStatus);
    const statusPills = div('statusPills').appendTo(bgStatus);
    const tooltip     = div('tooltip').appendTo(container);

    const fake = {
      name: 'iob',
      label: 'Insulin-on-Board',
      pluginType: 'pill-major'
    };

    const pluginbase = require('../lib/plugins/pluginbase')(
      majorPills, minorPills, statusPills, bgStatus, tooltip
    );

    pluginbase.updatePillText(fake, {
      value: '2.5U',
      label: 'IOB',
      info: [{ label: 'Source', value: 'care portal' }]
    });

    should.not.exist(majorPills.find('span.pill.iob').attr('title'));
  });

  it('falls back to the plugin name when a plugin carries no label', function () {
    function div (clazz) {
      return $('<div class="' + clazz + '"></div>');
    }

    const container   = div('container').appendTo('body');
    const bgStatus    = div('bgStatus').appendTo(container);
    const majorPills  = div('majorPills').appendTo(bgStatus);
    const minorPills  = div('minorPills').appendTo(bgStatus);
    const statusPills = div('statusPills').appendTo(bgStatus);
    const tooltip     = div('tooltip').appendTo(container);

    const fake = { name: 'fake', pluginType: 'pill-major' };

    const pluginbase = require('../lib/plugins/pluginbase')(
      majorPills, minorPills, statusPills, bgStatus, tooltip, null, function (t) { return t; }
    );

    pluginbase.updatePillText(fake, { value: '1', label: 'X' });

    majorPills.find('span.pill.fake').attr('title').should.equal('fake');
  });

  it('switches between a native title and custom tooltip as pill data changes', function () {
    const container = $('<div>').appendTo('body');
    const bgStatus = $('<div>').appendTo(container);
    const majorPills = $('<div>').appendTo(bgStatus);
    const minorPills = $('<div>').appendTo(bgStatus);
    const statusPills = $('<div>').appendTo(bgStatus);
    const tooltip = $('<div>').appendTo(container);
    const base = require('../lib/plugins/pluginbase')(
      majorPills, minorPills, statusPills, bgStatus, d3Selection(tooltip), null, value => value
    );
    const plugin = { name: 'delta', label: 'BG Delta', pluginType: 'pill-major' };
    base.updatePillText(plugin, { label: 'mg/dl', value: 5 });
    const pill = majorPills.find('.delta');
    pill.attr('title').should.equal('BG Delta');

    base.updatePillText(plugin, { label: 'mg/dl', value: 5, info: [{ label: 'Device', value: 'CGM' }] });
    should.not.exist(pill.attr('title'));
    pill.trigger($.Event('mouseover', { pageX: 0, pageY: 0 }));
    tooltip.text().should.containEql('CGM');
    tooltip.css('display').should.not.equal('none');
    pill.trigger('mouseout');

    base.updatePillText(plugin, { label: 'mg/dl', value: 6 });
    pill.attr('title').should.equal('BG Delta');
    pill.trigger('mouseover');
    tooltip.css('display').should.equal('none');
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

});
