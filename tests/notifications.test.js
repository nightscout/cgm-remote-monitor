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

  function examplePlugin () {};

  var exampleInfo = {
    title: 'test'
    , message: 'testing'
    , level: notifications.levels.INFO
    , plugin: examplePlugin
  };

  var exampleWarn = {
    title: 'test'
    , message: 'testing'
    , level: notifications.levels.WARN
    , plugin: examplePlugin
  };

  var exampleUrgent = {
    title: 'test'
    , message: 'testing'
    , level: notifications.levels.URGENT
    , plugin: examplePlugin
  };

  var exampleSnooze = {
    level: notifications.levels.WARN
    , lengthMills: 1000
  };

  var exampleSnoozeNone = {
    level: notifications.levels.WARN
    , lengthMills: 1
  };

  var exampleSnoozeUrgent = {
    level: notifications.levels.URGENT
    , lengthMills: 1000
  };

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

    notifications.initRequests();
    notifications.requestNotify(exampleWarn);
    notifications.findHighestAlarm().should.equal(exampleWarn);
    notifications.process();
  });

  it('emitAnInfo', function (done) {
    //start fresh to we don't pick up other notifications
    ctx.bus = new Stream;
    //if notification doesn't get called test will time out
    ctx.bus.on('notification', function callback (notify) {
      if (!notify.clear) {
        done();
      }
    });

    notifications.initRequests();
    notifications.requestNotify(exampleInfo);
    should.not.exist(notifications.findHighestAlarm());

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
