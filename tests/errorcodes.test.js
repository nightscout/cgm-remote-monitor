var _ = require('lodash');
var should = require('should');

describe('errorcodes', function ( ) {

  var errorcodes = require('../lib/plugins/errorcodes')();

  var now = Date.now();
  var env = require('../env')();
  var ctx = {};
  ctx.data = require('../lib/data')(env, ctx);
  ctx.notifications = require('../lib/notifications')(env, ctx);


  it('Not trigger an alarm when in range', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{y: 100, mills: now}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    errorcodes.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());

    done();
  });

  it('should trigger a urgent alarm when ???', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{y: 10, mills: now}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    errorcodes.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(ctx.notifications.levels.URGENT);

    done();
  });

  it('should trigger a urgent alarm when hourglass', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{y: 9, mills: now}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    errorcodes.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(ctx.notifications.levels.URGENT);

    done();
  });

  it('should trigger a low notification when needing calibration', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{y: 5, mills: now}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    errorcodes.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());
    _.first(ctx.notifications.findInfos()).level.should.equal(ctx.notifications.levels.LOW);

    done();
  });

  it('should trigger a low notification when code < 9', function (done) {

    for (var i = 0; i < 9; i++) {
      ctx.notifications.initRequests();
      ctx.data.sgvs = [{y: i, mills: now}];

      var sbx = require('../lib/sandbox')().serverInit(env, ctx);
      errorcodes.checkNotifications(sbx);
      should.not.exist(ctx.notifications.findHighestAlarm());
      _.first(ctx.notifications.findInfos()).level.should.be.lessThan(ctx.notifications.levels.WARN);
    }
    done();
  });

});