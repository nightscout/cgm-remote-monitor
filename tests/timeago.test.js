var should = require('should');
var levels = require('../lib/levels');
var times = require('../lib/times');

describe('timeago', function() {
  var ctx = {};
  ctx.ddata = require('../lib/data/ddata')();
  ctx.notifications = require('../lib/notifications')(env, ctx);
  ctx.language = require('../lib/language')();
  ctx.settings = require('../lib/settings')();
  ctx.settings.heartbeat = 0.5; // short heartbeat to speedup tests

  var timeago = require('../lib/plugins/timeago')(ctx);

  var env = require('../env')();

  function freshSBX () {
    //set extendedSettings right before calling withExtendedSettings, there's some strange test interference here
    env.extendedSettings = { timeago: { enableAlerts: true } };
    var sbx = require('../lib/sandbox')().serverInit(env, ctx).withExtendedSettings(timeago);
    return sbx;
  }

  it('Not trigger an alarm when data is current', function(done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{ mills: Date.now(), mgdl: 100, type: 'sgv' }];

    var sbx = freshSBX();
    timeago.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm('Time Ago'));

    done();
  });

  it('Not trigger an alarm with future data', function(done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{ mills: Date.now() + times.mins(15).msecs, mgdl: 100, type: 'sgv' }];

    var sbx = freshSBX();
    timeago.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm('Time Ago'));

    done();
  });


  it('should trigger a warning when data older than 15m', function(done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{ mills: Date.now() - times.mins(16).msecs, mgdl: 100, type: 'sgv' }];

    var sbx = freshSBX();
    timeago.checkNotifications(sbx);

    var currentTime = new Date().getTime();

    var highest = ctx.notifications.findHighestAlarm('Time Ago');
    highest.level.should.equal(levels.WARN);
    highest.message.should.equal('Last received: 16 mins ago\nBG Now: 100 mg/dl');
    done();
  });

  it('should trigger an urgent alarm when data older than 30m', function(done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{ mills: Date.now() - times.mins(31).msecs, mgdl: 100, type: 'sgv' }];

    var sbx = freshSBX();
    timeago.checkNotifications(sbx);
    var highest = ctx.notifications.findHighestAlarm('Time Ago');
    highest.level.should.equal(levels.URGENT);
    highest.message.should.equal('Last received: 31 mins ago\nBG Now: 100 mg/dl');
    done();
  });

  it('calc timeago displays', function() {
    var now = Date.now();

    should.deepEqual(
      timeago.calcDisplay({ mills: now + times.mins(15).msecs }, now)
      , { label: 'in the future', shortLabel: 'future' }
    );

    //TODO: current behavior, we can do better
    //just a little in the future, pretend it's ok
    should.deepEqual(
      timeago.calcDisplay({ mills: now + times.mins(4).msecs }, now)
      , { value: 1, label: 'min ago', shortLabel: 'm' }
    );

    should.deepEqual(
      timeago.calcDisplay(null, now)
      , { label: 'time ago', shortLabel: 'ago' }
    );

    should.deepEqual(
      timeago.calcDisplay({ mills: now }, now)
      , { value: 1, label: 'min ago', shortLabel: 'm' }
    );

    should.deepEqual(
      timeago.calcDisplay({ mills: now - 1 }, now)
      , { value: 1, label: 'min ago', shortLabel: 'm' }
    );

    should.deepEqual(
      timeago.calcDisplay({ mills: now - times.sec(30).msecs }, now)
      , { value: 1, label: 'min ago', shortLabel: 'm' }
    );

    should.deepEqual(
      timeago.calcDisplay({ mills: now - times.mins(30).msecs }, now)
      , { value: 30, label: 'mins ago', shortLabel: 'm' }
    );

    should.deepEqual(
      timeago.calcDisplay({ mills: now - times.hours(5).msecs }, now)
      , { value: 5, label: 'hours ago', shortLabel: 'h' }
    );

    should.deepEqual(
      timeago.calcDisplay({ mills: now - times.days(5).msecs }, now)
      , { value: 5, label: 'days ago', shortLabel: 'd' }
    );

    should.deepEqual(
      timeago.calcDisplay({ mills: now - times.days(10).msecs }, now)
      , { label: 'long ago', shortLabel: 'ago' }
    );
  });

});
