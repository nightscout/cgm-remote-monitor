var _ = require('lodash');
var should = require('should');
var levels = require('../lib/levels');

describe('errorcodes', function ( ) {

  var errorcodes = require('../lib/plugins/errorcodes')();

  var now = Date.now();
  var env = require('../env')();
  var ctx = {};
  ctx.data = require('../lib/data')(env, ctx);
  ctx.notifications = require('../lib/notifications')(env, ctx);


  it('Not trigger an alarm when in range', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{mgdl: 100, mills: now}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    errorcodes.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());

    done();
  });

  it('should trigger a urgent alarm when ???', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{mgdl: 10, mills: now}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    errorcodes.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(levels.URGENT);

    done();
  });

  it('should trigger a urgent alarm when hourglass', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{mgdl: 9, mills: now}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    errorcodes.checkNotifications(sbx);
    var findHighestAlarm = ctx.notifications.findHighestAlarm();
    findHighestAlarm.level.should.equal(levels.URGENT);
    findHighestAlarm.pushoverSound.should.equal('alien');

    done();
  });

  it('should trigger a low notification when needing calibration', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{mgdl: 5, mills: now}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    errorcodes.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());
    var info = _.first(ctx.notifications.findUnSnoozeable());
    info.level.should.equal(levels.LOW);
    info.pushoverSound.should.equal('intermission');

    done();
  });

  it('should trigger a low notification when code < 9', function (done) {

    for (var i = 0; i < 9; i++) {
      ctx.notifications.initRequests();
      ctx.data.sgvs = [{mgdl: i, mills: now}];

      var sbx = require('../lib/sandbox')().serverInit(env, ctx);
      errorcodes.checkNotifications(sbx);
      should.not.exist(ctx.notifications.findHighestAlarm());
      _.first(ctx.notifications.findUnSnoozeable()).level.should.be.lessThan(levels.WARN);
    }
    done();
  });

  it('convert a code to display', function () {
    errorcodes.toDisplay(5).should.equal('?NC');
    errorcodes.toDisplay(9).should.equal('?AD');
    errorcodes.toDisplay(10).should.equal('???');
  });

});