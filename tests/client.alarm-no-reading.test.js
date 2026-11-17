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
 * What these tests hold fixed as well as the throw: a GLUCOSE alarm (default
 * group) still does not sound on a page with no reading, and a page WITH a
 * reading still sounds, which is also what proves the handlers below are the
 * live ones. A NON-glucose alarm (pump, loop, age...: its plugin's own group)
 * sounds on a page with no reading exactly as it does on a page whose reading
 * is in range, under the page's own alarm settings (BF-92).
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

  function pumpUrgent ( ) {
    return { level: 2, group: 'Pump', title: 'URGENT: Pump Reservoir Low', message: 'Pump Reservoir Low', timestamp: Date.now() };
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

  var savedAlarmSettings;

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
    savedAlarmSettings = ['alarmHigh', 'alarmLow', 'alarmUrgentHigh', 'alarmUrgentLow'].map(function (name) {
      return [name, client.settings[name]];
    });
  });

  afterEach(function ( ) {
    savedAlarmSettings.forEach(function (entry) { client.settings[entry[0]] = entry[1]; });
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

  it('still does not sound a glucose alarm when it has no reading to judge it by (unchanged)', function ( ) {
    client.dataUpdate({ sgvs: [], treatments: [], devicestatus: [] }, true);
    deliver('urgent_alarm', urgentLow());
    deliver('alarm', Object.assign(urgentLow(), { level: 1, title: 'Warning, LOW' }));
    container.hasClass('alarming').should.equal(false);
  });

  it('BF-92: sounds a pump warning on a page with no reading', function ( ) {
    client.dataUpdate({ sgvs: [], treatments: [], devicestatus: [] }, true);
    (client.latestSGV === undefined).should.equal(true);
    deliver('alarm', pumpWarning());
    container.hasClass('alarming').should.equal(true);
    container.hasClass('warning').should.equal(true);
    container.hasClass('urgent').should.equal(false);
  });

  it('BF-92: sounds an urgent pump alarm on a page that has received no data at all', function ( ) {
    (client.latestSGV === undefined).should.equal(true);
    deliver('urgent_alarm', pumpUrgent());
    container.hasClass('alarming').should.equal(true);
    container.hasClass('urgent').should.equal(true);
  });

  it('BF-92: with no reading, one side enabled is enough, as with an in-range reading', function ( ) {
    client.dataUpdate({ sgvs: [], treatments: [], devicestatus: [] }, true);
    client.settings.alarmUrgentHigh = false;
    client.settings.alarmUrgentLow = true;
    deliver('urgent_alarm', pumpUrgent());
    container.hasClass('alarming').should.equal(true);
  });

  it('BF-92: the page\'s own alarm settings still apply to a non-glucose alarm with no reading', function ( ) {
    client.dataUpdate({ sgvs: [], treatments: [], devicestatus: [] }, true);
    client.settings.alarmHigh = false;
    client.settings.alarmLow = false;
    client.settings.alarmUrgentHigh = false;
    client.settings.alarmUrgentLow = false;
    deliver('alarm', pumpWarning());
    deliver('urgent_alarm', pumpUrgent());
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
