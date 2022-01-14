var should = require('should');
var levels = require('../lib/levels');

describe('simplealarms', function ( ) {
  var env = require('../lib/server/env')();
  var ctx = {
    settings: {}
    , language: require('../lib/language')()
    , levels: levels
  };

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
    ctx.ddata.sgvs = [{mills: before, mgdl: 171}, {mills: now, mgdl: 181}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    bgnow.setProperties(sbx);
    simplealarms.checkNotifications(sbx);
    var highest = ctx.notifications.findHighestAlarm();
    highest.level.should.equal(levels.WARN);
    highest.message.should.equal('BG Now: 181 +10 mg/dl');
    done();
  });

  it('should trigger a urgent alarm when really high', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mills: now, mgdl: 400}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    simplealarms.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(levels.URGENT);

    done();
  });

  it('should trigger a warning when below target', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mills: now, mgdl: 70}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    simplealarms.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(levels.WARN);

    done();
  });

  it('should trigger a urgent alarm when really low', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mills: now, mgdl: 40}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    simplealarms.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(levels.URGENT);

    done();
  });


});