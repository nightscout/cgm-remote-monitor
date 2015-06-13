var should = require('should');
var Stream = require('stream');

describe('notifications', function ( ) {

  var env = {};
  var ctx = {
    bus: new Stream
    , data: {
      lastUpdated: Date.now()
    }
  };

  var notifications = require('../lib/notifications')(env, ctx);

  var exampleWarn = {
    title: 'test'
    , message: 'testing'
    , level: notifications.levels.WARN
  };

  var exampleUrgent = {
    title: 'test'
    , message: 'testing'
    , level: notifications.levels.URGENT
  };

  var exampleSnooze = {
    level: notifications.levels.WARN
    , mills: 1000
  };

  var exampleSnoozeNone = {
    level: notifications.levels.WARN
    , mills: -1000
  };

  var exampleSnoozeUrgent = {
    level: notifications.levels.URGENT
    , mills: 1000
  };

  it('initAndReInit', function (done) {
    notifications.initRequests();
    notifications.requestNotify(exampleWarn);
    notifications.findHighestAlarm().should.equal(exampleWarn);
    notifications.initRequests();
    should.not.exist(notifications.findHighestAlarm());
    done();
  });


  it('emitANotification', function (done) {
    //if notification doesn't get called test will time out
    ctx.bus.on('notification', function callback ( ) {
      done();
    });

    notifications.initRequests();
    notifications.requestNotify(exampleWarn);
    notifications.findHighestAlarm().should.equal(exampleWarn);
    notifications.process();
  });

  it('Can be snoozed', function (done) {
    notifications.initRequests();
    notifications.requestNotify(exampleWarn);
    notifications.requestSnooze(exampleSnooze);
    notifications.snoozedBy(exampleWarn).should.equal(exampleSnooze);

    done();
  });

  it('Can be snoozed by last snooze', function (done) {
    notifications.initRequests();
    notifications.requestNotify(exampleWarn);
    notifications.requestSnooze(exampleSnoozeNone);
    notifications.requestSnooze(exampleSnooze);
    notifications.snoozedBy(exampleWarn).should.equal(exampleSnooze);

    done();
  });

  it('Urgent alarms can\'t be snoozed by warn', function (done) {
    notifications.initRequests();
    notifications.requestNotify(exampleUrgent);
    notifications.requestSnooze(exampleSnooze);
    should.not.exist(notifications.snoozedBy(exampleUrgent));

    done();
  });

  it('Warnings can be snoozed by urgent', function (done) {
    notifications.initRequests();
    notifications.requestNotify(exampleWarn);
    notifications.requestSnooze(exampleSnoozeUrgent);
    notifications.snoozedBy(exampleWarn).should.equal(exampleSnoozeUrgent);

    done();
  });

});
