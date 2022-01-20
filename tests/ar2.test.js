'use strict';

var should = require('should');
var levels = require('../lib/levels');

var FIVE_MINS = 300000;
var SIX_MINS = 360000;

describe('ar2', function ( ) {
  var ctx = {
    settings: {}
    , language: require('../lib/language')()
  };
  ctx.ddata = require('../lib/data/ddata')();
  ctx.notifications = require('../lib/notifications')(env, ctx);
  ctx.levels = levels;

  var ar2 = require('../lib/plugins/ar2')(ctx);
  var bgnow = require('../lib/plugins/bgnow')(ctx);

  var env = require('../env')();

  var now = Date.now();
  var before = now - FIVE_MINS;

  function prepareSandbox(base) {
    var sbx = base || require('../lib/sandbox')().serverInit(env, ctx);
    bgnow.setProperties(sbx);
    ar2.setProperties(sbx);
    return sbx;
  }

  it('should plot a cone', function () {
    ctx.ddata.sgvs = [{mgdl: 100, mills: before}, {mgdl: 105, mills: now}];
    var sbx = prepareSandbox();
    var cone = ar2.forecastCone(sbx);
    cone.length.should.equal(26);
  });

  it('should plot a line if coneFactor is 0', function () {
    ctx.ddata.sgvs = [{mgdl: 100, mills: before}, {mgdl: 105, mills: now}];

    var env0 = require('../env')();
    env0.extendedSettings = { ar2: { coneFactor: 0 } };
    var sbx = require('../lib/sandbox')().serverInit(env0, ctx).withExtendedSettings(ar2);
    bgnow.setProperties(sbx);
    var cone = ar2.forecastCone(sbx);
    cone.length.should.equal(13);
  });


  it('Not trigger an alarm when in range', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mgdl: 100, mills: before}, {mgdl: 105, mills: now}];

    var sbx = prepareSandbox();
    ar2.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());

    done();
  });

  it('should trigger a warning when going above target', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mgdl: 150, mills: before}, {mgdl: 170, mills: now}];

    var sbx = prepareSandbox();
    sbx.offerProperty('iob', function setFakeIOB() {
      return {displayLine: 'IOB: 1.25U'};
    });
    sbx.offerProperty('direction', function setFakeDirection() {
      return {value: 'FortyFiveUp', label: '↗', entity: '&#8599;'};
    });
    ar2.checkNotifications(sbx);
    var highest = ctx.notifications.findHighestAlarm();
    highest.level.should.equal(levels.WARN);
    highest.title.should.equal('Warning, HIGH predicted');
    highest.message.should.equal('BG Now: 170 +20 ↗ mg/dl\nBG 15m: 206 mg/dl\nIOB: 1.25U');

    done();
  });

  it('should trigger a urgent alarm when going high fast', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mgdl: 140, mills: before}, {mgdl: 200, mills: now}];

    var sbx = prepareSandbox();
    ar2.checkNotifications(sbx);
    var highest = ctx.notifications.findHighestAlarm();
    highest.level.should.equal(levels.URGENT);
    highest.title.should.equal('Urgent, HIGH');

    done();
  });

  it('should trigger a warning when below target', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mgdl: 90, mills: before}, {mgdl: 80, mills: now}];

    var sbx = prepareSandbox();
    ar2.checkNotifications(sbx);
    var highest = ctx.notifications.findHighestAlarm();
    highest.level.should.equal(levels.WARN);
    highest.title.should.equal('Warning, LOW');

    done();
  });

  it('should trigger a warning when almost below target', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mgdl: 90, mills: before}, {mgdl: 83, mills: now}];

    var sbx = prepareSandbox();
    ar2.checkNotifications(sbx);
    var highest = ctx.notifications.findHighestAlarm();
    highest.level.should.equal(levels.WARN);
    highest.title.should.equal('Warning, LOW predicted');

    done();
  });

  it('should trigger a urgent alarm when falling fast', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mgdl: 120, mills: before}, {mgdl: 85, mills: now}];

    var sbx = prepareSandbox();
    ar2.checkNotifications(sbx);
    var highest = ctx.notifications.findHighestAlarm();
    highest.level.should.equal(levels.URGENT);
    highest.title.should.equal('Urgent, LOW predicted');

    done();
  });

  it('should trigger a warning alarm by interpolating when more than 5mins apart', function (done) {
    ctx.notifications.initRequests();

    //same as previous test but prev is 10 mins ago, so delta isn't enough to trigger an urgent alarm
    ctx.ddata.sgvs = [{mgdl: 120, mills: before - SIX_MINS}, {mgdl: 85, mills: now}];

    var sbx = prepareSandbox();
    ar2.checkNotifications(sbx);
    var highest = ctx.notifications.findHighestAlarm();
    highest.level.should.equal(levels.WARN);
    highest.title.should.equal('Warning, LOW predicted');

    done();
  });

  it('should handle virtAsst requests', function (done) {
     var now = Date.now();
     var before = now - FIVE_MINS;

    ctx.ddata.sgvs = [{mgdl: 100, mills: before}, {mgdl: 105, mills: now}];
    var sbx = prepareSandbox();

    ar2.virtAsst.intentHandlers.length.should.equal(1);

    ar2.virtAsst.intentHandlers[0].intentHandler(function next(title, response) {
      title.should.equal('AR2 Forecast');
      response.should.equal('According to the AR2 forecast you are expected to be between 109 and 120 over the next in 30 minutes');
      done();
    }, [], sbx);
  });

});