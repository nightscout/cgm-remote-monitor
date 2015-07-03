var should = require('should');

describe('boluswizardpreview', function ( ) {

  var boluswizardpreview = require('../lib/plugins/boluswizardpreview')();

  var env = require('../env')();
  var ctx = {};
  ctx.data = require('../lib/data')(env, ctx);
  ctx.notifications = require('../lib/notifications')(env, ctx);

  var now = Date.now();

  var profile = {
    sens: 90
    , target_high: 120
    , target_low: 100
  };

  it('Not trigger an alarm when in range', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{x: now, y: 100}];
    ctx.data.profiles = [profile];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    sbx.offerProperty('iob', function () {
      return {iob: 0};
    });

    boluswizardpreview.setProperties(sbx);
    boluswizardpreview.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());

    done();
  });

  it('trigger a warning when going out of range', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{x: now, y: 180}];
    ctx.data.profiles = [profile];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    sbx.offerProperty('iob', function () {
      return {iob: 0};
    });

    boluswizardpreview.setProperties(sbx);
    boluswizardpreview.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(ctx.notifications.levels.WARN);

    done();
  });

  it('trigger an urgent alarms when going too high', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{x: now, y: 300}];
    ctx.data.profiles = [profile];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    sbx.offerProperty('iob', function () {
      return {iob: 0};
    });

    boluswizardpreview.setProperties(sbx);
    boluswizardpreview.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(ctx.notifications.levels.URGENT);

    done();
  });

});