'use strict';

var assert = require('node:assert/strict');
var express = require('express');
var request = require('supertest');
var apn = require('@parse/node-apn');
var shiroTrie = require('shiro-trie');
var notificationsV2 = require('../lib/api2/notifications-v2');

describe('Loop notifications API v2', function () {
  var originalProvider;
  var originalNotification;
  var originalLog;
  var originalError;
  var logs;

  beforeEach(function () {
    originalProvider = apn.Provider;
    originalNotification = apn.Notification;
    originalLog = console.log;
    originalError = console.error;
    logs = [];
    console.log = console.error = function () {
      logs.push(Array.from(arguments));
    };
  });

  afterEach(function () {
    apn.Provider = originalProvider;
    apn.Notification = originalNotification;
    console.log = originalLog;
    console.error = originalError;
  });

  function makeApp (options) {
    options = options || {};
    var env = require('../lib/server/env')();
    env.extendedSettings.loop = {
      apnsKey: 'private-test-key',
      apnsKeyId: 'private-test-key-id',
      developerTeamId: 'TEAMID1234'
    };
    var calls = [];
    apn.Provider = function MockProvider () {
      this.send = function (notification, tokens) {
        calls.push({ notification: notification, tokens: tokens });
        return options.send ? options.send() : Promise.resolve({ sent: [{}], failed: [] });
      };
    };
    apn.Notification = function MockNotification () {};

    var ctx = {
      language: require('../lib/language')(),
      store: { collection: function () { return {}; } },
      ddata: {
        profiles: [{
          loopSettings: {
            deviceToken: 'private-test-device-token',
            bundleIdentifier: 'com.example.loop'
          }
        }]
      },
      wares: require('../lib/middleware')(env)
    };
    ctx.loop = require('../lib/server/loop')(env, ctx);
    ctx.authorization = require('../lib/authorization')(env, ctx);
    var shiro = shiroTrie.new();
    shiro.add(options.denied ? ['api:read'] : ['notifications:loop:push']);
    // Exercise the real permission check without a database or real credentials.
    ctx.authorization.resolve = async function () { return { shiros: [shiro] }; };

    var app = express();
    app.use(ctx.wares.sendJSONStatus);
    app.use('/api/v2/notifications', notificationsV2(app, ctx));
    return { app: app, calls: calls, ctx: ctx, env: env };
  }

  function post (fixture) {
    return request(fixture.app)
      .post('/api/v2/notifications/loop')
      .send({ eventType: 'Temporary Override Cancel' });
  }

  function failedSend (reason) {
    return function () {
      return Promise.resolve({ sent: [], failed: [{
        device: 'private-test-device-token',
        response: { reason: reason },
        error: { path: '/private/test/key.p8', token: 'private-test-token' }
      }] });
    };
  }

  [
    'BadProviderToken', 'InvalidProviderToken', 'ExpiredProviderToken',
    'BadDeviceToken', 'Unregistered', 'PayloadTooLarge', 'TooManyRequests',
    'InternalServerError', 'ServiceUnavailable'
  ].forEach(function (reason) {
    it('shows the APNs headline for ' + reason + ' without exposing delivery details', async function () {
      var fixture = makeApp({ send: failedSend(reason) });
      var response = await post(fixture);
      assert.equal(response.status, 500);
      assert.equal(response.text, 'Failed to send notification (APNs: ' + reason + ')');
      assert.equal(fixture.calls.length, 1);
      assert(logs.some(function (args) {
        return args[0] === 'APNs delivery failed: ' + reason &&
          args[1].device === 'private-test-device-token';
      }), 'full APNs delivery details should remain in server logs');
    });
  });

  [
    undefined, 'FutureUnknownReason', 'BadProviderToken /private/test/key.p8',
    'BadProviderToken\nprivate-test-token', '<script>private-test-token</script>',
    { reason: 'BadProviderToken', token: 'private-test-token' }
  ].forEach(function (reason, index) {
    it('keeps missing, unknown or malformed APNs reason ' + index + ' opaque', async function () {
      var response = await post(makeApp({ send: failedSend(reason) }));
      assert.equal(response.status, 500);
      assert.equal(response.text, 'Failed to send notification');
    });
  });

  it('keeps unexpected provider rejections opaque', async function () {
    var fixture = makeApp({ send: function () {
      return Promise.reject(new Error('private-test-token /private/test/key.p8'));
    } });
    var response = await post(fixture);
    assert.equal(response.status, 500);
    assert.equal(response.text, 'Failed to send notification');
    assert(logs.some(function (args) {
      return args[0] === 'Unexpected error during APNs delivery:' &&
        args[1].message === 'private-test-token /private/test/key.p8';
    }));
  });

  it('keeps a failure with no APNs details opaque', async function () {
    var fixture = makeApp({ send: function () { return Promise.resolve({ sent: [], failed: [] }); } });
    var response = await post(fixture);
    assert.equal(response.status, 500);
    assert.equal(response.text, 'Failed to send notification');
  });

  it('keeps local configuration failures opaque and logs the diagnostic', async function () {
    var fixture = makeApp();
    delete fixture.env.extendedSettings.loop.apnsKey;
    var response = await post(fixture);
    assert.equal(response.status, 500);
    assert.equal(response.text, 'Failed to send notification');
    assert.equal(fixture.calls.length, 0);
    assert(logs.some(function (args) { return args[1] === 'Loop notification failed: LOOP_APNS_KEY not set.'; }));
  });

  it('does not serialize arbitrary callback error objects', async function () {
    var fixture = makeApp();
    var error = { message: 'APNs delivery failed: BadProviderToken', token: 'private-test-token' };
    fixture.ctx.loop.sendNotification = function (body, address, completion) { completion(error); };
    var response = await post(fixture);
    assert.equal(response.status, 500);
    assert.equal(response.text, 'Failed to send notification');
    assert(logs.some(function (args) { return args[1] === error; }));
  });

  it('preserves successful notification responses and payload forwarding', async function () {
    var fixture = makeApp();
    var response = await request(fixture.app)
      .post('/api/v2/notifications/loop')
      .type('form')
      .send({ eventType: 'Temporary Override Cancel', notes: 'test note', enteredBy: 'test user' });
    assert.equal(response.status, 200);
    assert.equal(response.text, 'OK');
    assert.equal(fixture.calls.length, 1);
    assert.deepEqual(fixture.calls[0].tokens, ['private-test-device-token']);
    assert.equal(fixture.calls[0].notification.payload.notes, 'test note');
    assert.equal(fixture.calls[0].notification.payload['entered-by'], 'test user');
  });

  it('rejects callers without permission before attempting APNs delivery', async function () {
    var fixture = makeApp({ denied: true });
    var response = await post(fixture);
    assert.equal(response.status, 401);
    assert.equal(fixture.calls.length, 0);
  });
});
