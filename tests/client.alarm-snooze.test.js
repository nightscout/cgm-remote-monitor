'use strict';

/*
 * A snooze chosen on a page whose ack the server ignores.
 *
 * On a site with the default `readable` role, a page that has not entered
 * the API secret subscribes to alarms without the notifications:*:ack
 * permission. The server ignores the ack that "Silence for N minutes" sends
 * from that page and sends the alarm again on its next heartbeat, so the page
 * sounded again within a minute whatever snooze was chosen.
 *
 * The recording socket below never answers an ack, which is how the server
 * treats that page. These run against the production bundle, so rebuild it
 * with `npm run bundle` after changing lib/client.
 */

require('should');
var benv = require('./fixtures/benv-loader');

describe('client alarm snooze when the server ignores the ack', function ( ) {
  this.timeout(60000);

  var headless = require('./fixtures/headless')(benv, this);
  var handlers, acks;

  // Every io.connect() returns a socket that records its handlers by
  // namespace and every ack the page sends.
  function recordingIo ( ) {
    handlers = { main: { }, alarm: { } };
    acks = [];
    return {
      connect: function mockConnect (nsp) {
        var bucket = nsp === '/alarm' ? handlers.alarm : handlers.main;
        return {
          connected: true
          , on: function mockOn (event, callback) {
            bucket[event] = callback;
            if (event === 'connect' && nsp !== '/alarm') { callback(); }
          }
          , emit: function mockEmit (event, data, callback) {
            if (event === 'authorize' && callback) { callback({ read: true }); }
            if (event === 'ack') { acks.push(Array.prototype.slice.call(arguments, 1)); }
          }
        };
      }
    };
  }

  function urgentLow ( ) {
    return { level: 2, group: 'default', eventName: 'low', title: 'Urgent LOW', message: 'BG Now: 44 mg/dl', timestamp: Date.now() };
  }

  function low ( ) {
    return { level: 1, group: 'default', eventName: 'low', title: 'LOW', message: 'BG Now: 44 mg/dl', timestamp: Date.now() };
  }

  function pumpWarning ( ) {
    return { level: 1, group: 'Pump', title: 'Warning, Pump Reservoir Low', message: 'Pump Reservoir Low', timestamp: Date.now() };
  }

  var client, container;

  before(function (done) {
    // Another headless suite may already have loaded the bundle in this
    // process, see client.alarm-no-reading.test.js.
    delete require.cache[require.resolve('../node_modules/.cache/_ns_cache/public/js/bundle.app.js')];
    headless.setup({ mockAjax: true }, done);
  });

  after(function ( ) {
    headless.teardown();
  });

  beforeEach(function ( ) {
    window.io = global.io = recordingIo();
    client = window.Nightscout.client;
    client.latestSGV = undefined;
    var hashauth = require('../lib/client/hashauth');
    hashauth.init(client, $);
    hashauth.verifyAuthentication = function mockVerifyAuthentication (next) {
      hashauth.authenticated = true;
      next(true);
    };
    container = $('#container');
    container.removeClass('alarming urgent warning');
    client.init();
    client.dataUpdate({
      sgvs: [{ mgdl: 44, mills: Date.now(), direction: 'Flat', type: 'sgv' }]
      , treatments: []
      , devicestatus: []
    }, true);
  });

  function deliver (event, notify) {
    handlers.alarm.should.have.property(event);
    handlers.alarm[event](notify);
  }

  // jsdom cannot draw the chart, so the chart redraw that ends stopAlarm
  // throws after the alarm is stopped and any ack is sent.
  function stopping (action) {
    try {
      action();
    } catch (e) {
      if (!/theBrush/.test(e.message)) { throw e; }
    }
  }

  function silenceFor (mins) {
    var option = $('#silenceBtn a[data-snooze-time="' + mins * 60 * 1000 + '"]');
    option.length.should.equal(1);
    stopping(function clickOption ( ) { option.trigger('click'); });
  }

  function alarming ( ) {
    return container.hasClass('alarming');
  }

  it('keeps an urgent alarm quiet for the snooze chosen on the page', function ( ) {
    deliver('urgent_alarm', urgentLow());
    alarming().should.equal(true);

    silenceFor(30);
    alarming().should.equal(false);
    acks.should.eql([[2, 'default', 30 * 60 * 1000]]);

    deliver('urgent_alarm', urgentLow());
    alarming().should.equal(false);
  });

  it('keeps a warning in the same group quiet after an urgent snooze', function ( ) {
    deliver('urgent_alarm', urgentLow());
    silenceFor(30);

    deliver('alarm', low());
    alarming().should.equal(false);
  });

  it('still sounds an alarm in another group', function ( ) {
    deliver('urgent_alarm', urgentLow());
    silenceFor(30);

    deliver('alarm', pumpWarning());
    alarming().should.equal(true);
  });

  it('does not let a warning snooze cover an urgent alarm', function ( ) {
    deliver('alarm', low());
    silenceFor(15);

    deliver('urgent_alarm', urgentLow());
    alarming().should.equal(true);
  });

  it('sounds again once the snooze has run out', function ( ) {
    deliver('urgent_alarm', urgentLow());
    silenceFor(15);

    var realNow = Date.now;
    Date.now = function sixteenMinutesLater ( ) { return realNow() + 16 * 60 * 1000; };
    try {
      deliver('urgent_alarm', urgentLow());
    } finally {
      Date.now = realNow;
    }
    alarming().should.equal(true);
  });

  it('does not treat an all clear from the server as a snooze', function ( ) {
    deliver('urgent_alarm', urgentLow());
    stopping(function allClear ( ) {
      deliver('clear_alarm', { clear: true, title: 'All Clear', message: 'Auto ack\'d alarm(s)', group: 'default' });
    });
    alarming().should.equal(false);

    deliver('urgent_alarm', urgentLow());
    alarming().should.equal(true);
  });
});
