'use strict';

var should = require('should');
var levels = require('../lib/levels');

describe('pushnotify', function ( ) {

  it('send a pushover alarm, but only 1 time', function (done) {
    var env = require('../env')();
    var ctx = {};

    ctx.notifications = require('../lib/notifications')(env, ctx);

    var notify = {
      title: 'Warning, this is a test!'
      , message: 'details details details details'
      , level: levels.WARN
      , pushoverSound: 'climb'
      , plugin: {name: 'test'}
    };

    ctx.pushover = {
      PRIORITY_NORMAL: 0
      , PRIORITY_EMERGENCY: 2
      , send: function mockedSend (notify2, callback) {
          should.deepEqual(notify, notify2);
          callback(null, JSON.stringify({receipt: 'abcd12345'}));
          done();
        }
    };

    ctx.pushnotify = require('../lib/server/pushnotify')(env, ctx);

    ctx.pushnotify.emitNotification(notify);

    //call again, but should be deduped, or fail with 'done() called multiple times'
    ctx.pushnotify.emitNotification(notify);

  });

  it('send a pushover notification, but only 1 time', function (done) {
    var env = require('../env')();
    var ctx = {};

    ctx.notifications = require('../lib/notifications')(env, ctx);

    var notify = {
      title: 'Sent from a test'
      , message: 'details details details details'
      , level: levels.INFO
      , plugin: {name: 'test'}
    };

    ctx.pushover = {
      PRIORITY_NORMAL: 0
      , PRIORITY_EMERGENCY: 2
      , send: function mockedSend (notify2, callback) {
        should.deepEqual(notify, notify2);
          callback(null, JSON.stringify({}));
          done();
        }
    };

    ctx.pushnotify = require('../lib/server/pushnotify')(env, ctx);

    ctx.pushnotify.emitNotification(notify);

    //call again, but should be deduped, or fail with 'done() called multiple times'
    ctx.pushnotify.emitNotification(notify);

  });

  it('send a pushover alarm, and then cancel', function (done) {
    var env = require('../env')();
    var ctx = {};

    ctx.notifications = require('../lib/notifications')(env, ctx);

    var notify = {
      title: 'Warning, this is a test!'
      , message: 'details details details details'
      , level: levels.WARN
      , pushoverSound: 'climb'
      , plugin: {name: 'test'}
    };

    ctx.pushover = {
      PRIORITY_NORMAL: 0
      , PRIORITY_EMERGENCY: 2
      , send: function mockedSend (notify2, callback) {
        should.deepEqual(notify, notify2);
        callback(null, JSON.stringify({receipt: 'abcd12345'}));
      }
      , cancelWithReceipt: function mockedCancel (receipt) {
        receipt.should.equal('abcd12345');
        done();
      }
    };

    ctx.pushnotify = require('../lib/server/pushnotify')(env, ctx);

    //first send the warning
    ctx.pushnotify.emitNotification(notify);

    //then pretend is was acked from the web
    ctx.pushnotify.emitNotification({clear: true});

  });



});
