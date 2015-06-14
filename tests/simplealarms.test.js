var should = require('should');

describe('simplealarms', function ( ) {

  var simplealarms = require('../lib/plugins/simplealarms')();

  var env = require('../env')();
  var ctx = {};
  ctx.data = require('../lib/data')(env, ctx);
  ctx.notifications = require('../lib/notifications')(env, ctx);


  it('Not trigger an alarm when in range', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{sgv: 100}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    simplealarms.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());

    done();
  });

  it('should trigger a warning when above target', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{sgv: 181}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    simplealarms.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(ctx.notifications.levels.WARN);

    done();
  });

  it('should trigger a urgent alarm when really high', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{sgv: 400}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    simplealarms.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(ctx.notifications.levels.URGENT);

    done();
  });

  it('should trigger a warning when below target', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{sgv: 70}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    simplealarms.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(ctx.notifications.levels.WARN);

    done();
  });

  it('should trigger a urgent alarm when really low', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{sgv: 40}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    simplealarms.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(ctx.notifications.levels.URGENT);

    done();
  });


});