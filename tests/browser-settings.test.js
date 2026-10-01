'use strict';

require('should');

var createSecureDOM = require('./fixtures/secure-jsdom').createSecureDOM;
var domGlobals = require('./fixtures/dom-globals');

describe('browser settings', function () {
  var env;
  var state;
  var $;
  var browserSettings;

  beforeEach(function () {
    env = createSecureDOM(
      '<!DOCTYPE html><html><body>' +
      '<select id="bolusRenderOver"></select>' +
      '<select id="bolusRenderFormat"></select>' +
      '<select id="bolusRenderFormatSmall"></select>' +
      '</body></html>'
    );
    state = domGlobals.installDomGlobals(env);
    domGlobals.defineConfigurable(global, 'location', env.window.location);
    $ = env.window.$;

    delete require.cache[require.resolve('../lib/client/browser-settings')];
    browserSettings = require('../lib/client/browser-settings');
  });

  afterEach(function () {
    delete require.cache[require.resolve('../lib/client/browser-settings')];
    delete global.location;
    domGlobals.restoreDomGlobals(state);
  });

  it('sorts bolus render-over options numerically in descending order', function () {
    function translate (text, options) {
      return options && options.params ? text.replace('%1', options.params[0]) : text;
    }

    var client = {
      browserUtils: { reload: function () {} }
      , language: { languages: [], translate: translate }
      , plugins: {
        specialPlugins: []
        , eachEnabledPlugin: function () {}
      }
      , translate: translate
      , utils: { scaleMgdl: function (value) { return value; } }
    };
    var serverSettings = {
      settings: {
        enable: 'bolus'
        , showPlugins: 'bolus'
        , thresholds: {
          bgHigh: 260
          , bgTargetTop: 180
          , bgTargetBottom: 80
          , bgLow: 55
        }
        , units: 'mg/dl'
      }
      , extendedSettings: {
        bolus: {
          renderOver: 10
          , renderFormat: 'default'
          , renderFormatSmall: 'default'
        }
      }
    };

    client.settings = browserSettings(client, serverSettings, $);
    browserSettings.loadAndWireForm();

    $('#bolusRenderOver option').map(function () {
      return Number($(this).val());
    }).get().should.deepEqual([10, 5, 1, 0.5, 0.1]);
    $('#bolusRenderOver').val().should.equal('10');
  });
});
