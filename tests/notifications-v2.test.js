'use strict';

var assert = require('node:assert/strict');
var express = require('express');
var request = require('supertest');
var apn = require('@parse/node-apn');
var shiroTrie = require('shiro-trie');
var notificationsV2 = require('../lib/api2/notifications-v2');
var unexpectedMessage = 'Loop notification failed unexpectedly. Ask the Nightscout administrator to check the server logs for details.';

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
      if (Object.prototype.hasOwnProperty.call(options, 'providerError')) { throw options.providerError; }
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

  function post (fixture, body) {
    return request(fixture.app)
      .post('/api/v2/notifications/loop')
      .send(body || { eventType: 'Temporary Override Cancel' });
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
    ['BadProviderToken', /authentication token.*signing key/],
    ['InvalidProviderToken', /authentication token.*signing key/],
    ['ExpiredProviderToken', /token has expired.*server clock/],
    ['BadDeviceToken', /device token is invalid.*environment matches/],
    ['Unregistered', /no longer registered.*profile upload/],
    ['PayloadTooLarge', /too large.*Shorten the notes/],
    ['TooManyRequests', /too many requests.*rate limit/],
    ['InternalServerError', /internal error.*service status/],
    ['ServiceUnavailable', /temporarily unavailable.*service status/]
  ].forEach(function (testCase) {
    var reason = testCase[0];
    it('shows the APNs headline for ' + reason + ' without exposing delivery details', async function () {
      var fixture = makeApp({ send: failedSend(reason) });
      var response = await post(fixture);
      assert.equal(response.status, 500);
      assert(response.text.startsWith('Failed to send notification (APNs: ' + reason + '). '));
      assert.match(response.text, testCase[1]);
      assert.doesNotMatch(response.text, /private-test|\/private/);
      assert.equal(fixture.calls.length, 1);
      assert(logs.some(function (args) {
        return args[0] === 'APNs delivery failed: ' + reason &&
          args[1].device === 'private-test-device-token';
      }), 'full APNs delivery details should remain in server logs');
    });
  });

  [
    'FutureUnknownReason', 'BadProviderToken /private/test/key.p8',
    'BadProviderToken\nprivate-test-token', '<script>private-test-token</script>',
    { reason: 'BadProviderToken', token: 'private-test-token' }
  ].forEach(function (reason, index) {
    it('keeps unknown or malformed APNs reason ' + index + ' opaque', async function () {
      var response = await post(makeApp({ send: failedSend(reason) }));
      assert.equal(response.status, 500);
      assert.equal(response.text, unexpectedMessage);
    });
  });

  it('keeps unexpected provider rejections opaque', async function () {
    var fixture = makeApp({ send: function () {
      return Promise.reject(new Error('private-test-token /private/test/key.p8'));
    } });
    var response = await post(fixture);
    assert.equal(response.status, 500);
    assert.equal(response.text, unexpectedMessage);
    assert(logs.some(function (args) {
      return args[0] === 'Unexpected error during APNs delivery:' &&
        args[1].message === 'private-test-token /private/test/key.p8';
    }));
  });

  it('explains when APNs provides no failure details', async function () {
    var fixture = makeApp({ send: function () { return Promise.resolve({ sent: [], failed: [] }); } });
    var response = await post(fixture);
    assert.equal(response.status, 500);
    assert.equal(response.text, 'Failed to send notification: APNs did not provide failure details. Ask the Nightscout administrator to check the server logs for details.');
  });

  [undefined, null, ''].forEach(function (reason, index) {
    it('explains an APNs response with no reason ' + index, async function () {
      var response = await post(makeApp({ send: failedSend(reason) }));
      assert.equal(response.status, 500);
      assert.equal(response.text, 'Failed to send notification: APNs did not provide a failure reason. Ask the Nightscout administrator to check the server logs for details.');
    });
  });

  [
    {
      name: 'missing APNs key',
      setup: function (f) { delete f.env.extendedSettings.loop.apnsKey; },
      expected: /LOOP_APNS_KEY is not configured.*administrator.*signing key/
    },
    {
      name: 'empty APNs key',
      setup: function (f) { f.env.extendedSettings.loop.apnsKey = ''; },
      expected: /LOOP_APNS_KEY is not configured.*administrator.*signing key/
    },
    {
      name: 'missing APNs key ID',
      setup: function (f) { delete f.env.extendedSettings.loop.apnsKeyId; },
      expected: /LOOP_APNS_KEY_ID is not configured.*administrator.*key ID/
    },
    {
      name: 'empty APNs key ID',
      setup: function (f) { f.env.extendedSettings.loop.apnsKeyId = ''; },
      expected: /LOOP_APNS_KEY_ID is not configured.*administrator.*key ID/
    },
    {
      name: 'missing developer team ID',
      setup: function (f) { delete f.env.extendedSettings.loop.developerTeamId; },
      expected: /LOOP_DEVELOPER_TEAM_ID is missing or invalid.*10-character/
    },
    {
      name: 'invalid developer team ID',
      setup: function (f) { f.env.extendedSettings.loop.developerTeamId = 'invalid-private-team-id'; },
      expected: /LOOP_DEVELOPER_TEAM_ID is missing or invalid.*10-character/
    },
    {
      name: 'missing profiles',
      setup: function (f) { delete f.ctx.ddata.profiles; },
      expected: /profile has no Loop settings.*Check that Loop is uploading/
    },
    {
      name: 'empty profiles',
      setup: function (f) { f.ctx.ddata.profiles = []; },
      expected: /profile has no Loop settings.*Check that Loop is uploading/
    },
    {
      name: 'missing Loop settings',
      setup: function (f) { delete f.ctx.ddata.profiles[0].loopSettings; },
      expected: /profile has no Loop settings.*Check that Loop is uploading/
    },
    {
      name: 'missing device token',
      setup: function (f) { delete f.ctx.ddata.profiles[0].loopSettings.deviceToken; },
      expected: /profile is missing its device token.*profile upload in Loop/
    },
    {
      name: 'missing app identifier',
      setup: function (f) { delete f.ctx.ddata.profiles[0].loopSettings.bundleIdentifier; },
      expected: /profile is missing its app identifier.*profile upload in Loop/
    }
  ].forEach(function (testCase) {
    it('gives an actionable reason for ' + testCase.name, async function () {
      var fixture = makeApp();
      testCase.setup(fixture);
      var response = await post(fixture);
      assert.equal(response.status, 500);
      assert.match(response.text, testCase.expected);
      assert.doesNotMatch(response.text, /private-test|invalid-private-team-id/);
      assert.equal(fixture.calls.length, 0);
      assert(logs.some(function (args) { return args[0] === 'error sending notification to Loop: '; }));
    });
  });

  ['not-a-number-private-test', 0, -1].forEach(function (amount) {
    [
      { event: 'Remote Carbs Entry', field: 'remoteCarbs', label: 'carbs', check: 'carbohydrate' },
      { event: 'Remote Bolus Entry', field: 'remoteBolus', label: 'bolus', check: 'bolus' }
    ].forEach(function (testCase) {
      it('explains invalid ' + testCase.label + ' entry ' + amount, async function () {
        var fixture = makeApp();
        var body = { eventType: testCase.event, [testCase.field]: amount };
        var response = await post(fixture, body);
        assert.equal(response.status, 500);
        assert.equal(response.text, 'Loop remote ' + testCase.label + ' failed: invalid ' + testCase.label + ' entry. Check the ' + testCase.check + ' amount entered.');
        assert.equal(fixture.calls.length, 0);
      });
    });
  });

  it('explains unsupported commands without reflecting the submitted event type', async function () {
    var fixture = makeApp();
    var response = await post(fixture, { eventType: '<script>private-test-event</script>' });
    assert.equal(response.status, 500);
    assert.equal(response.text, 'Loop notification failed: unsupported command. Check that the client is sending a supported Loop remote command.');
    assert.equal(fixture.calls.length, 0);
  });

  it('does not reflect extra data appended to a known local diagnostic', async function () {
    var fixture = makeApp();
    fixture.ctx.loop.sendNotification = function (body, address, completion) {
      completion('Loop notification failed: LOOP_APNS_KEY not set. private-test-key');
    };
    var response = await post(fixture);
    assert.equal(response.status, 500);
    assert.equal(response.text, unexpectedMessage);
  });

  it('handles synchronous provider setup exceptions without leaking their details', async function () {
    var error = new Error('private-test-key at /private/test/key.p8');
    var fixture = makeApp({ providerError: error });
    var response = await post(fixture);
    assert.equal(response.status, 500);
    assert.equal(response.text, unexpectedMessage);
    assert(logs.some(function (args) { return args[1] === error; }));
  });

  it('does not report success when provider setup throws a non-Error value', async function () {
    var response = await post(makeApp({ providerError: null }));
    assert.equal(response.status, 500);
    assert.equal(response.text, unexpectedMessage);
  });

  it('does not serialize arbitrary callback error objects', async function () {
    var fixture = makeApp();
    var error = { message: 'APNs delivery failed: BadProviderToken', token: 'private-test-token' };
    fixture.ctx.loop.sendNotification = function (body, address, completion) { completion(error); };
    var response = await post(fixture);
    assert.equal(response.status, 500);
    assert.equal(response.text, unexpectedMessage);
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
