'use strict';

var fs = require('fs');
var http2 = require('http2');
var crypto = require('crypto');
var should = require('should');
var apn = require('@parse/node-apn');

// Each Loop remote command builds an APNs provider, and a provider keeps its
// HTTP/2 connection open (with a heartbeat) until shutdown() is called. These
// tests count the connections a local fake APNs server still holds afterwards.
describe('server loop notifications close their APNs connection', function () {
  this.timeout(10000);

  var OriginalProvider = apn.Provider;
  var server;
  var sessions = new Set();
  var providersBuilt = 0;

  var apnsKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' });

  before(function (done) {
    server = http2.createSecureServer({
      key: fs.readFileSync('./tests/fixtures/localhost.key')
      , cert: fs.readFileSync('./tests/fixtures/localhost.crt')
    });
    server.on('session', function (session) {
      sessions.add(session);
      session.on('close', function () { sessions.delete(session); });
    });
    server.on('stream', function (stream) {
      stream.on('data', function () { });
      stream.on('end', function () {
        stream.respond({ ':status': 200, 'content-type': 'application/json' });
        stream.end();
      });
    });
    server.listen(0, '127.0.0.1', function () {
      var port = server.address().port;
      apn.Provider = function PatchedProvider (options) {
        providersBuilt++;
        options.address = 'localhost';
        options.port = port;
        options.rejectUnauthorized = false;
        return new OriginalProvider(options);
      };
      done();
    });
  });

  afterEach(function () {
    sessions.forEach(function (session) { session.destroy(); });
  });

  after(function (done) {
    apn.Provider = OriginalProvider;
    sessions.forEach(function (session) { session.destroy(); });
    server.close(function () { done(); });
  });

  function makeLoop () {
    var env = {
      extendedSettings: {
        loop: {
          apnsKey: apnsKey,
          apnsKeyId: 'test-key-id',
          developerTeamId: 'TEAMID1234',
          pushServerEnvironment: 'development'
        }
      }
    };
    var ctx = {
      ddata: {
        profiles: [{ loopSettings: { deviceToken: 'test-device-token', bundleIdentifier: 'com.example.loop' } }]
      }
    };
    return require('../lib/server/loop')(env, ctx);
  }

  function send (loop, data) {
    return new Promise(function (resolve) {
      loop.sendNotification(data, '127.0.0.1', resolve);
    });
  }

  // Wait for the server to see its sessions close, up to a limit.
  function openSessionsAfterSettling () {
    var deadline = Date.now() + 2000;
    return new Promise(function (resolve) {
      (function check () {
        if (sessions.size === 0 || Date.now() > deadline) {
          resolve(sessions.size);
        } else {
          setTimeout(check, 25);
        }
      })();
    });
  }

  it('leaves no APNs connection open after three remote commands', async function () {
    var loop = makeLoop();
    for (var i = 0; i < 3; i++) {
      var err = await send(loop, { eventType: 'Temporary Override Cancel' });
      should.not.exist(err);
    }
    var open = await openSessionsAfterSettling();
    open.should.equal(0, open + ' APNs connections still open after 3 remote commands');
  });

  it('leaves no APNs connection open when APNs refuses the push', async function () {
    server.once('stream', function (stream) {
      stream.removeAllListeners('end');
      stream.on('end', function () {
        stream.respond({ ':status': 400, 'content-type': 'application/json' });
        stream.end(JSON.stringify({ reason: 'BadDeviceToken' }));
      });
    });
    var err = await send(makeLoop(), { eventType: 'Temporary Override Cancel' });
    should.exist(err);
    err.should.equal('APNs delivery failed: BadDeviceToken');
    var open = await openSessionsAfterSettling();
    open.should.equal(0, open + ' APNs connections still open after a refused push');
  });

  it('builds no APNs provider for a command it refuses before sending', async function () {
    var before = providersBuilt;
    var err = await send(makeLoop(), { eventType: 'Remote Bolus Entry', remoteBolus: 0 });
    should.exist(err);
    (providersBuilt - before).should.equal(0);
  });
});
