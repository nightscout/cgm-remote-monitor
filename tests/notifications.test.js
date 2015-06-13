var should = require('should');
var Stream = require('stream');

describe('units', function ( ) {

  var env = {};
  var ctx = {
    bus: new Stream
    , data: {
      lastUpdated: Date.now()
    }
  };

  var notifications = require('../lib/notifications')(env, ctx);

  it('initAndReInit', function (done) {
    notifications.initRequests();
    var notify = {
      title: 'test'
      , message: 'testing'
      , level: notifications.levels.WARN
    };
    notifications.requestNotify(notify);
    notifications.findHighestAlarm().should.equal(notify);
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
    var notify = {
      title: 'test'
      , message: 'testing'
      , level: notifications.levels.WARN
    };
    notifications.requestNotify(notify);
    notifications.findHighestAlarm().should.equal(notify);
    notifications.process();

  });


});
