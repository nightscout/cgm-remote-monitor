'use strict';

var request = require('supertest');
var should = require('should');
var Stream = require('stream');

var levels = require('../lib/levels');
var notificationsAPI = require('../lib/api/notifications-api');
var language = require('../lib/language')(); // Import the language module

function examplePlugin () {}

describe('Notifications API', function ( ) {

  it('ack notifications', function (done) {

    var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    var env = require('../lib/server/env')( );
    env.enclave.isApiKey(known).should.equal(true);
    env.testMode = true;

    var ctx = {
      bus: new Stream
      , ddata: {
        lastUpdated: Date.now()
      }
      , store: {
        collection: function ( ) {
          return { };
        }
      }
      , levels: levels
      , language: language
    };

    ctx.authorization = require('../lib/authorization')(env, ctx);

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
    require('../lib/middleware/configure-request')(app);
    app.enable('api');
    var wares = require('../lib/middleware/')(env);
    app.use('/', notificationsAPI(app, wares, ctx));

    function makeRequest () {
      request(app)
        .get('/notifications/ack?level=1')
        .set('api-secret', known || '')
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

  it('answers 200 to a Pushover callback for an unknown receipt', function (done) {
    var acks = [];
    var ctx = { pushnotify: { pushoverAck: function (body) { acks.push(body); return false; } } };
    var app = require('express')();
    app.use('/', notificationsAPI(app, {}, ctx));
    request(app)
      .post('/notifications/pushovercallback')
      .type('form')
      .send({ receipt: 'gone', acknowledged: '1' })
      .expect(200)
      .end(function (err) {
        should.not.exist(err);
        acks.should.have.length(1);
        acks[0].receipt.should.equal('gone');
        done();
      });
  });

  it('acknowledges a known receipt once and answers 200 to its repeated callback', async function () {
    var acks = [];
    var ctx = {
      bus: new Stream
      , levels: levels
      , notifications: { ack: function () { acks.push(Array.from(arguments)); } }
      , pushover: {
        send: function (notify, callback) {
          callback(null, JSON.stringify({ receipt: 'known' }));
        }
      }
    };
    var env = {
      settings: {
        isAlarmEventEnabled: function () { return true; }
        , snoozeFirstMinsForAlarmEvent: function () { return 15; }
      }
    };
    ctx.pushnotify = require('../lib/server/pushnotify')(env, ctx);
    var app = require('express')();
    app.use('/', notificationsAPI(app, {}, ctx));

    try {
      ctx.pushnotify.emitNotification({ level: levels.WARN, group: 'default', plugin: { name: 'test' } });
      await request(app).post('/notifications/pushovercallback').type('form')
        .send({ receipt: 'known', acknowledged: '1' }).expect(200);
      await request(app).post('/notifications/pushovercallback').type('form')
        .send({ receipt: 'known', acknowledged: '1' }).expect(200);
      should.deepEqual(acks, [[levels.WARN, 'default', 15 * 60 * 1000, true]]);
    } finally {
      ctx.bus.emit('teardown');
    }
  });

});