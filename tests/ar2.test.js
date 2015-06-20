var should = require('should');

describe('ar2', function ( ) {

  var ar2 = require('../lib/plugins/ar2')();

  var env = require('../env')();
  var ctx = {};
  ctx.data = require('../lib/data')(env, ctx);
  ctx.notifications = require('../lib/notifications')(env, ctx);

  var now = Date.now();
  var before = now - (5 * 60 * 1000);


  it('Not trigger an alarm when in range', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{y: 100, x: before}, {y: 105, x: now}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    ar2.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());

    done();
  });

  it('should trigger a warning when going above target', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{y: 150, x: before}, {y: 170, x: now}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    ar2.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(ctx.notifications.levels.WARN);

    done();
  });

  it('should trigger a urgent alarm when going high fast', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{y: 140, x: before}, {y: 200, x: now}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    ar2.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(ctx.notifications.levels.URGENT);

    done();
  });

  it('should trigger a warning when below target', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{y: 90, x: before}, {y: 80, x: now}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    ar2.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(ctx.notifications.levels.WARN);

    done();
  });

  it('should trigger a urgent alarm when low fast', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{y: 120, x: before}, {y: 80, x: now}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    ar2.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(ctx.notifications.levels.URGENT);

    done();
  });


});