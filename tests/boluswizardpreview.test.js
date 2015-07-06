var should = require('should');

describe('boluswizardpreview', function ( ) {

  var boluswizardpreview = require('../lib/plugins/boluswizardpreview')();
  var ar2 = require('../lib/plugins/ar2')();
  var delta = require('../lib/plugins/delta')();

  var env = require('../env')();
  var ctx = {};
  ctx.data = require('../lib/data')(env, ctx);
  ctx.notifications = require('../lib/notifications')(env, ctx);

  function prepareSandbox ( ) {
    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    sbx.offerProperty('iob', function () {
      return {iob: 0};
    });
    ar2.setProperties(sbx);
    delta.setProperties(sbx);
    boluswizardpreview.setProperties(sbx);
    sbx.offerProperty('direction', function setFakeDirection() {
      return {value: 'FortyFiveUp', label: '↗', entity: '&#8599;'};
    });

    return sbx;
  }

  var now = Date.now();
  var before = now - (5 * 60 * 1000);

  var profile = {
    sens: 90
    , target_high: 120
    , target_low: 100
  };

  it('Not trigger an alarm when in range', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{x: before, y: 95}, {x: now, y: 100}];
    ctx.data.profiles = [profile];

    var sbx = prepareSandbox();
    boluswizardpreview.checkNotifications(sbx);

    should.not.exist(ctx.notifications.findHighestAlarm());

    done();
  });

  it('trigger a warning when going out of range', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{x: before, y: 175}, {x: now, y: 180}];
    ctx.data.profiles = [profile];

    var sbx = prepareSandbox();
    boluswizardpreview.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm();
    highest.level.should.equal(ctx.notifications.levels.WARN);
    highest.title.should.equal('Warning, Check BG, time to bolus?');
    highest.message.should.equal('BG Now: 180 +5 ↗ mg/dl\nBG 15m: 187 mg/dl\nBWP: 0.66U');
    done();
  });

  it('trigger an urgent alarms when going too high', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{x: before, y: 295}, {x: now, y: 300}];
    ctx.data.profiles = [profile];

    var sbx = prepareSandbox();
    boluswizardpreview.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(ctx.notifications.levels.URGENT);

    done();
  });

});