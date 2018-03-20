var should = require('should');
var Stream = require('stream');

var levels = require('../lib/levels');

describe('notifications', function ( ) {

  var env = {testMode: true};

  var ctx = {
    bus: new Stream
    , data: {
      lastUpdated: Date.now()
    }
  };

  var notifications = require('../lib/notifications')(env, ctx);

  function examplePlugin () {}

  var exampleInfo = {
    title: 'test'
    , message: 'testing'
    , level: levels.INFO
    , plugin: examplePlugin
  };

  var exampleWarn = {
    title: 'test'
    , message: 'testing'
    , level: levels.WARN
    , plugin: examplePlugin
  };

  var exampleUrgent = {
    title: 'test'
    , message: 'testing'
    , level: levels.URGENT
    , plugin: examplePlugin
  };

  var exampleSnooze = {
    level: levels.WARN
    , title: 'exampleSnooze'
    , message: 'exampleSnooze message'
    , lengthMills: 10000
  };

  var exampleSnoozeNone = {
    level: levels.WARN
    , title: 'exampleSnoozeNone'
    , message: 'exampleSnoozeNone message'
    , lengthMills: 1
  };

  var exampleSnoozeUrgent = {
    level: levels.URGENT
    , title: 'exampleSnoozeUrgent'
    , message: 'exampleSnoozeUrgent message'
    , lengthMills: 10000
  };


  function expectNotification (check, done) {
    //start fresh to we don't pick up other notifications
    ctx.bus = new Stream;
    //if notification doesn't get called test will time out
    ctx.bus.on('notification', function callback (notify) {
      if (check(notify)) {
        done();
      }
    });
  }

  function clearToDone (done) {
    expectNotification(function expectClear (notify) {
      return notify.clear;
    }, done);
  }

  function notifyToDone (done) {
    expectNotification(function expectNotClear (notify) {
      return ! notify.clear;
    }, done);
  }

  it('initAndReInit', function (done) {
    notifications.initRequests();
    notifications.requestNotify(exampleWarn);
    notifications.findHighestAlarm().should.equal(exampleWarn);
    notifications.initRequests();
    should.not.exist(notifications.findHighestAlarm());
    done();
  });


  it('emitAWarning', function (done) {
    //start fresh to we don't pick up other notifications
    ctx.bus = new Stream;
    //if notification doesn't get called test will time out
    ctx.bus.on('notification', function callback ( ) {
      done();
    });

    notifications.resetStateForTests();
    notifications.initRequests();
    notifications.requestNotify(exampleWarn);
    notifications.findHighestAlarm().should.equal(exampleWarn);
    notifications.process();
  });

  it('emitAnInfo', function (done) {
    notifyToDone(done);

    notifications.resetStateForTests();
    notifications.initRequests();
    notifications.requestNotify(exampleInfo);
    should.not.exist(notifications.findHighestAlarm());

    notifications.process();
  });

  it('emitAllClear 1 time after alarm is auto acked', function (done) {
    clearToDone(done);

    notifications.resetStateForTests();
    notifications.initRequests();
    notifications.requestNotify(exampleWarn);
    notifications.findHighestAlarm().should.equal(exampleWarn);
    notifications.process();

    notifications.initRequests();
    //don't request a notify this time, and an auto ack should be sent
    should.not.exist(notifications.findHighestAlarm());
    notifications.process();

    var alarm = notifications.getAlarmForTests(levels.WARN);
    alarm.level.should.equal(levels.WARN);
    alarm.silenceTime.should.equal(1);
    alarm.lastAckTime.should.be.approximately(Date.now(), 2000);
    should.not.exist(alarm.lastEmitTime);

    //clear last emit time, even with that all clear shouldn't be sent again since there was no alarm cleared
    delete alarm.lastEmitTime;

    //process 1 more time to make sure all clear is only sent once
    notifications.initRequests();
    //don't request a notify this time, and an auto ack should be sent
    should.not.exist(notifications.findHighestAlarm());
    notifications.process();
  });

  it('Can be snoozed', function (done) {
    notifyToDone(done); //shouldn't get called

    notifications.resetStateForTests();
    notifications.initRequests();
    notifications.requestNotify(exampleWarn);
    notifications.requestSnooze(exampleSnooze);
    notifications.snoozedBy(exampleWarn).should.equal(exampleSnooze);
    notifications.process();

    done();
  });

  it('Can be snoozed by last snooze', function (done) {
    notifyToDone(done); //shouldn't get called

    notifications.resetStateForTests();
    notifications.initRequests();
    notifications.requestNotify(exampleWarn);
    notifications.requestSnooze(exampleSnoozeNone);
    notifications.requestSnooze(exampleSnooze);
    notifications.snoozedBy(exampleWarn).should.equal(exampleSnooze);
    notifications.process();

    done();
  });

  it('Urgent alarms can\'t be snoozed by warn', function (done) {
    clearToDone(done); //shouldn't get called

    notifications.resetStateForTests();
    notifications.initRequests();
    notifications.requestNotify(exampleUrgent);
    notifications.requestSnooze(exampleSnooze);
    should.not.exist(notifications.snoozedBy(exampleUrgent));
    notifications.process();

    done();
  });

  it('Warnings can be snoozed by urgent', function (done) {
    notifyToDone(done); //shouldn't get called

    notifications.resetStateForTests();
    notifications.initRequests();
    notifications.requestNotify(exampleWarn);
    notifications.requestSnooze(exampleSnoozeUrgent);
    notifications.snoozedBy(exampleWarn).should.equal(exampleSnoozeUrgent);
    notifications.process();

    done();
  });

});
