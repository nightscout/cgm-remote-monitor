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
      sbx.settings.units === 'mmol' ?
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

describe('simplealarms on an mmol site with only the targets set in mmol/L', function ( ) {
  var vars = { DISPLAY_UNITS: 'mmol', BG_TARGET_TOP: '8.5', BG_TARGET_BOTTOM: '3.9' };
  var saved = {};
  var env, ctx, simplealarms;

  before(function () {
    ['DISPLAY_UNITS', 'BG_HIGH', 'BG_TARGET_TOP', 'BG_TARGET_BOTTOM', 'BG_LOW'].forEach(function (name) {
      saved[name] = process.env[name];
      delete process.env[name];
    });
    Object.assign(process.env, vars);
    var realInfo = console.info;
    console.info = function () {};
    try {
      env = require('../lib/server/env')();
    } finally {
      console.info = realInfo;
    }
    ctx = {
      language: require('../lib/language')(require('fs'))
      , settings: env.settings
      , levels: require('../lib/levels')
      , moment: require('moment-timezone')
    };
    ctx.ddata = require('../lib/data/ddata')();
    ctx.notifications = require('../lib/notifications')(env, ctx);
    simplealarms = require('../lib/plugins/simplealarms')(ctx);
  });

  after(function () {
    Object.keys(saved).forEach(function (name) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    });
  });

  function highestAlarmAt (mgdl) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mills: Date.now(), mgdl: mgdl}];
    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    simplealarms.checkNotifications(sbx);
    return ctx.notifications.findHighestAlarm();
  }

  it('should trigger an urgent low alarm at 45 mg/dl', function () {
    var highest = highestAlarmAt(45);
    should.exist(highest);
    highest.title.should.equal('Urgent LOW');
  });

  it('should not trigger an alarm when in range', function () {
    should.not.exist(highestAlarmAt(100));
  });
});
