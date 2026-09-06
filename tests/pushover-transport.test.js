'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const vm = require('node:vm');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {setTimeout: delay} = require('node:timers/promises');

describe('Native Pushover HTTPS transport', function () {
  this.timeout(20000);
  let directory, server, Client, cert, sockets, received, handler;
  let trust = true, fastTimeout = false;
  const token = 'owned-token-never-log';

  before(async function () {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nightscout-pushover-tls-'));
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
      '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem'),
      '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], {timeout: 10000});
    cert = await fs.readFile(path.join(directory, 'cert.pem'));
    sockets = new Set(); received = [];
    server = https.createServer({cert, key: await fs.readFile(path.join(directory, 'key.pem'))}, (req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { received.push({method: req.method, url: req.url, headers: req.headers, body}); handler(req, res); });
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const sandbox = {module: {exports: {}}, URLSearchParams, Buffer, queueMicrotask, clearTimeout,
      setTimeout(fn, ms) { return setTimeout(fn, fastTimeout ? 80 : ms); },
      require(name) {
        assert.equal(name, 'node:https');
        return {request(options, callback) {
          assert.equal(options.hostname, 'api.pushover.net');
          assert.equal(options.port, 443);
          assert.equal(options.rejectUnauthorized, true);
          assert.equal(options.method, 'POST');
          // Redirect only inside the fixture and keep certificate verification.
          return https.request({...options, hostname: '127.0.0.1', port: server.address().port,
            ca: trust ? cert : undefined, agent: false}, callback);
        }};
      }
    };
    vm.runInNewContext(await fs.readFile(path.join(__dirname, '../lib/server/pushover-client.js'), 'utf8'), sandbox);
    Client = sandbox.module.exports;
  });

  after(async function () {
    for (const socket of sockets || []) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    if (directory) await fs.rm(directory, {recursive: true, force: true});
  });

  async function invoke(client, method, value) {
    let calls = 0;
    const result = await new Promise(resolve => client[method](value, (error, result) => { calls++; resolve({error, result}); }));
    const deadline = Date.now() + 2000;
    while (sockets.size && Date.now() < deadline) await delay(10);
    assert.equal(sockets.size, 0, 'Owned request socket must be released');
    await delay(10);
    assert.equal(calls, 1, 'Completion must be called exactly once');
    if (result.error) assert.ok(!String(result.error.stack).includes(token), 'Do not expose credentials through errors');
    return result;
  }

  it('encodes independent messages and cancels receipts with a body token over two cycles', async function () {
    handler = (req, res) => { res.writeHead(200); res.end('{"status":1,"receipt":"owned-receipt"}'); };
    const client = new Client({token});
    for (let cycle = 0; cycle < 2; cycle++) {
      const message = {user: 'user a&b', title: 'BG < 70 & 🍕', message: 'one\ntwo + three', priority: 2,
        retry: 120, expire: 900, callback: 'https://nightscout.test/callback?a=b&c=d', timestamp: 1700000000, sound: 'gamelan'};
      const before = {...message};
      const results = await Promise.all([invoke(client, 'send', message), invoke(client, 'send', {...message, user: 'second-user'})]);
      for (const result of results) { assert.ifError(result.error); assert.equal(result.result, '{"status":1,"receipt":"owned-receipt"}'); }
      assert.deepEqual(message, before, 'Do not mutate the shared message object');
      const requests = received.slice(-2);
      assert.deepEqual(requests.map(r => new URLSearchParams(r.body).get('user')).sort(), ['second-user', 'user a&b']);
      for (const request of requests) {
        assert.equal(request.url, '/1/messages.json');
        assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded');
        assert.equal(Number(request.headers['content-length']), Buffer.byteLength(request.body));
        const form = new URLSearchParams(request.body);
        assert.equal(form.get('token'), token);
        for (const [key, value] of Object.entries(message)) if (key !== 'user') assert.equal(form.get(key), String(value));
      }
      const cancelled = await invoke(client, 'cancel', 'receipt/with?reserved');
      assert.ifError(cancelled.error);
      assert.equal(cancelled.result.statusCode, 200);
      assert.equal(received.at(-1).url, '/1/receipts/receipt%2Fwith%3Freserved/cancel.json');
      assert.equal(received.at(-1).body, new URLSearchParams({token}).toString());
      assert.ok(!received.at(-1).url.includes(token));
    }
  });

  it('preserves actual plugin routing, alarm parameters and Unix timestamps', async function () {
    const levels = require('../lib/levels');
    const sandbox = {module: {exports: {}}, console: {info() {}, error() {}}, require(name) {
      if (name === '../server/pushover-client') return Client;
      assert.equal(name, '../times');
      return require('../lib/times');
    }};
    vm.runInNewContext(await fs.readFile(path.join(__dirname, '../lib/plugins/pushover.js'), 'utf8'), sandbox);
    const plugin = sandbox.module.exports({settings: {baseURL: 'https://nightscout.test'}, extendedSettings: {pushover: {
      apiToken: token, userKey: 'normal-a normal-b', alarmKey: 'alarm', announcementKey: 'announcement'
    }}}, {levels});
    handler = (req, res) => res.end('{"status":1,"receipt":"owned-receipt"}');
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const [notify, recipients] of [
        [{level: levels.INFO}, ['normal-a', 'normal-b']],
        [{level: levels.URGENT}, ['alarm']],
        [{level: levels.INFO, isAnnouncement: true}, ['announcement']]
      ]) {
        const count = received.length;
        let completed = 0;
        await new Promise((resolve, reject) => plugin.send({...notify, title: 'Fixture', message: 'Fixture message'}, (error, text) => {
          if (error) return reject(error);
          assert.equal(JSON.parse(text).receipt, 'owned-receipt');
          if (++completed === recipients.length) resolve();
        }));
        const requests = received.slice(count).map(request => new URLSearchParams(request.body));
        assert.deepEqual(requests.map(form => form.get('user')).sort(), recipients.slice().sort());
        for (const form of requests) {
          assert.equal(form.get('sound'), 'gamelan');
          assert.equal(form.get('expire'), '900');
          const timestamp = Number(form.get('timestamp'));
          assert.ok(Number.isInteger(timestamp) && Math.abs(Date.now() / 1000 - timestamp) < 10);
          if (notify.level === levels.URGENT) {
            assert.equal(form.get('priority'), '2');
            assert.equal(form.get('retry'), '120');
            assert.equal(form.get('callback'), 'https://nightscout.test/api/v1/notifications/pushovercallback');
          } else assert.equal(form.get('priority'), '0');
        }
      }
    }
  });

  const failures = [
    ['HTTP rejection', (req, res) => { res.writeHead(400); res.end('{"status":0}'); }, 'EPUSHOVER_HTTP'],
    ['rate limit', (req, res) => { res.writeHead(429); res.end('{"status":0}'); }, 'EPUSHOVER_HTTP'],
    ['server failure', (req, res) => { res.writeHead(503); res.end('{"status":0}'); }, 'EPUSHOVER_HTTP'],
    ['redirect', (req, res) => { res.writeHead(302, {location: 'https://example.invalid'}); res.end(); }, 'EPUSHOVER_HTTP'],
    ['API rejection', (req, res) => res.end('{"status":0,"errors":["' + token + '"]}'), 'EPUSHOVER_API'],
    ['invalid JSON', (req, res) => res.end('not-json ' + token), 'EPUSHOVER_JSON'],
    ['oversized response', (req, res) => res.end('x'.repeat(65537)), 'EPUSHOVER_SIZE'],
    ['truncated response', (req, res) => { res.writeHead(200, {'content-length': 100}); res.write('{'); res.flushHeaders(); setImmediate(() => res.destroy()); }, 'EPUSHOVER_TRANSPORT'],
    ['timeout', () => {}, 'EPUSHOVER_TIMEOUT']
  ];
  for (const [name, respond, code] of failures) it('reports ' + name + ' once without retrying', async function () {
    handler = respond; fastTimeout = name === 'timeout';
    try {
      const client = new Client({token});
      for (const method of ['send', 'cancel']) {
        const count = received.length;
        const result = await invoke(client, method, method === 'send' ? {user: 'fixture', message: 'fixture'} : 'fixture');
        assert.equal(result.error.code, code);
        assert.equal(received.length, count + 1);
      }
    } finally { fastTimeout = false; }
  });

  it('rejects an untrusted certificate without sending credentials', async function () {
    trust = false;
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        const count = received.length;
        const result = await invoke(new Client({token}), 'send', {user: 'fixture', message: 'fixture'});
        assert.equal(result.error.code, 'EPUSHOVER_TRANSPORT');
        assert.equal(received.length, count);
      }
    } finally { trust = true; }
  });
});
