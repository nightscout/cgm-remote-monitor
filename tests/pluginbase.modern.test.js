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
const path = require('path');
const { createSecureDOM } = require('./fixtures/secure-jsdom');
const { installDomGlobals, restoreDomGlobals } = require('./fixtures/dom-globals');

describe('pluginbase (modern jsdom)', function () {

  let env, $, state;

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

});
