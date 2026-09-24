'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const express = require('express');
const { Server } = require('socket.io');
const connect = require('socket.io-client');
const { compileTrust, getClientIP, createClientIP } = require('../lib/server/client-ip');

function raw (peer, headers = {}) { return { socket: { remoteAddress: peer }, headers }; }

// bf2/auth-hardening: with TRUST_PROXY unset the client address comes from
// forwarded-for, exactly as on dev, and forwarded-for keeps module-level state:
// it moves whichever header family last matched to the front of its search
// order. Tests that assert the default reset that order to the package's
// initial one first, which is what a freshly started Nightscout has.
const forwardedFor = require('forwarded-for');
const INITIAL_ORDER = ['fastly-client-ip', 'x-forwarded-for', 'z-forwarded-for', 'forwarded', 'x-real-ip'];
function freshProcessOrder () {
  forwardedFor.proxies.sort((a, b) => INITIAL_ORDER.indexOf(a.ip) - INITIAL_ORDER.indexOf(b.ip));
}

function appFor (trustProxy) {
  const app = express();
  const trust = compileTrust(trustProxy);
  app.set('trust proxy', trust);
  app.get('/', (req, res) => res.json({ ip: getClientIP(req, trust), expressIP: req.ip, secure: req.secure, hostname: req.hostname }));
  return app;
}

