var should = require('should');
const helper = require('./inithelper')();

describe('simplealarms', function ( ) {
  var env = require('../lib/server/env')();
  var ctx = helper.getctx();

  var simplealarms = require('../lib/plugins/simplealarms')(ctx);

  ctx.ddata = require('../lib/data/ddata')();
  ctx.notifications = require('../lib/notifications')(env, ctx);
  var bgnow = require('../lib/plugins/bgnow')(ctx);

  var now = Date.now();
  var before = now - (5 * 60 * 1000);


  it('Not trigger an alarm when in range', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mills: now, mgdl: 100}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    simplealarms.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());

    done();
  });

  it('should trigger a warning when above target', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mills: before, mgdl: 171}, {mills: now, mgdl: 182}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    bgnow.setProperties(sbx);
    simplealarms.checkNotifications(sbx);
    var highest = ctx.notifications.findHighestAlarm();
    highest.level.should.equal(ctx.levels.WARN);

    var expectedMessage =
      ctx.settings.units === 'mmol' ?
        'BG Now: 10.1 +0.6 mmol/L' :
        'BG Now: 182 +11 mg/dl';
    highest.message.should.equal(expectedMessage);

    done();
  });

  it('should trigger a urgent alarm when really high', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mills: now, mgdl: 400}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    simplealarms.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(ctx.levels.URGENT);

    done();
  });

  it('should trigger a warning when below target', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mills: now, mgdl: 70}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    simplealarms.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(ctx.levels.WARN);

    done();
  });

  it('should trigger a urgent alarm when really low', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mills: now, mgdl: 40}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    simplealarms.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(ctx.levels.URGENT);

    done();
  });


});
