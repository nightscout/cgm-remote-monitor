'use strict';

var request = require('supertest');
var should = require('should');
var Stream = require('stream');

var levels = require('../lib/levels');
var notificationsAPI = require('../lib/api/notifications-api');

function examplePlugin () {}

describe('Notifications API', function ( ) {

  it('ack notifications', function (done) {

    var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    var env = require('../env')( );
    env.api_secret.should.equal(known);
    env.testMode = true;

    var ctx = {
      bus: new Stream
      , ddata: {
        lastUpdated: Date.now()
      }
    };

    var notifications = require('../lib/notifications')(env, ctx);
    ctx.notifications = notifications;

    //start fresh to we don't pick up other notifications
    ctx.bus = new Stream;
    //if notification doesn't get called test will time out
    ctx.bus.on('notification', function callback (notify) {
      if (notify.clear) {
        done();
      }
    });

    var exampleWarn = {
      title: 'test'
      , message: 'testing'
      , level: levels.WARN
      , plugin: examplePlugin
    };

    notifications.resetStateForTests();
    notifications.initRequests();
    notifications.requestNotify(exampleWarn);
    notifications.findHighestAlarm().should.equal(exampleWarn);
    notifications.process();

    var app = require('express')();
    app.enable('api');
    var wares = require('../lib/middleware/')(env);
    app.use('/', notificationsAPI(app, wares, ctx));

    function makeRequest () {
      request(app)
        .get('/notifications/ack?level=1')
        .set('api-secret', env.api_secret || '')
        .expect(200)
        .end(function (err) {
          should.not.exist(err);
          if (err) {
            console.error(err);
          }
        });
    }

    makeRequest();

    //2nd call should have no effect, done should NOT be called again
    makeRequest();
  });
});