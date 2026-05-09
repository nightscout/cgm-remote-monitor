'use strict';

var should = require('should');
var benv = require('benv');

describe('clock client units', function() {
  var $, clockClient;

  function setupClockClient(done) {
    benv.setup(function() {
      $ = require('jquery');
      global.$ = $;

      global.localStorage = {
        getItem: function() {
          return null;
        }
      };

      $('body').html('<div id="inner" data-face="bn0-sg40-dt14-ag6-ar25"></div>');

      delete require.cache[require.resolve('../lib/client/clock-client')];
      clockClient = require('../lib/client/clock-client');

      done();
    });
  }

  function teardownClockClient(done) {
    delete require.cache[require.resolve('../lib/client/clock-client')];
    delete global.$;
    delete global.localStorage;
    clockClient = null;
    benv.teardown(true);
    done();
  }

  function renderProperties(serverUnits, browserUnits, properties) {
    window.serverSettings = {
      settings: {
        units: serverUnits
        , showClockDelta: true
        , showClockLastTime: false
      }
    };

    clockClient.settings = {
      units: browserUnits
      , thresholds: {
        bgHigh: 260
        , bgLow: 55
        , bgTargetBottom: 80
        , bgTargetTop: 180
      }
      , timeFormat: 12
    };
    clockClient.unitMismatch = browserUnits !== serverUnits;

    $.ajax = function(url, opts) {
      should(url).equal('/api/v2/properties');
      opts.success(properties);
    };

    clockClient.query();
  }

  function propertiesWithUnits(scaledBg, deltaDisplay) {
    return {
      bgnow: {
        sgvs: [{
          mgdl: 100
          , scaled: scaledBg
          , mills: Date.now()
          , direction: 'Flat'
        }]
      }
      , delta: {
        mgdl: 5
        , display: deltaDisplay
      }
    };
  }

  beforeEach(setupClockClient);
  afterEach(teardownClockClient);

  it('should render browser mmol preference when server units are mg/dl', function() {
    renderProperties('mg/dl', 'mmol', propertiesWithUnits(100, '+5'));

    $('.sg').html().should.equal('5.6');
    $('.dt').html().should.equal('+0.3');
  });

  it('should render browser mg/dl preference when server units are mmol', function() {
    renderProperties('mmol', 'mg/dl', propertiesWithUnits('5.6', '+0.3'));

    $('.sg').html().should.equal('100');
    $('.dt').html().should.equal('+5');
  });

  it('should use server-scaled values when browser and server units match', function() {
    renderProperties('mmol', 'mmol', propertiesWithUnits('5.6', '+0.3'));

    $('.sg').html().should.equal('5.6');
    $('.dt').html().should.equal('+0.3');
  });
});
