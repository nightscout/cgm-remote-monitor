var should = require('should');
var levels = require('../lib/levels');
var times = require('../lib/times');

describe('timeago', function ( ) {

  var timeago = require('../lib/plugins/timeago')();

  var env = require('../env')();
  var ctx = {};
  ctx.data = require('../lib/data')(env, ctx);
  ctx.notifications = require('../lib/notifications')(env, ctx);

  var now = Date.now();


  it('Not trigger an alarm when data is current', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{mills: now, mgdl: 100, type: 'sgv'}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    timeago.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());

    done();
  });

  it('Not trigger an alarm with future data', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{mills: now + times.mins(15).msecs, mgdl: 100, type: 'sgv'}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    timeago.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());

    done();
  });

  it('should trigger a warning when data older than 15m', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{mills: now - times.mins(15.8).msecs, mgdl: 100, type: 'sgv'}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    timeago.checkNotifications(sbx);
    var highest = ctx.notifications.findHighestAlarm();
    highest.level.should.equal(levels.WARN);
    highest.message.should.equal('Last received: 16 mins ago\nBG Now: 100 mg/dl');
    done();
  });

  it('should trigger an urgent alarm when data older than 30m', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{mills: now - times.mins(30.8).msecs, mgdl: 100, type: 'sgv'}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    timeago.checkNotifications(sbx);
    var highest = ctx.notifications.findHighestAlarm();
    highest.level.should.equal(levels.URGENT);
    highest.message.should.equal('Last received: 31 mins ago\nBG Now: 100 mg/dl');
    done();
  });

  it('calc timeago displays', function() {

    should.deepEqual(
      timeago.calcDisplay({ mills: now + times.mins(15).msecs }, now)
      , {label: 'in the future'}
    );

    //TODO: current behavior, we can do better
    //just a little in the future, pretend it's ok
    should.deepEqual(
      timeago.calcDisplay({ mills: now + times.mins(4).msecs }, now)
      , {value: 1, label: 'min ago'}
    );

    should.deepEqual(
      timeago.calcDisplay(null, now)
      , {label: 'time ago'}
    );

    should.deepEqual(
      timeago.calcDisplay({ mills: now }, now)
      , {value: 1, label: 'min ago'}
    );

    should.deepEqual(
      timeago.calcDisplay({ mills: now - 1 }, now)
      , {value: 1, label: 'min ago'}
    );

    should.deepEqual(
      timeago.calcDisplay({ mills: now - times.sec(30).msecs }, now)
      , {value: 1, label: 'min ago'}
    );

    should.deepEqual(
      timeago.calcDisplay({ mills: now - times.mins(30).msecs }, now)
      , {value: 30, label: 'mins ago'}
    );

    should.deepEqual(
      timeago.calcDisplay({ mills: now - times.hours(5).msecs }, now)
      , {value: 5, label: 'hours ago'}
    );

    should.deepEqual(
      timeago.calcDisplay({ mills: now - times.days(5).msecs }, now)
      , {value: 5, label: 'days ago'}
    );

    should.deepEqual(
      timeago.calcDisplay({ mills: now - times.days(10).msecs }, now)
      , {label: 'long ago'}
    );
  });

});