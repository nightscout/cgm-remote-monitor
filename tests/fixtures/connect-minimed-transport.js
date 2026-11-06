'use strict';
const assert = require('node:assert/strict');
const {describe, it, before, after} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const {once} = require('node:events');
const {inspect} = require('node:util');
const {createRequire} = require('node:module');
const {setTimeout: delay} = require('node:timers/promises');
const source = require('nightscout-connect/lib/sources/minimedcarelink');
const fromConnect = createRequire(require.resolve('nightscout-connect'));
const axios = fromConnect('axios');
const {interpret} = fromConnect('xstate');
const {SimulatedClock} = fromConnect('xstate/lib/SimulatedClock');
const builder = require('nightscout-connect/lib/builder');
const {applyMmconnectToConnectCompatibility: migrate} = require('../../lib/server/mmconnect-connect-compat');
const privateMarker = 'owned-minimed-private';

describe('installed MiniMed provider over owned HTTPS', function () {
  const servers = [], requests = [];
  let trustedHost, untrustedHost, sequence = 0;
  function form(action) {
    return '<form action="' + action + '" method="POST">\n<input type="hidden" name="sessionID" value="' + privateMarker + '">\n<input type="hidden" name="sessionData" value="' + privateMarker + '">';
  }
  before(async function () {
    for (const name of ['trusted', 'untrusted']) {
      const directory = process.env.OWNED_MINIMED_CERT_DIR;
      const server = https.createServer({key: fs.readFileSync(path.join(directory, name + '.key')), cert: fs.readFileSync(path.join(directory, name + '.pem'))}, (req, res) => {
        let body = '';
        req.on('data', chunk => {body += chunk;});
        req.on('end', () => {
          const url = new URL(req.url, 'https://127.0.0.1');
          requests.push({path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: req.headers});
          res.setHeader('Connection', 'close');
          if (url.pathname === '/patient/sso/login') {res.setHeader('Content-Type', 'text/html'); return res.end(form('/owned-login'));}
          if (url.pathname === '/owned-login') {
            res.setHeader('Content-Type', 'text/html');
            res.setHeader('Set-Cookie', 'owned_login=' + privateMarker + '; Path=/; Secure');
            return res.end(form('/owned-consent'));
          }
          if (url.pathname === '/owned-consent' || url.pathname === '/patient/sso/reauth') {
            sequence++;
            res.setHeader('Set-Cookie', ['auth_tmp_token=' + privateMarker + '-token-' + sequence + '; Path=/; Secure', 'c_token_valid_to=' + (Date.now() + 600000) + '; Path=/; Secure']);
            if (url.pathname === '/owned-consent') {res.statusCode = 302; res.setHeader('Location', '/owned-finish'); return res.end();}
          }
          res.setHeader('Content-Type', 'application/json');
          let data = {};
          if (url.pathname === '/patient/users/me') data = {role: 'PATIENT'};
          if (url.pathname === '/patient/users/me/profile') data = {username: privateMarker};
          if (url.pathname === '/patient/countries/settings') data = {blePereodicDataEndpoint: '/owned-ble'};
          if (url.pathname === '/patient/configuration/system/personal.cp.m2m.enabled') data = {value: false};
          if (url.pathname === '/patient/monitor/data') data = {deviceFamily: 'MINIMED'};
          if (url.pathname === '/owned-ble') {
            const now = new Date().toISOString();
            data = {medicalDeviceFamily: 'MINIMED', lastMedicalDeviceDataUpdateServerTime: Date.parse(now), sMedicalDeviceTime: now,
              sgs: [{kind: 'SG', sg: 123, datetime: now}], lastSG: {sg: 123}, lastSGTrend: 'UP', markers: [],
              medicalDeviceBatteryLevelPercent: 80, reservoirRemainingUnits: 100, activeInsulin: {amount: 1.2}};
          }
          res.end(JSON.stringify(data));
        });
      });
      servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const host = '127.0.0.1:' + server.address().port;
      if (name === 'trusted') trustedHost = host; else untrustedHost = host;
    }
  });
  after(async function () {for (const server of servers) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}});
  function driver(host = trustedHost) {
    const env = {extendedSettings: {mmconnect: {userName: privateMarker + '-user', password: privateMarker + '-password', server: host}, connect: {countryCode: 'gb'}}};
    assert.equal(migrate(env).migrated, true);
    const result = source.validate(env.extendedSettings.connect);
    assert.equal(result.ok, true);
    return source(result.config, {create: config => axios.create({...config, proxy: false})});
  }
  function capture(t) {
    const logs = [];
    for (const method of ['log', 'warn', 'error', 'debug']) t.mock.method(console, method, (...args) => logs.push(inspect(args, {depth: 15})));
    return {logger: (...args) => logs.push(inspect(args, {depth: 15})), verify() {assert.ok(!logs.join('\n').includes(privateMarker));}};
  }
  it('rejects an untrusted certificate before sending credentials across two attempts', async function (t) {
    capture(t);
    for (let cycle = 0; cycle < 2; cycle++) {
      const count = requests.length;
      await assert.rejects(driver(untrustedHost).authFromCredentials(), error => error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT');
      assert.equal(requests.length, count);
    }
  });
  it('runs SSO, redirects, real cookies, data fetch and refresh over two lifecycles without sensitive logs', async function (t) {
    const logs = capture(t);
    for (let cycle = 0; cycle < 2; cycle++) {
      const start = requests.length, impl = driver();
      const auth = await impl.authFromCredentials();
      assert.match(auth.token, /owned-minimed-private-token-/);
      const session = await impl.sessionFromAuth(auth);
      const data = await impl.dataFromSesssion(session);
      assert.equal(data.sgs[0].sg, 123);
      const oldToken = session.token;
      assert.equal(await impl.refreshSession(auth, session), session);
      assert.notEqual(session.token, oldToken);
      const calls = requests.slice(start);
      assert.equal(calls.find(req => req.path === '/patient/sso/login').query.country, 'gb');
      assert.equal(new URLSearchParams(calls.find(req => req.path === '/owned-login').body).get('password'), privateMarker + '-password');
      assert.ok(calls.find(req => req.path === '/owned-consent').headers.cookie.includes('owned_login=' + privateMarker));
      assert.equal(calls.find(req => req.path === '/patient/users/me').headers.authorization, 'Bearer ' + oldToken);
      assert.ok(calls.some(req => req.path === '/owned-finish'));
      logs.verify();
    }
  });
  it('reuses and expires actor sessions and clears timers across two lifecycles', async function (t) {
    const logs = capture(t);
    for (let cycle = 0; cycle < 2; cycle++) {
      const clock = new SimulatedClock(), start = requests.length;
      let persisted = 0;
      const output = async batch => {assert.equal(batch.entries[0].sgv, 123); persisted++; return {entries: new Date()};};
      output.gap_for = async () => ({entries: new Date(0)});
      const make = builder({output}); driver().generate_driver(make);
      const actor = interpret(make(), {clock, logger: logs.logger});
      const count = () => requests.slice(start).filter(req => req.path === '/owned-login').length;
      async function until(predicate) {
        for (let attempt = 0; attempt < 400; attempt++) {clock.increment(0); if (predicate()) return; await delay(5);}
        assert.fail('MiniMed actor did not finish owned polling cycle');
      }
      try {
        actor.start(); actor.send('START');
        await until(() => persisted === 1 && actor.children.get('MinimedCarelink').state.matches('After'));
        assert.equal(count(), 1);
        actor.send('SESSION_REQUIRED'); await delay(5); assert.equal(count(), 1);
        clock.increment(10 * 60 * 1000); actor.send('SESSION_REQUIRED');
        await until(() => persisted >= 2 && count() === 2);
        logs.verify();
      } finally {actor.stop();}
      assert.equal(clock.timeouts.size, 0);
      const stopped = requests.length; clock.increment(24 * 60 * 60 * 1000); await delay(10);
      assert.equal(requests.length, stopped);
    }
  });
});
