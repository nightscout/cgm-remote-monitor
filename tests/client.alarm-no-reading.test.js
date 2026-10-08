'use strict';

/*
 * An alarm that reaches a page holding no glucose reading.
 *
 * The page's `alarm` and `urgent_alarm` handlers decide whether to sound by
 * asking whether the latest reading is on the high or the low side of the
 * target range. With no reading both answers are no, so the handler takes its
 * "disabled locally" branch - and that branch logged `client.latestSGV.mgdl`
 * with no guard, which threw a TypeError and skipped the chart refresh after
 * it. The chart is also only created by the first non-headless data update,
 * so a page that has received no data at all has no chart to refresh either.
 *
 * Two ordinary ways a page gets there: an opt-in device alert (pump, loop,
 * OpenAPS, site/sensor age) fires while no CGM reading is in the loaded
 * window; and, on releases that deliver alarms to every page, a page that may
 * not read data at all.
 *
 * What these tests hold fixed as well as the throw: whether the alarm SOUNDS
 * is not changed. A page with no reading still does not raise an alarm - that
 * decision is the handler's, not the throw's - and a page WITH a reading still
 * does, which is also what proves the handlers below are the live ones.
 *
 * These run against the production bundle, like the other headless client
 * tests: rebuild it (`npm run bundle`) after changing lib/client.
 */

require('should');
var benv = require('./fixtures/benv-loader');

describe('client alarm handlers with no reading loaded', function ( ) {
  this.timeout(60000);

  var headless = require('./fixtures/headless')(benv, this);
  var handlers;

  // Every io.connect() returns a socket that records its handlers by
  // namespace, so the test can deliver an alarm exactly as the alarm
  // connection would, without a server.
  function recordingIo ( ) {
    handlers = { main: { }, alarm: { } };
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
          }
        };
      }
    };
  }

  function urgentLow ( ) {
    return { level: 2, group: 'default', title: 'Urgent LOW', message: 'BG Now: 44 mg/dl', timestamp: Date.now() };
  }

  function pumpWarning ( ) {
    return { level: 1, group: 'Pump', title: 'Warning, Pump Reservoir Low', message: 'Pump Reservoir Low', timestamp: Date.now() };
  }

  var client, container;

  // One DOM and one bundle for the file, as the other headless client tests
  // do; each test gets a fresh client.load() closure (fresh chart, fresh
  // alarm state) against a fresh recording socket.
  before(function (done) {
    // headless.js hands the shim an un-normalised path (tests/fixtures/../../
    // node_modules/...), so the shim's own cache-bust misses the key Node
    // stored the bundle under. When another headless suite (careportal) has
    // already loaded the bundle in this process, the require returns the
    // cached module, the bundle never re-runs against the new window, and
    // `$` is undefined. Bust the resolved key here.
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
  });

  function deliver (event, notify) {
    handlers.alarm.should.have.property(event);
    handlers.alarm[event](notify);
  }

  it('a page that has received no data at all takes an urgent alarm without throwing', function ( ) {
    (client.latestSGV === undefined).should.equal(true);
    (function ( ) { deliver('urgent_alarm', urgentLow()); }).should.not.throw();
    (function ( ) { deliver('alarm', pumpWarning()); }).should.not.throw();
  });

  it('a page whose data holds no reading takes both alarm kinds without throwing', function ( ) {
    client.dataUpdate({ sgvs: [], treatments: [], devicestatus: [] }, true);
    (client.latestSGV === undefined).should.equal(true);
    (function ( ) { deliver('urgent_alarm', urgentLow()); }).should.not.throw();
    (function ( ) { deliver('alarm', pumpWarning()); }).should.not.throw();
  });

  it('still does not sound an alarm when it has no reading to judge it by (unchanged)', function ( ) {
    client.dataUpdate({ sgvs: [], treatments: [], devicestatus: [] }, true);
    try { deliver('urgent_alarm', urgentLow()); } catch (e) { /* the throw is the test above */ }
    try { deliver('alarm', pumpWarning()); } catch (e) { /* ditto */ }
    container.hasClass('alarming').should.equal(false);
  });

  it('control: the same urgent alarm with a reading loaded does sound', function ( ) {
    // jsdom cannot draw the D3 chart, so a headless data update loads the
    // reading without creating a chart. That leaves this page in a state a
    // browser does not reach (a reading but no chart), and a build without the
    // chart guard throws here AFTER raising the alarm. What this control holds
    // is the presentation, so the throw is set aside rather than asserted.
    client.dataUpdate({
      sgvs: [{ mgdl: 44, mills: Date.now(), direction: 'Flat', type: 'sgv' }]
      , treatments: []
      , devicestatus: []
    }, true);
    client.latestSGV.mgdl.should.equal(44);
    try { deliver('urgent_alarm', urgentLow()); } catch (e) { /* see above */ }
    container.hasClass('alarming').should.equal(true);
    container.hasClass('urgent').should.equal(true);
  });
});