describe('explicit trusted proxies', function () {
  it('ignores every forwarding header for direct peers, independently of request history', function () {
    const resolve = createClientIP('false');
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

  // CHANGED FROM THE CHERRY-PICKED TEST (395f3207), AND WHY: it asserted that
  // `198.51.100.4:1234` and `[2001:db8::4]:1234` fall back to the peer. Azure
  // App Service writes every X-Forwarded-For entry with a port, so under that
  // rule no explicit TRUST_PROXY value worked there: every visitor resolved to
  // the front end's address and shared one failed-login delay. A numeric port
  // on a valid address is now removed; the other malformed values below still
  // fall back to the peer, as before.
  it('removes a numeric port from a forwarded address', function () {
    const resolve = createClientIP('10.1.0.2');
    for (const [value, expected] of [
      ['198.51.100.4:1234', '198.51.100.4'],
      ['[2001:db8::4]:1234', '2001:db8::4'],
      ['[2001:db8::4]', '2001:db8::4']
    ]) {
      assert.equal(resolve(raw('10.1.0.2', { 'x-forwarded-for': value })), expected);
    }
  });

  it('resolves an Azure-style chain, where the front end adds client:port, with a hop count', function () {
    const resolve = createClientIP('1');
    assert.equal(resolve(raw('10.1.0.2', { 'x-forwarded-for': '192.0.2.99, 198.51.100.4:51234' })), '198.51.100.4');
    assert.equal(resolve(raw('10.1.0.2', { 'x-forwarded-for': '198.51.100.4:51234' })), '198.51.100.4');
  });

  it('falls back to the peer for malformed addresses', function () {
    const resolve = createClientIP('10.1.0.2');
    for (const value of ['unknown', '"198.51.100.4"', '198.51.100.4:abc', '198.51.100.4:1234567', '[not-an-ip]:443']) {
      assert.equal(resolve(raw('10.1.0.2', { 'x-forwarded-for': value })), '10.1.0.2');
    }
  });

  it('rejects permissive shortcuts and invalid configuration', function () {
    for (const value of ['loopback', '*', '10.0.0.1,', '10.0.0.0/33', '::1/129']) {
      assert.throws(() => compileTrust(value));
    }
  });

  it('keeps policies isolated between application instances', function () {
    const trusted = createClientIP('10.1.0.2');
    const direct = createClientIP('false');
    const req = raw('10.1.0.2', { 'x-forwarded-for': '198.51.100.4' });
    assert.equal(trusted(req), '198.51.100.4');
    assert.equal(direct(req), '10.1.0.2');
    assert.equal(trusted(req), '198.51.100.4');
  });

  it('uses the same explicit trust for HTTP IP, hostname and TLS metadata', async function () {
    for (const trusted of [false, true]) {
      const res = await request(appFor(trusted ? '127.0.0.1,::1' : 'false')).get('/')
        .set('Host', 'direct.example').set('X-Forwarded-For', '198.51.100.4')
        .set('X-Forwarded-Host', 'edge.example').set('X-Forwarded-Proto', 'https').expect(200);
      assert.equal(res.body.ip, res.body.expressIP);
      assert.equal(res.body.ip === '198.51.100.4', trusted);
      assert.equal(res.body.secure, trusted);
      assert.equal(res.body.hostname, trusted ? 'edge.example' : 'direct.example');
    }
  });

  // CHANGED FROM THE CHERRY-PICKED TEST (395f3207), AND WHY: bf/throttle
  // (merged into this branch before the backport) changed the delay list's
  // interface from a bare address string to the keys returned by keysFor(). The
  // modernization version of this test hands the list raw address strings,
  // which the new list ignores, so it failed here. Only the calls are adapted
  // (addr = the key keysFor() derives from the resolved address); every
  // expectation is the one 395f3207 asserts.
  it('prevents spoofed IPs from escaping the authentication delay list', function () {
    const resolve = createClientIP('false');
    const delay = require('../lib/authorization/delaylist')({settings: {authFailDelay: 10000}});
    const addr = ip => delay.keysFor({ ip });
    delay.addFailedRequest(addr(resolve(raw('203.0.113.10', { 'x-forwarded-for': '192.0.2.1' }))));
    assert.ok(delay.shouldDelayRequest(addr(resolve(raw('203.0.113.10', { 'x-forwarded-for': '192.0.2.2' })))) > 0);
    assert.equal(delay.shouldDelayRequest(addr('203.0.113.11')), false);
    delay.requestSucceeded(addr(resolve(raw('203.0.113.10'))));
    assert.equal(delay.shouldDelayRequest(addr('203.0.113.10')), false);
  });

  for (const transport of ['polling', 'websocket']) {
    it('applies the policy to raw Socket.IO ' + transport + ' handshakes over two lifecycles', async function () {
      for (const trusted of [false, true]) {
        const server = http.createServer();
        const io = new Server(server);
        const resolve = createClientIP(trusted ? '127.0.0.1,::1' : 'false');
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
      const app = appFor(trusted ? '10.1.0.2' : 'false');
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
      const env = { trustProxy: trusted ? '10.1.0.2' : 'false', settings: {} };
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
      const env = { name: 'proxy-test', version: '1', trustProxy: trusted ? '127.0.0.1,::1' : 'false',
        insecureUseHttp: false, secureHstsHeader: false, static_files: '/static', settings: require('../lib/settings')() };
      const app = createApp(env, { bootErrors: [{ desc: 'test', err: 'test' }] });
      await request(app).get('/robots.txt').set('X-Forwarded-Proto', 'https').expect(trusted ? 200 : 307);
      await request(app).get('/robots.txt').expect(307);
    }
  });
});

describe('proxy compatibility default', function () {
  // !!! EXPECTATIONS CHANGED FROM THE CHERRY-PICKED TEST (395f3207) !!!
  //
  // 395f3207 asserts its own fixed-precedence reimplementation of the legacy
  // header handling. This branch keeps dev's actual behaviour instead (see the
  // BACKPORT DIFFERENCE note in lib/server/client-ip.js), so two expectations
  // are changed to what dev 74fc6619 returns, and each assertion now starts
  // from a freshly started process's header order:
  //   1. 'x-real-ip' + 'x-forwarded-for': 395f3207 expects x-forwarded-for on
  //      every cycle. Dev returns x-forwarded-for only while no earlier request
  //      has matched x-real-ip alone; after one has, dev returns x-real-ip.
  //      Pinned separately below, as history dependence.
  //   2. peer '::1', 'x-forwarded-for: 2001:db8::4, ::1': 395f3207 expects
  //      2001:db8::4. Dev rejects the chain (the space before the second IPv6
  //      entry defeats forwarded-for's IPv6 check) and returns the peer, '::1'.
  // Every other expectation is 395f3207's, unchanged.
  it('retains validated legacy client headers (dev precedence, from a fresh process)', function () {
    for (const setting of [undefined, null, '', '   ']) {
      const resolve = createClientIP(setting);
      const fresh = req => { freshProcessOrder(); return resolve(req); };
      for (let cycle = 0; cycle < 2; cycle++) {
        assert.equal(fresh(raw('10.1.0.2', {'x-real-ip': '198.51.100.4'})), '198.51.100.4');
        assert.equal(fresh(raw('10.1.0.3', {'x-real-ip': '198.51.100.4', 'x-forwarded-for': '198.51.100.5, 10.1.0.2'})), '198.51.100.5');
        assert.equal(fresh(raw('10.1.0.3', {'fastly-client-ip': '198.51.100.6', 'x-forwarded-for': '198.51.100.5'})), '198.51.100.6');
        for (const header of ['z-forwarded-for', 'forwarded']) {
          assert.equal(fresh(raw('10.1.0.2', {[header]: '198.51.100.7'})), '198.51.100.7');
        }
        assert.equal(fresh(raw('10.1.0.2', {'x-forwarded-for': '198.51.100.4:443, 10.1.0.3:1234'})), '198.51.100.4');
        assert.equal(fresh(raw('::1', {'x-forwarded-for': '2001:db8::4, ::1'})), '::1'); // CHANGED: 395f3207 expects '2001:db8::4'
        for (const value of ['unknown', '198.51.100.4, unknown', 'for=198.51.100.4', '']) {
          assert.equal(fresh(raw('10.1.0.2', {'x-forwarded-for': value, 'x-real-ip': '198.51.100.9'})), '10.1.0.2');
        }
        assert.equal(fresh(raw('10.1.0.2')), '10.1.0.2');
      }
    }
    freshProcessOrder();
  });

  for (const setting of [undefined, '', 'false', '127.0.0.1,::1']) {
    const enabled = setting !== 'false';
    it('handles HTTPS, client identity and changing ingress peers with setting ' + JSON.stringify(setting), async function () {
      const createApp = require('../lib/server/app');
      const env = {name: 'proxy-compatibility-test', version: '1', trustProxy: setting,
        insecureUseHttp: false, secureHstsHeader: false, static_files: '/static', settings: require('../lib/settings')()};
      const app = createApp(env, {bootErrors: [{desc: 'test', err: 'test'}]});
      await request(app).get('/robots.txt').set('X-Forwarded-Proto', 'https').expect(enabled ? 200 : 307);
      await request(app).get('/robots.txt').expect(307);
      const metadata = await request(appFor(setting)).get('/').set('X-Forwarded-Proto', 'https')
        .set('X-Forwarded-Host', 'edge.example').set('X-Forwarded-For', '198.51.100.4, 127.0.0.1').expect(200);
      assert.equal(metadata.body.secure, enabled);
      assert.equal(metadata.body.ip === '198.51.100.4', enabled);
      assert.equal(metadata.body.hostname === 'edge.example', enabled);
      if (setting === undefined || setting === '') {
        const resolve = createClientIP(setting);
        for (const peer of ['10.1.0.2', '10.1.0.3', '10.1.0.4']) {
          assert.equal(resolve(raw(peer, {'x-forwarded-for': '198.51.100.4, 10.1.0.5'})), '198.51.100.4');
        }
      }
    });
  }

  // CHANGED FROM THE CHERRY-PICKED TEST (395f3207): calls adapted to
  // bf/throttle's keysFor() interface, as above; expectations unchanged.
  it('keeps different clients on independent authentication delay keys by default', function () {
    const resolve = createClientIP();
    const delay = require('../lib/authorization/delaylist')({settings: {authFailDelay: 10000}});
    const first = delay.keysFor({ ip: resolve(raw('10.1.0.2', {'x-forwarded-for': '198.51.100.4'})) });
    const second = delay.keysFor({ ip: resolve(raw('10.1.0.2', {'x-forwarded-for': '198.51.100.5'})) });
    delay.addFailedRequest(first);
    assert.ok(delay.shouldDelayRequest(first) > 0);
    assert.equal(delay.shouldDelayRequest(second), false);
    delay.requestSucceeded(first);
  });

  for (const transport of ['polling', 'websocket']) {
    it('retains the original client on default raw Socket.IO ' + transport + ' connections', async function () {
      const server = http.createServer();
      const io = new Server(server);
      const resolve = createClientIP();
      io.on('connection', socket => socket.emit('client-address', resolve(socket.request)));
      await new Promise(done => server.listen(0, '127.0.0.1', done));
      try {
        for (let cycle = 0; cycle < 2; cycle++) {
          const client = connect('http://127.0.0.1:' + server.address().port, {
            transports: [transport], reconnection: false, forceNew: true,
            extraHeaders: {'X-Forwarded-For': '198.51.100.4, 10.1.0.2'}
          });
          try {
            const address = await new Promise((resolve, reject) => {
              client.once('client-address', resolve);
              client.once('connect_error', reject);
            });
            assert.equal(address, '198.51.100.4');
          } finally {client.disconnect();}
        }
      } finally {await new Promise(done => io.close(done));}
    });
  }

  it('passes default client identity through HTTP and API3 authorization', async function () {
    const req = raw('10.1.0.2', {'x-forwarded-for': '198.51.100.4'});
    req.header = () => undefined;
    req.query = {};
    const authorization = require('../lib/authorization')({settings: {}}, {
      store: {collection() {return {};}}, language: {translate: text => text}
    });
    let observed;
    authorization.resolve = data => {observed = data;};
    authorization.resolveWithRequest(req, () => {});
    assert.equal(observed.ip, '198.51.100.4');
    const app = appFor();
    app.set('API3_SECURITY_ENABLE', true);
    req.header = name => name === 'Authorization' ? 'Bearer owned-test-token' : undefined;
    const ctx = {authorization: {resolve(data, callback) {observed = data; callback(null, {shiros: []});}}};
    await require('../lib/api3/security').authenticate({app, ctx, req, res: {}});
    assert.equal(observed.ip, '198.51.100.4');
  });
});

// bf2/auth-hardening. THE COMPATIBILITY DEFAULT, PINNED. With TRUST_PROXY unset
// the client address and the HTTPS decision must be what origin/dev 74fc6619
// gives today. Every expected value below was measured on that commit by
// running dev's own resolver (forwarded-for) and dev's lib/server/app.js; none
// is derived from reading. Flipping the default (e.g. unset -> trust nothing)
// or reverting to 395f3207's reimplementation fails these.
describe('dev behaviour with TRUST_PROXY unset', function () {
  beforeEach(freshProcessOrder);
  after(freshProcessOrder);

  function unsetResolver () {
    const saved = { TRUST_PROXY: process.env.TRUST_PROXY, CUSTOMCONNSTR_TRUST_PROXY: process.env.CUSTOMCONNSTR_TRUST_PROXY };
    try {
      delete process.env.TRUST_PROXY;
      delete process.env.CUSTOMCONNSTR_TRUST_PROXY;
      return createClientIP(require('../lib/server/env')().trustProxy);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  }

  // [description, socket peer, headers, what dev 74fc6619 returns]
  const MEASURED = [
    ['no proxy: no forwarding header', '10.0.0.1', {}, '10.0.0.1'],
    ['one proxy: X-Forwarded-For client', '10.0.0.1', {'x-forwarded-for': '198.51.100.4'}, '198.51.100.4'],
    ['two proxies: client, proxy', '10.0.0.1', {'x-forwarded-for': '198.51.100.4, 10.0.0.2'}, '198.51.100.4'],
    ['three hops', '10.0.0.1', {'x-forwarded-for': '198.51.100.4, 10.0.0.3, 10.0.0.2'}, '198.51.100.4'],
    ['IPv4 with port', '10.0.0.1', {'x-forwarded-for': '198.51.100.4:443'}, '198.51.100.4'],
    ['IPv4 with non-numeric port suffix', '10.0.0.1', {'x-forwarded-for': '198.51.100.4:abc'}, '198.51.100.4'],
    ['IPv6 first', '10.0.0.1', {'x-forwarded-for': '2001:db8::4, 10.0.0.2'}, '2001:db8::4'],
    ['IPv6 after comma-space: chain rejected', '10.0.0.1', {'x-forwarded-for': '198.51.100.4, 2001:db8::2'}, '10.0.0.1'],
    ['IPv6 after bare comma', '10.0.0.1', {'x-forwarded-for': '198.51.100.4,2001:db8::2'}, '198.51.100.4'],
    ['bracketed IPv6 with port', '10.0.0.1', {'x-forwarded-for': '[2001:db8::4]:443'}, '10.0.0.1'],
    ['unknown', '10.0.0.1', {'x-forwarded-for': 'unknown'}, '10.0.0.1'],
    ['empty', '10.0.0.1', {'x-forwarded-for': ''}, '10.0.0.1'],
    ['invalid XFF does not fall through to X-Real-IP', '10.0.0.1', {'x-forwarded-for': 'unknown', 'x-real-ip': '198.51.100.9'}, '10.0.0.1'],
    ['X-Real-IP', '10.0.0.1', {'x-real-ip': '198.51.100.9'}, '198.51.100.9'],
    ['Fastly-Client-IP beats XFF (fresh order)', '10.0.0.1', {'fastly-client-ip': '198.51.100.6', 'x-forwarded-for': '198.51.100.5'}, '198.51.100.6'],
    ['XFF beats X-Real-IP (fresh order)', '10.0.0.1', {'x-forwarded-for': '198.51.100.5', 'x-real-ip': '198.51.100.9'}, '198.51.100.5'],
    ['RFC 7239 Forwarded is not parsed', '10.0.0.1', {'forwarded': 'for=198.51.100.4'}, '10.0.0.1'],
    ['bare address in Forwarded', '10.0.0.1', {'forwarded': '198.51.100.4'}, '198.51.100.4'],
    ['Z-Forwarded-For', '10.0.0.1', {'z-forwarded-for': '198.51.100.7'}, '198.51.100.7'],
    ['IPv6 peer', '::1', {}, '::1'],
    ['IPv4-mapped peer', '::ffff:10.0.0.1', {}, '::ffff:10.0.0.1'],
    ['no socket address, header present', undefined, {'x-forwarded-for': '198.51.100.4'}, '198.51.100.4'],
    ['no socket address, no header', undefined, {}, '127.0.0.1'],
  ];

  for (const [name, peer, headers, expected] of MEASURED) {
    it('client address: ' + name, function () {
      assert.equal(unsetResolver()(raw(peer, headers)), expected);
    });
  }

  it('client address: header precedence depends on earlier requests, as on dev', function () {
    const resolve = unsetResolver();
    const both = {'x-forwarded-for': '198.51.100.5', 'x-real-ip': '198.51.100.9'};
    assert.equal(resolve(raw('10.0.0.1', both)), '198.51.100.5');
    assert.equal(resolve(raw('10.0.0.1', {'x-real-ip': '198.51.100.9'})), '198.51.100.9');
    assert.equal(resolve(raw('10.0.0.1', both)), '198.51.100.9');
  });

  it('client address: the same through HTTP authorization and API v3 authentication', async function () {
    const req = raw('10.1.0.2', {'x-forwarded-for': '198.51.100.4, 2001:db8::2'});
    req.header = () => undefined;
    req.query = {};
    const authorization = require('../lib/authorization')({settings: {}}, {
      store: {collection() { return {}; }}, language: {translate: text => text}
    });
    let observed;
    authorization.resolve = data => { observed = data; };
    authorization.resolveWithRequest(req, () => {});
    assert.equal(observed.ip, '10.1.0.2');
    const app = appFor();
    app.set('API3_SECURITY_ENABLE', true);
    req.header = name => name === 'Authorization' ? 'Bearer owned-test-token' : undefined;
    const ctx = {authorization: {resolve (data, callback) { observed = data; callback(null, {shiros: []}); }}};
    await require('../lib/api3/security').authenticate({app, ctx, req, res: {}});
    assert.equal(observed.ip, '10.1.0.2');
  });

  // [X-Forwarded-Proto sent (null = none), status dev 74fc6619 returns]
  // 200 = treated as HTTPS; 307 = redirected to https.
  const HTTPS_MEASURED = [
    [null, 307], ['https', 200], ['http', 307], ['https, http', 200],
    ['http, https', 307], ['HTTPS', 307], [' https', 200]
  ];

  it('HTTPS detection: X-Forwarded-Proto is honoured from any peer, as on dev', async function () {
    const createApp = require('../lib/server/app');
    const env = {name: 'proxy-default-test', version: '1', trustProxy: undefined,
      insecureUseHttp: false, secureHstsHeader: false, static_files: '/static', settings: require('../lib/settings')()};
    const app = createApp(env, {bootErrors: [{desc: 'test', err: 'test'}]});
    for (const [proto, status] of HTTPS_MEASURED) {
      let req = request(app).get('/robots.txt');
      if (proto !== null) req = req.set('X-Forwarded-Proto', proto);
      const res = await req;
      assert.equal(res.status, status, 'X-Forwarded-Proto: ' + JSON.stringify(proto));
    }
  });
});

// bf2/auth-hardening. TRUST_PROXY also takes Express's other two forms: a hop
// count n (trust the n closest hops) and true (trust every hop). Both resolve
// through proxy-addr, so req.ip, req.secure and the throttle's address agree.
// Neither is the compatibility default above.
describe('TRUST_PROXY hop counts and true', function () {
  const INVALID = /^Error: TRUST_PROXY must be false, true, a whole number of proxy hops/;
  // peer 10.0.0.1 appended the right-most entry; the one before it was
  // appended by the proxy two hops away; the left-most came from the caller.
  const CHAIN = raw('10.0.0.1', { 'x-forwarded-for': '198.51.100.4, 203.0.113.50, 10.0.0.2' });

  it('accepts whole numbers and true, and neither takes the legacy path', function () {
    for (const [value, hops] of [['1', 1], ['2', 2], [' 3 ', 3], ['10', 10], [2, 2]]) {
      const trust = compileTrust(value);
      assert.equal(trust.trustedHops, hops, JSON.stringify(value));
      assert.equal(trust.legacyForwardedHeaders, undefined);
      assert.equal(trust.trustsEveryHop, undefined);
    }
    for (const value of ['true', 'TRUE', ' True ', true]) {
      const trust = compileTrust(value);
      assert.equal(trust.trustsEveryHop, true, JSON.stringify(value));
      assert.equal(trust.legacyForwardedHeaders, undefined);
      assert.notEqual(trust, compileTrust(undefined));
    }
  });

  it('rejects zero, negative, fractional and non-decimal numbers, and numbers mixed with addresses', function () {
    for (const value of ['0', '-1', '1.5', '0x2', '1e1', '01', '+1', '1 2', '2,10.0.0.1', '10.0.0.1,2', '1,', 0, -1, 1.5]) {
      assert.throws(() => compileTrust(value), INVALID, JSON.stringify(value));
    }
  });

  it('refuses subnet aliases on their own path', function () {
    for (const value of ['loopback', 'linklocal', 'uniquelocal', '10.0.0.1,loopback']) {
      assert.throws(() => compileTrust(value), /subnet aliases loopback, linklocal, uniquelocal are not accepted/, value);
    }
  });

  it('with a hop count, the client is the entry the n-th closest proxy added', function () {
    assert.equal(createClientIP('1')(CHAIN), '10.0.0.2');
    assert.equal(createClientIP('2')(CHAIN), '203.0.113.50');
    assert.equal(createClientIP('3')(CHAIN), '198.51.100.4');
    assert.equal(createClientIP('5')(CHAIN), '198.51.100.4');
    assert.equal(createClientIP('1')(raw('10.0.0.1')), '10.0.0.1');
    assert.equal(createClientIP('1')(raw('10.0.0.1', { 'x-real-ip': '198.51.100.9' })), '10.0.0.1');
  });

  it('with true, the client is the left-most entry', function () {
    assert.equal(createClientIP('true')(CHAIN), '198.51.100.4');
  });

  it('req.ip, req.secure and the throttle address agree through Express', async function () {
    // [TRUST_PROXY, what the loopback peer's request resolves to]
    for (const [setting, expected] of [['1', '203.0.113.50'], ['2', '198.51.100.4'], ['true', '198.51.100.4']]) {
      const res = await request(appFor(setting)).get('/')
        .set('Host', 'direct.example').set('X-Forwarded-For', '198.51.100.4, 203.0.113.50')
        .set('X-Forwarded-Host', 'edge.example').set('X-Forwarded-Proto', 'https').expect(200);
      assert.equal(res.body.ip, expected, setting);
      assert.equal(res.body.expressIP, expected, setting);
      assert.equal(res.body.secure, true, setting);
      assert.equal(res.body.hostname, 'edge.example', setting);
    }
  });

  it('honours forwarded HTTPS in the actual Nightscout app with a hop count or true', async function () {
    const createApp = require('../lib/server/app');
    for (const setting of ['1', '2', 'true']) {
      const env = { name: 'proxy-hops-test', version: '1', trustProxy: setting,
        insecureUseHttp: false, secureHstsHeader: false, static_files: '/static', settings: require('../lib/settings')() };
      const app = createApp(env, { bootErrors: [{ desc: 'test', err: 'test' }] });
      await request(app).get('/robots.txt').set('X-Forwarded-Proto', 'https').expect(200);
      await request(app).get('/robots.txt').expect(307);
    }
  });

  it('passes the hop-count client address to HTTP authorization and API v3 authentication', async function () {
    for (const [setting, expected] of [['1', '203.0.113.50'], ['2', '198.51.100.4']]) {
      const req = raw('10.0.0.1', { 'x-forwarded-for': '198.51.100.4, 203.0.113.50' });
      req.header = () => undefined;
      req.query = {};
      const authorization = require('../lib/authorization')({ trustProxy: setting, settings: {} }, {
        store: { collection () { return {}; } }, language: { translate: text => text }
      });
      let observed;
      authorization.resolve = data => { observed = data; };
      authorization.resolveWithRequest(req, () => {});
      assert.equal(observed.ip, expected, setting);
      const app = appFor(setting);
      app.set('API3_SECURITY_ENABLE', true);
      req.header = name => name === 'Authorization' ? 'Bearer owned-test-token' : undefined;
      const ctx = { authorization: { resolve (data, callback) { observed = data; callback(null, { shiros: [] }); } } };
      await require('../lib/api3/security').authenticate({ app, ctx, req, res: {} });
      assert.equal(observed.ip, expected, setting);
    }
  });

  // Measured: on 11 of the 25 unset-default fixtures (the table above plus the
  // two chain cases in the legacy test) true and unset give different answers.
  // These are some of them. The chain cases differ because forwarded-for
  // rejects an IPv6 entry after a comma and a space, and proxy-addr does not.
  it('true is not the compatibility default', function () {
    const truly = createClientIP('true');
    const unset = createClientIP();
    // [socket peer, headers, true, unset]
    for (const [peer, headers, whenTrue, whenUnset] of [
      ['10.0.0.1', { 'x-forwarded-for': '198.51.100.4, 2001:db8::2' }, '198.51.100.4', '10.0.0.1'],
      ['::1', { 'x-forwarded-for': '2001:db8::4, ::1' }, '2001:db8::4', '::1'],
      ['10.0.0.1', { 'x-real-ip': '198.51.100.9' }, '10.0.0.1', '198.51.100.9'],
      ['10.0.0.1', { 'x-forwarded-for': '[2001:db8::4]:443' }, '2001:db8::4', '10.0.0.1'],
      [undefined, {}, undefined, '127.0.0.1']
    ]) {
      freshProcessOrder();
      assert.equal(truly(raw(peer, headers)), whenTrue, JSON.stringify(headers));
      assert.equal(unset(raw(peer, headers)), whenUnset, JSON.stringify(headers));
    }
    freshProcessOrder();
  });
});
