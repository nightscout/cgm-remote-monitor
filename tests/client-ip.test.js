'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const express = require('express');
const { Server } = require('socket.io');
const connect = require('socket.io-client');
const { compileTrust, getClientIP, createClientIP } = require('../lib/server/client-ip');

function raw (peer, headers = {}) { return { socket: { remoteAddress: peer }, headers }; }

function appFor (trustProxy) {
  const app = express();
  require('../lib/middleware/configure-request')(app);
  const trust = compileTrust(trustProxy);
  app.set('trust proxy', trust);
  app.get('/', (req, res) => res.json({ ip: getClientIP(req, trust), expressIP: req.ip, secure: req.secure, hostname: req.hostname }));
  return app;
}

describe('explicit trusted proxies', function () {
  it('ignores every forwarding header for direct peers, independently of request history', function () {
    const resolve = createClientIP();
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const headers of [
        { 'fastly-client-ip': '192.0.2.1', 'x-real-ip': '192.0.2.2' },
        { 'x-real-ip': '192.0.2.2' },
        { 'x-forwarded-for': '198.51.100.77', forwarded: 'for=198.51.100.88', 'z-forwarded-for': '192.0.2.3' }
      ]) assert.equal(resolve(raw('203.0.113.10', headers)), '203.0.113.10');
    }
  });

  it('walks trusted hops from right to left and stops at the first untrusted address', function () {
    const resolve = createClientIP('10.1.0.0/16,2001:db8:1::/48');
    assert.equal(resolve(raw('10.1.0.2', { 'x-forwarded-for': '192.0.2.99, 198.51.100.4, 10.1.0.3' })), '198.51.100.4');
    assert.equal(resolve(raw('10.2.0.2', { 'x-forwarded-for': '198.51.100.4' })), '10.2.0.2');
    assert.equal(resolve(raw('::ffff:10.1.0.2', { 'x-forwarded-for': '2001:db8:2::4, 2001:db8:1::3' })), '2001:db8:2::4');
    assert.equal(resolve(raw('2001:db8:1::2', { 'x-forwarded-for': '2001:db8:2::4' })), '2001:db8:2::4');
  });

  it('ignores alternate headers even for trusted peers', function () {
    const resolve = createClientIP('10.1.0.2');
    for (let cycle = 0; cycle < 2; cycle++) {
      assert.equal(resolve(raw('10.1.0.2', { 'x-real-ip': '192.0.2.1' })), '10.1.0.2');
      assert.equal(resolve(raw('10.1.0.2', { 'x-real-ip': '192.0.2.1', 'fastly-client-ip': '192.0.2.2', 'x-forwarded-for': '198.51.100.4' })), '198.51.100.4');
    }
  });

  it('falls back to the peer for malformed or port-bearing addresses', function () {
    const resolve = createClientIP('10.1.0.2');
    for (const value of ['unknown', '198.51.100.4:1234', '[2001:db8::4]:1234', '"198.51.100.4"']) {
      assert.equal(resolve(raw('10.1.0.2', { 'x-forwarded-for': value })), '10.1.0.2');
    }
  });

  it('rejects permissive shortcuts and invalid configuration', function () {
    for (const value of [true, false, 1, 'true', 'false', '1', 'loopback', '*', '10.0.0.1,', '10.0.0.0/33', '::1/129']) {
      assert.throws(() => compileTrust(value));
    }
  });

  it('keeps policies isolated between application instances', function () {
    const trusted = createClientIP('10.1.0.2');
    const direct = createClientIP();
    const req = raw('10.1.0.2', { 'x-forwarded-for': '198.51.100.4' });
    assert.equal(trusted(req), '198.51.100.4');
    assert.equal(direct(req), '10.1.0.2');
    assert.equal(trusted(req), '198.51.100.4');
  });

  it('uses the same explicit trust for HTTP IP, hostname and TLS metadata', async function () {
    for (const trusted of [false, true]) {
      const res = await request(appFor(trusted ? '127.0.0.1,::1' : undefined)).get('/')
        .set('Host', 'direct.example').set('X-Forwarded-For', '198.51.100.4')
        .set('X-Forwarded-Host', 'edge.example').set('X-Forwarded-Proto', 'https').expect(200);
      assert.equal(res.body.ip, res.body.expressIP);
      assert.equal(res.body.ip === '198.51.100.4', trusted);
      assert.equal(res.body.secure, trusted);
      assert.equal(res.body.hostname, trusted ? 'edge.example' : 'direct.example');
    }
  });

  it('prevents spoofed IPs from escaping the authentication delay list', function () {
    const resolve = createClientIP();
    const delay = require('../lib/authorization/delaylist')({settings: {authFailDelay: 10000}});
    delay.addFailedRequest(resolve(raw('203.0.113.10', { 'x-forwarded-for': '192.0.2.1' })));
    assert.ok(delay.shouldDelayRequest(resolve(raw('203.0.113.10', { 'x-forwarded-for': '192.0.2.2' }))) > 0);
    assert.equal(delay.shouldDelayRequest('203.0.113.11'), false);
    delay.requestSucceeded(resolve(raw('203.0.113.10')));
    assert.equal(delay.shouldDelayRequest('203.0.113.10'), false);
  });

  for (const transport of ['polling', 'websocket']) {
    it('applies the policy to raw Socket.IO ' + transport + ' handshakes over two lifecycles', async function () {
      for (const trusted of [false, true]) {
        const server = http.createServer();
        const io = new Server(server);
        const resolve = createClientIP(trusted ? '127.0.0.1,::1' : undefined);
        io.on('connection', socket => socket.emit('client-address', resolve(socket.request)));
        await new Promise(done => server.listen(0, '127.0.0.1', done));
        try {
          for (let cycle = 0; cycle < 2; cycle++) {
            const client = connect('http://127.0.0.1:' + server.address().port, {
              transports: [transport], reconnection: false, forceNew: true,
              extraHeaders: { 'X-Forwarded-For': '198.51.100.4' }
            });
            try {
              const address = await new Promise((resolve, reject) => {
                client.once('client-address', resolve);
                client.once('connect_error', reject);
              });
              assert.equal(address, trusted ? '198.51.100.4' : '127.0.0.1');
            } finally { client.disconnect(); }
          }
        } finally { await new Promise(done => io.close(done)); }
      }
    });
  }

  it('passes the configured client IP to API v3 authentication', async function () {
    const security = require('../lib/api3/security');
    for (const trusted of [false, true]) {
      const app = appFor(trusted ? '10.1.0.2' : undefined);
      app.set('API3_SECURITY_ENABLE', true);
      const req = raw('10.1.0.2', { 'x-forwarded-for': '198.51.100.4' });
      req.header = name => name === 'Authorization' ? 'Bearer owned-test-token' : undefined;
      let observed;
      const ctx = { authorization: { resolve(data, callback) { observed = data; callback(null, {shiros: []}); } } };
      await security.authenticate({app, ctx, req, res: {}});
      assert.equal(observed.ip, trusted ? '198.51.100.4' : '10.1.0.2');
      assert.equal(observed.token, 'owned-test-token');
    }
  });

  it('passes the configured client IP to HTTP authorization', function () {
    const init = require('../lib/authorization');
    for (const trusted of [false, true]) {
      const env = { trustProxy: trusted ? '10.1.0.2' : '', settings: {} };
      const ctx = { store: {collection() { return {}; }}, language: {translate: text => text} };
      const authorization = init(env, ctx);
      let observed;
      authorization.resolve = data => { observed = data; };
      const req = raw('10.1.0.2', { 'x-forwarded-for': '198.51.100.4' });
      req.header = () => undefined;
      req.query = {};
      authorization.resolveWithRequest(req, () => {});
      assert.equal(observed.ip, trusted ? '198.51.100.4' : '10.1.0.2');
    }
  });

  it('enforces the actual Nightscout HTTPS redirect against untrusted headers', async function () {
    const createApp = require('../lib/server/app');
    for (const trusted of [false, true]) {
      const env = { name: 'proxy-test', version: '1', trustProxy: trusted ? '127.0.0.1,::1' : '',
        insecureUseHttp: false, secureHstsHeader: false, static_files: '/static', settings: require('../lib/settings')() };
      const app = createApp(env, { bootErrors: [{ desc: 'test', err: 'test' }] });
      await request(app).get('/robots.txt').set('X-Forwarded-Proto', 'https').expect(trusted ? 200 : 307);
      await request(app).get('/robots.txt').expect(307);
    }
  });
});
