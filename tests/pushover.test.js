'use strict';

var should = require('should');
var levels = require('../lib/levels');

describe('pushover', function ( ) {

  var baseurl = 'https://nightscout.test';

  var env = {
    baseUrl: baseurl
    , extendedSettings: {
      pushover: {
        userKey: '12345'
        , apiToken: '6789'
      }
    }
  };

  var pushover = require('../lib/plugins/pushover')(env);

  it('convert a warning to a message and send it', function (done) {

    var notify = {
      title: 'Warning, this is a test!'
      , level: levels.WARN
      , pushoverSound: 'climb'
      , plugin: {name: 'test'}
    };

    pushover.sendAPIRequest = function mockedSendAPIRequest (msg) {
      msg.title.should.equal(notify.title);
      should.not.exist(msg.message);
      msg.priority.should.equal(2);
      msg.retry.should.equal(15 * 60);
      msg.sound.should.equal(notify.pushoverSound);
      msg.callback.indexOf(baseurl).should.equal(0);
      done();
    };

    pushover.send(notify);
  });

  it('convert an urgent to a message and send it', function (done) {

    var notify = {
      title: 'Urgent, this is a test!'
      , message: 'details details details details'
      , level: levels.URGENT
      , pushoverSound: 'persistent'
      , plugin: {name: 'test'}
    };

    pushover.sendAPIRequest = function mockedSendAPIRequest (msg) {
      msg.title.should.equal(notify.title);
      msg.message.should.equal(notify.message);
      msg.priority.should.equal(2);
      msg.retry.should.equal(2 * 60);
      msg.sound.should.equal(notify.pushoverSound);
      done();
    };

    pushover.send(notify);
  });

});

describe('support legacy pushover groupkey', function ( ) {
  var env = {
    extendedSettings: {
      pushover: {
        groupKey: 'abcd'
        , apiToken: '6789'
      }
    }
  };

  var pushover = require('../lib/plugins/pushover')(env);

  it('send', function (done) {

    var notify = {
      title: 'Warning, this is a test!'
      , message: 'details details details details'
      , level: levels.WARN
      , pushoverSound: 'climb'
      , plugin: {name: 'test'}
      , isAnnouncement: true
    };

    pushover.sendAPIRequest = function mockedSendAPIRequest (msg) {
      msg.title.should.equal(notify.title);
      msg.priority.should.equal(2);
      msg.sound.should.equal(notify.pushoverSound);
      done();
    };

    pushover.send(notify);
  });

});

describe('multi announcement pushover', function ( ) {
  var env = {
    extendedSettings: {
      pushover: {
        userKey: 'use announcementKey instead'
        , announcementKey: 'abcd efgh'
        , apiToken: '6789'
      }
    }
  };

  var pushover = require('../lib/plugins/pushover')(env);

  it('send multiple pushes if there are multiple keys', function (done) {

    var notify = {
      title: 'Warning, this is a test!'
      , message: 'details details details details'
      , level: levels.WARN
      , pushoverSound: 'climb'
      , plugin: {name: 'test'}
      , isAnnouncement: true
    };

    var key1Found = false;
    var key2Found = false;

    pushover.sendAPIRequest = function mockedSendAPIRequest (msg) {
      msg.title.should.equal(notify.title);
      msg.priority.should.equal(2);
      msg.sound.should.equal(notify.pushoverSound);

      key1Found = key1Found || msg.user === 'abcd';
      key2Found = key2Found || msg.user === 'efgh';

      if (key1Found && key2Found) {
        done();
      }
    };

    pushover.send(notify);
  });

});

describe('announcement only pushover', function ( ) {
  var env = {
    extendedSettings: {
      pushover: {
        announcementKey: 'abcd'
        , apiToken: '6789'
      }
    }
  };

  var pushover = require('../lib/plugins/pushover')(env);

  it('send push if announcement', function (done) {

    var notify = {
      title: 'Warning, this is a test!'
      , message: 'details details details details'
      , level: levels.WARN
      , pushoverSound: 'climb'
      , plugin: {name: 'test'}
      , isAnnouncement: true
    };

    pushover.sendAPIRequest = function mockedSendAPIRequest (msg) {
      msg.title.should.equal(notify.title);
      msg.priority.should.equal(2);
      msg.sound.should.equal(notify.pushoverSound);

      done();
    };

    pushover.send(notify);
  });

  it('not send push if not announcement and no user key', function (done) {

    var notify = {
      title: 'Warning, this is a test!'
      , message: 'details details details details'
      , level: levels.WARN
      , pushoverSound: 'climb'
      , plugin: {name: 'test'}
    };

    pushover.sendAPIRequest = function failIfSend ( ) {
      done();
    };

    pushover.send(notify);
    done();
  });

});
