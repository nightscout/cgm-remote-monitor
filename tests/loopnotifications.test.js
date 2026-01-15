/**
 * Wikipedia: Apple Push Notification service (APNs)
 * https://en.wikipedia.org/wiki/Apple_Push_Notification_service
 *
 * APNs response doc:
 * https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns
 */

'use strict';

const fs = require('fs');
const http2 = require('http2');
const should = require('should');
const request = require('supertest');
const instance = require('./fixtures/api/instance');

const fakeServerOpts = {
  key: fs.readFileSync('./tests/fixtures/localhost.key')
  , cert: fs.readFileSync('./tests/fixtures/localhost.crt')
, };

const TEST_PORT = 1338;
const API_SECRET_HASH = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

describe('iOS Loop push notifications', function() {
  this.timeout(10000);

  let fakeAPNServer;
  let fakeAPNServerSessions; // Must track these for server cleanup. Otherwise it hangs.

  /**
   * Let's capture the HTTP request sent to APNs via "@parse/node-apn" npm package.
   */
  let capturedApnRequest;
  let inst;
  let OriginalApnProviderClass

  before(async function() {
    // Monkey patch apn.Provider to route traffic to our local fake server
    const apn = require('@parse/node-apn')
    class PatchedApnProvider extends apn.Provider {
      constructor(options) {
        options.address = 'localhost';
        options.port = TEST_PORT;
        options.rejectUnauthorized = false;
        super(options);
      }
    }
    OriginalApnProviderClass = apn.Provider;
    apn.Provider = PatchedApnProvider

    // Generated with "openssl ecparam -name prime256v1 -genkey -noout -out dummy_private_key.pem"
    process.env.LOOP_APNS_KEY = './tests/fixtures/dummy_private_key.pem';

    process.env.LOOP_APNS_KEY_ID = 'fake_apns_key_id';
    process.env.LOOP_DEVELOPER_TEAM_ID = 'fake_12345';
    process.env.ENABLE = 'loop';

    inst = await instance.create({
      apiSecret: process.env.API_SECRET
    , });
    // require('../lib')
    const api = require('../lib/api')(inst.env, inst.ctx);
    const api2 = require('../lib/api2')(inst.env, inst.ctx, api);

    inst.app.use('/api/v1', api);
    inst.app.use('/api/v2', api2);

    await request(inst.app)
      .put('/api/v1/profile')
      .set('api-secret', API_SECRET_HASH)
      .send({
        // iOS loop integration requires these are configured in the user profile.
        // Presumably the Loop app uploads them to Nightscout automatically?
        loopSettings: { deviceToken: "fakedevicetoken", bundleIdentifier: "fakebundleid" }
      , })
      .expect(200);

    return new Promise((resolve, reject) => {
      inst.ctx.dataloader.update(inst.ctx.ddata, (err) => {
        if (err) {
          reject(err)
        } else {
          resolve();
        }
      });
    });
  });

  beforeEach(function(done) {
    fakeAPNServerSessions = new Set();
    fakeAPNServer = http2.createSecureServer(fakeServerOpts);

    fakeAPNServer.on('session', (session) => {
      fakeAPNServerSessions.add(session);
    });

    capturedApnRequest = new Promise((resolve) => {
      fakeAPNServer.on('stream', (stream, headers) => {
        let body = '';
        stream.on('data', chunk => (body += chunk));
        stream.on('end', () => {
          stream.respond({ ':status': 200, 'content-type': 'application/json' });
          stream.end();
          resolve({
            json: JSON.parse(body)
            , headers
          });
        });
      });
    });

    fakeAPNServer.listen(TEST_PORT, done);
  });

  afterEach(function(done) {
    for (const session of fakeAPNServerSessions) {
      session.destroy();
    }

    fakeAPNServer.close(done);
  });

  after(function() {
    const apn = require('@parse/node-apn')
    apn.Provider = OriginalApnProviderClass;
  });

  function postLoopNotification (jsonBody) {
    return request(inst.app)
      .post('/api/v2/notifications/loop')
      .send(jsonBody)
      .set('api-secret', API_SECRET_HASH)
      .expect(200);
  }

  it('Sends carb entry with ', async function() {
    await postLoopNotification({
      eventType: "Remote Carbs Entry"
      , remoteCarbs: 5
      , remoteAbsorption: 2
      , otp: "fakeotp"
      , created_at: '2020-01-01T10:10:10'
    });

    const { json } = await capturedApnRequest;
    json['carbs-entry'].should.equal(5);
    json['absorption-time'].should.equal(2);
    json['otp'].should.equal("fakeotp");
    json['start-time'].should.equal("2020-01-01T10:10:10");
  });

  it('Sends payload with absorption-time after Remote Carbs Entry', async function() {
    await postLoopNotification({
      eventType: "Remote Carbs Entry"
      , remoteCarbs: 5
    });

    const { json } = await capturedApnRequest;
    json['absorption-time'].should.equal(3);
  });

  it('Sends payload with bolus-entry field after Remote Bolus Entry', async function() {
    await postLoopNotification({
      eventType: "Remote Bolus Entry"
      , remoteBolus: 2.5
    });

    const { json } = await capturedApnRequest;
    json['bolus-entry'].should.approximately(2.5, 0.01);
  });

  it('Sends payload with cancel-temporary-override after Temporary Override Cancel', async function() {
    await postLoopNotification({
      eventType: "Temporary Override Cancel"
    });

    const { json } = await capturedApnRequest;
    json['cancel-temporary-override'].should.equal("true");
  });

  it('Sends payload with override-name after Temporary Override', async function() {
    await postLoopNotification({
      eventType: "Temporary Override"
      , duration: 5
      , reason: "stress"
    });

    const { json } = await capturedApnRequest;
    json['override-name'].should.equal("stress");
  });

  it('Sends valid JWT Bearer token in Authorization header', async function() {
    await postLoopNotification({
      eventType: "Remote Bolus Entry"
      , remoteBolus: 2.5
    });

    const { headers } = await capturedApnRequest;

    should.exist(headers);
    should(headers).have.property('authorization');
    should(headers.authorization).match(/\s*[Bb]earer\s+/);

    const rawJwt = headers['authorization'].replace(/\s*[Bb]earer\s+/, "");
    const jwtComponents = rawJwt.split(".");
    should(jwtComponents.length).equal(3);

    const jwtHeader = JSON.parse(Buffer.from(jwtComponents[0], 'base64url').toString());
    const jwtPayload = JSON.parse(Buffer.from(jwtComponents[1], 'base64url').toString());

    jwtHeader.alg.should.equal("ES256");
    jwtHeader.typ.should.equal("JWT");
    jwtHeader.kid.should.equal("fake_apns_key_id");
    jwtPayload.iss.should.equal("fake_12345");
  });

});
