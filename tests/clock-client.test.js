'use strict';

var should = require('should');
var benv = require('./fixtures/benv-loader');

describe('clock client', function() {
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

  function renderProperties(serverUnits, browserUnits, properties, lowerTarget) {
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
        , bgTargetBottom: lowerTarget === undefined ? 80 : lowerTarget
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

  describe('low and falling emoji', function() {
    function renderEmoji(bg, direction, lowerTarget, browserUnits, stale) {
      $('#inner').attr('data-face', 'bn10-sg40-em40-ar25');
      var properties = propertiesWithUnits(bg, '-5');
      properties.bgnow.sgvs[0].mgdl = bg;
      properties.bgnow.sgvs[0].direction = direction;
      if (stale) {
        properties.bgnow.sgvs[0].mills = Date.now() - 20 * 60 * 1000;
      }
      renderProperties('mg/dl', browserUnits || 'mg/dl', properties, lowerTarget);
      return $('.em').text();
    }

    ['FortyFiveDown', 'SingleDown', 'DoubleDown', 'TripleDown', 'down', 'slightdown'].forEach(function(direction) {
      it('shows concern at 74 with direction ' + direction, function() {
        renderEmoji(74, direction).should.equal('😟');
      });
    });

    ['Flat', 'SingleUp', 'NONE', 'NOT COMPUTABLE', undefined].forEach(function(direction) {
      it('preserves the existing face without a falling trend: ' + direction, function() {
        renderEmoji(74, direction).should.equal('😊');
      });
    });

    it('uses the configured lower target and its boundary', function() {
      renderEmoji(89, 'SingleDown', 90).should.equal('😟');
      renderEmoji(90, 'SingleDown', 90).should.equal('😊');
      renderEmoji(89, 'SingleDown', 80).should.equal('😊');
    });

    it('preserves the existing low-value faces', function() {
      renderEmoji(72, 'SingleDown').should.equal('😱');
      renderEmoji(54, 'DoubleDown').should.equal('🥶');
      renderEmoji(40, 'DoubleDown').should.equal('❌');
    });

    it('uses mg/dL internally when the browser displays mmol/L', function() {
      renderEmoji(74, 'SingleDown', 80, 'mmol').should.equal('😟');
      $('.sg').text().should.equal('4.1');
    });

    it('keeps stale data ahead of the trend warning', function() {
      renderEmoji(74, 'SingleDown', 80, 'mg/dl', true).should.equal('🤷');
    });

    it('uses the same normalized direction for the arrow', function() {
      renderEmoji(74, 'down').should.equal('😟');
      $('.ar img').attr('src').should.equal('/images/SingleDown.svg');
    });
  });

  describe('when the data fetch fails', function() {
    var T0 = Date.parse('2026-09-24T12:00:00Z');
    var RealDate = Date;
    var realSetInterval = global.setInterval;
    var now, timers, failing, calls;

    // Drive the page's own setInterval timers and Date from a manual clock.
    function startClock(face, showClockLastTime) {
      now = T0;
      timers = [];
      failing = false;
      calls = 0;
      global.Date = class FakeDate extends RealDate {
        constructor(...args) {
          if (args.length) { super(...args); } else { super(now); }
        }
        static now() { return now; }
      };
      global.setInterval = function(fn, ms) {
        timers.push({ fn: fn, ms: ms, next: now + ms });
        return timers.length;
      };

      $('#inner').attr('data-face', face);
      window.serverSettings = {
        settings: {
          units: 'mg/dl'
          , showClockDelta: true
          , showClockLastTime: showClockLastTime
          , timeFormat: 24
          , thresholds: { bgHigh: 260, bgLow: 55, bgTargetBottom: 80, bgTargetTop: 180 }
        }
      };

      var reading = {
        bgnow: { sgvs: [{ mgdl: 120, scaled: 120, mills: T0, direction: 'Flat' }] }
        , delta: { mgdl: 0, display: '+0' }
      };
      $.ajax = function(url, opts) {
        calls++;
        if (failing) {
          opts.error({ status: 0, statusText: 'error' });
        } else {
          opts.success(reading);
        }
      };
    }

    function advance(minutes) {
      var end = now + minutes * 60 * 1000;
      for (;;) {
        timers.sort(function(a, b) { return a.next - b.next; });
        var t = timers[0];
        if (!t || t.next > end) break;
        now = t.next;
        t.next += t.ms;
        t.fn();
      }
      now = end;
    }

    var realConsoleError;
    beforeEach(function() {
      realConsoleError = console.error;
      console.error = function() {};
    });

    afterEach(function() {
      console.error = realConsoleError;
      global.Date = RealDate;
      global.setInterval = realSetInterval;
    });

    ['bgclock', 'clock-color'].forEach(function(face) {
      it('turns the ' + face + ' face stale when fetches fail after the last reading', function() {
        startClock(face, false);
        clockClient.init();
        $('.sg').hasClass('stale').should.be.false();
        $('.ag').text().should.equal('');

        failing = true;
        advance(30);

        calls.should.be.above(80);
        $('.sg').hasClass('stale').should.be.true();
        $('.ag').text().should.equal('30 minutes ago');
        $('body').css('background-color').should.equal('rgb(128, 128, 128)');
      });
    });

    it('keeps the age text moving on a face that always shows it', function() {
      startClock('cy13-sg40-ag6-tm10', true);
      clockClient.init();
      $('.ag').text().should.equal('Just now');

      failing = true;
      advance(5);

      $('.ag').text().should.equal('5 minutes ago');
      $('.sg').hasClass('stale').should.be.false();

      advance(10);

      $('.ag').text().should.equal('15 minutes ago');
      $('.sg').hasClass('stale').should.be.true();
    });

    it('draws nothing and does not throw when no fetch has succeeded yet', function() {
      startClock('clock-color', false);
      failing = true;
      clockClient.init();
      advance(5);

      calls.should.be.above(10);
      $('.sg').text().should.equal('');
    });

    it('control: fetches that succeed with the same reading turn it stale', function() {
      startClock('clock-color', false);
      clockClient.init();
      advance(30);

      $('.sg').hasClass('stale').should.be.true();
      $('.ag').text().should.equal('30 minutes ago');
      $('body').css('background-color').should.equal('rgb(128, 128, 128)');
    });
  });

  it('constructs every supported face component with bounded numeric sizing', function() {
    $('#inner').attr('data-face', 'bn0-sg40-dt14-nl-ar25-ag6-tm10-em40');

    renderProperties('mg/dl', 'mg/dl', propertiesWithUnits('100', '+5'));

    $('#inner').children().map(function() {
      return this.className;
    }).get().should.deepEqual(['sg', 'dt', 'nl', 'ar', 'ag', 'tm', 'em']);
    $('.sg')[0].style.fontSize.should.equal('40vmin');
    $('.dt')[0].style.fontSize.should.equal('14vmin');
    $('.nl')[0].style.fontSize.should.equal('');
    $('.ar')[0].style.height.should.equal('25vmin');
  });

  it('does not interpret face configuration as markup, classes, or styles', function() {
    $('#inner')
      .attr('data-face', 'config')
      .attr('data-face-config', 'cy10-sg40-xx99-sg40" onclick="alert(1)-ar25;background:red-<img src=x onerror=alert(1)>-tm10');

    renderProperties('mg/dl', 'mg/dl', propertiesWithUnits('100', '+5'));

    $('#inner').children().map(function() {
      return this.className;
    }).get().should.deepEqual(['sg', 'tm']);
    $('#inner').find('img, script, [onclick], [onerror]').length.should.equal(0);
    $('.sg')[0].style.fontSize.should.equal('40vmin');
    $('.tm')[0].style.fontSize.should.equal('10vmin');
    $('#inner').text().should.not.match(/alert|onerror|onclick/);
  });

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
