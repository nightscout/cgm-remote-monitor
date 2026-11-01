'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const http2 = require('node:http2');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {generateKeyPairSync} = require('node:crypto');
const {setTimeout: delay} = require('node:timers/promises');
const apn = require('@parse/node-apn');
const jwt = require('jsonwebtoken');

// Exercise the real public Provider/Notification against an owned TLS endpoint.
// Only provider configuration is redirected; no production APNs connection is made.
describe('Loop APNs HTTP/2 transport', function () {
  this.timeout(20000);
  let directory, server, loop, sessions, requests, clients, reply, publicKey;
  let trustFixture = true;
  const device = 'a'.repeat(64);

  before(async function () {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nightscout-apn-tls-'));
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
      '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem'),
      '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], {timeout: 10000});
    const cert = await fs.readFile(path.join(directory, 'cert.pem'));
    server = http2.createSecureServer({cert, key: await fs.readFile(path.join(directory, 'key.pem'))});
    sessions = new Set(); requests = []; clients = [];
    server.on('session', session => {
      sessions.add(session);
      session.on('error', () => {});
      session.on('close', () => sessions.delete(session));
    });
    server.on('stream', (stream, headers) => {
      stream.on('error', () => {});
      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', chunk => { body += chunk; });
      stream.on('end', () => {
        requests.push({headers, body: JSON.parse(body)});
        const response = reply(requests.length);
        stream.respond({':status': response.status, 'apns-id': 'owned-apn-id'});
        stream.end(response.reason ? JSON.stringify({reason: response.reason}) : '');
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const keys = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
    publicKey = keys.publicKey;
    const sandbox = {module: {exports: {}}, console: {log() {}, error() {}}, require(name) {
      assert.equal(name, '@parse/node-apn');
      return {...apn, Provider: function (options) {
        const provider = new apn.Provider({...options, address: '127.0.0.1', port: server.address().port,
          ca: trustFixture ? cert : undefined, rejectUnauthorized: true, connectionRetryLimit: 1, requestTimeout: 1000});
        clients.push(provider.client);
        return provider;
      }};
    }};
    vm.runInNewContext(await fs.readFile(path.join(__dirname, '../lib/server/loop.js'), 'utf8'), sandbox);
    loop = sandbox.module.exports({extendedSettings: {loop: {
      apnsKey: keys.privateKey.export({type: 'pkcs8', format: 'pem'}), apnsKeyId: 'OWNEDKEY01', developerTeamId: 'TEAMID1234'
    }}}, {ddata: {profiles: [{isAPNSProduction: false, loopSettings: {deviceToken: device, bundleIdentifier: 'org.example.loop'}}]}});
  });

  after(async function () {
    for (const client of clients || []) client.shutdown();
    for (const session of sessions || []) session.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    if (directory) await fs.rm(directory, {recursive: true, force: true});
  });

  async function send(data) {
    let callbacks = 0;
    const result = await new Promise(resolve => loop.sendNotification(data, '127.0.0.1', error => {
      callbacks++; resolve(error);
    }));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (sessions.size || !clients.at(-1).isDestroyed)) await delay(10);
    assert.equal(callbacks, 1);
    assert.equal(sessions.size, 0, 'Provider must close its HTTP/2 session after completion');
    assert.equal(clients.at(-1).isDestroyed, true);
    assert.equal(clients.at(-1).healthCheckInterval, null);
    assert.equal(clients.at(-1).manageChannelsHealthCheckInterval, null);
    return result;
  }

  it('preserves signed requests, therapy payloads and teardown over two cycles', async function () {
    reply = () => ({status: 200});
    const cases = [
      [{eventType: 'Temporary Override Cancel'}, {'cancel-temporary-override': 'true'}],
      [{eventType: 'Temporary Override', reason: 'exercise', reasonDisplay: 'Exercise', duration: 30}, {'override-name': 'exercise', 'override-duration-minutes': 30}],
      [{eventType: 'Remote Carbs Entry', remoteCarbs: 15, remoteAbsorption: 2, otp: 'fixture', created_at: '2026-01-01T12:00:00Z'}, {'carbs-entry': 15, 'absorption-time': 2, otp: 'fixture', 'start-time': '2026-01-01T12:00:00Z'}],
      [{eventType: 'Remote Bolus Entry', remoteBolus: 0.5, otp: 'fixture'}, {'bolus-entry': 0.5, otp: 'fixture'}]
    ];
    for (let cycle = 0; cycle < 2; cycle++) for (const [data, expected] of cases) {
      const count = requests.length;
      assert.equal(await send({...data, notes: 'owned note', enteredBy: 'owned user'}), undefined);
      assert.equal(requests.length, count + 1);
      const {headers, body} = requests.at(-1);
      assert.equal(headers[':method'], 'POST');
      assert.equal(headers[':path'], '/3/device/' + device);
      assert.equal(headers['apns-topic'], 'org.example.loop');
      assert.equal(headers['apns-priority'], '10');
      // Loop has historically left push-type unspecified; retain that wire contract.
      assert.equal(headers['apns-push-type'], undefined);
      const token = headers.authorization.replace(/^bearer /, '');
      const decoded = jwt.verify(token, publicKey, {algorithms: ['ES256'], issuer: 'TEAMID1234', complete: true});
      assert.equal(decoded.header.kid, 'OWNEDKEY01');
      assert.equal(body.aps['content-available'], 1);
      assert.equal(body.aps['interruption-level'], 'time-sensitive');
      assert.equal(body.notes, 'owned note');
      assert.equal(body['entered-by'], 'owned user');
      assert.equal(body['remote-address'], '127.0.0.1');
      assert.equal(Date.parse(body.expiration) - Date.parse(body['sent-at']), 300000);
      for (const [key, value] of Object.entries(expected)) assert.equal(body[key], value);
    }
  });

  it('rejects an untrusted server certificate without sending a notification', async function () {
    trustFixture = false;
    reply = () => ({status: 200});
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        const count = requests.length;
        assert.match(await send({eventType: 'Temporary Override Cancel'}), /^APNs delivery failed:/);
        assert.equal(requests.length, count);
      }
    } finally { trustFixture = true; }
  });

  it('reports rejected tokens and retries transient failure without changing the payload', async function () {
    for (let cycle = 0; cycle < 2; cycle++) {
      reply = () => ({status: 400, reason: 'BadDeviceToken'});
      const count = requests.length;
      assert.equal(await send({eventType: 'Temporary Override Cancel'}), 'APNs delivery failed: BadDeviceToken');
      assert.equal(requests.length, count + 1);
      let attempts = 0;
      reply = () => ++attempts === 1 ? {status: 503, reason: 'ServiceUnavailable'} : {status: 200};
      assert.equal(await send({eventType: 'Temporary Override Cancel'}), undefined);
      assert.equal(attempts, 2);
      assert.deepEqual(requests.at(-1).body, requests.at(-2).body);
      attempts = 0;
      reply = () => { attempts++; return {status: 503, reason: 'ServiceUnavailable'}; };
      assert.equal(await send({eventType: 'Temporary Override Cancel'}), 'APNs delivery failed: ServiceUnavailable');
      assert.equal(attempts, 2, 'Provider must stop after its configured retry limit');
    }
  });
});
