'use strict';

const assert = require('node:assert/strict');
const {describe, it, before, after} = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const {execFileSync} = require('node:child_process');
const {once, EventEmitter} = require('node:events');
const {inspect} = require('node:util');
const {createRequire} = require('node:module');
const source = require('nightscout-connect/lib/sources/dexcomshare');
const connectorRequire = createRequire(require.resolve('nightscout-connect'));
const axios = connectorRequire('axios');
const {interpret} = connectorRequire('xstate');
const {SimulatedClock} = connectorRequire('xstate/lib/SimulatedClock');
const builder = require('nightscout-connect/lib/builder');
const {setTimeout: delay} = require('node:timers/promises');
const compat = require('../../lib/server/bridge-connect-compat');

describe('Connect Dexcom transport after legacy migration', function () {
  let directory, server, certificate, host, requests, objectAuth, agent;
  let sessionNumber = 0, numberedSessions = false;
  before(async function () {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-connect-dexcom-'));
    const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem');
    execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-sha256',
      '-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1',
      '-addext','subjectAltName=IP:127.0.0.1'], {stdio:'ignore', timeout:10000});
    certificate = fs.readFileSync(cert); requests = [];
    server = https.createServer({key:fs.readFileSync(key),cert:certificate}, (req,res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const url = new URL(req.url, 'https://127.0.0.1');
        requests.push({path:url.pathname,query:Object.fromEntries(url.searchParams),body:JSON.parse(body || '{}'),method:req.method});
        res.setHeader('Content-Type','application/json');res.setHeader('Connection','close');
        if (url.pathname.endsWith('/AuthenticatePublisherAccount')) return res.end(JSON.stringify(objectAuth ? {accountId:'owned-account'} : 'owned-account'));
        if (url.pathname.endsWith('/LoginPublisherAccountById')) return res.end(JSON.stringify(numberedSessions ? 'owned-session-' + (++sessionNumber) : 'owned-session'));
        res.end(JSON.stringify([{Value:100,WT:'/Date(1700000000000)/',Trend:4}]));
      });
    });
    server.listen(0,'127.0.0.1'); await once(server,'listening');
    host = '127.0.0.1:' + server.address().port;
    agent = new https.Agent({ca:certificate});
  });
  after(async function () {
    if(agent) agent.destroy();
    if(server) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    if(directory) fs.rmSync(directory,{recursive:true,force:true});
  });
  function driver(trusted) {
    const env = {extendedSettings:{bridge:{userName:'owned-user',password:'owned-password',server:host,useLegacy:true}}};
    assert.equal(compat.applyBridgeToConnectCompatibility(env).migrated,true);
    const validated = source.validate(env.extendedSettings.connect);
    assert.equal(validated.ok,true);
    // Use the connector's real Axios implementation. Only route isolation and
    // this fixture's private CA differ; no TLS-verification bypass is supplied.
    return source(validated.config,{create(config) {
      return axios.create({...config,proxy:false,...(trusted ? {httpsAgent:agent} : {})});
    }});
  }
  it('does not log migrated credentials during real Connect startup', async function (t) {
    const logs = [];
    t.mock.method(console, 'log', (...args) => logs.push(inspect(args, {depth: 10})));
    for (let cycle = 0; cycle < 2; cycle++) {
      const env = {extendedSettings: {bridge: {userName: 'owned-user', password: 'owned-password', server: host}}};
      compat.applyBridgeToConnectCompatibility(env);
      const bus = new EventEmitter();
      const ctx = {bus, bootErrors: []};
      const handle = require('nightscout-connect')(env, ctx);
      try {
        assert.ok(handle);
        assert.deepEqual(ctx.bootErrors, []);
        bus.emit('tick', {password: 'owned-password'});
        assert.ok(!logs.join('\n').includes('owned-user'));
        assert.ok(!logs.join('\n').includes('owned-password'));
      } finally {
        await handle.stop();
        bus.removeAllListeners();
      }
    }
  });
  it('rejects an untrusted endpoint before transmitting credentials twice',async function () {
    for(let cycle=0;cycle<2;cycle++) {
      const before=requests.length;
      await assert.rejects(driver(false).authFromCredentials(), error=>error.code==='DEPTH_ZERO_SELF_SIGNED_CERT');
      assert.equal(requests.length,before);
    }
  });
  it('authenticates both account response shapes and retrieves mapped readings twice',async function () {
    for(let cycle=0;cycle<2;cycle++) {
      objectAuth=!!cycle;const before=requests.length, impl=driver(true);
      const account=await impl.authFromCredentials();assert.equal(account,'owned-account');
      const session=await impl.sessionFromAuth(account);assert.equal(session,'owned-session');
      const data=await impl.dataFromSesssion(session,{entries:new Date(Date.now()-300000)});
      const mapped=impl.transformGlucose(data).entries;
      assert.equal(mapped.length,1);assert.equal(mapped[0].sgv,100);assert.equal(mapped[0].date,1700000000000);
      assert.equal(mapped[0].device,'nightscout-connect');assert.equal(mapped[0].direction,'Flat');
      const batch=requests.slice(before);assert.equal(batch.length,3);assert.ok(batch.every(req=>req.method==='POST'));
      assert.equal(batch[0].body.accountName,'owned-user');assert.equal(batch[0].body.password,'owned-password');
      assert.equal(batch[1].body.accountId,'owned-account');assert.equal(batch[2].query.sessionID,'owned-session');
      assert.ok(Number(batch[2].query.maxCount)>=1 && Number(batch[2].query.maxCount)<=2);
      assert.equal(Number(batch[2].query.minutes),5*Number(batch[2].query.maxCount));
    }
  });
  it('reuses sessions, reauthenticates after expiry and clears actor timers twice', async function () {
    for (let cycle = 0; cycle < 2; cycle++) {
      numberedSessions = true; sessionNumber = 0;
      const clock = new SimulatedClock();
      const before = requests.length;
      let persisted = 0;
      const output = async batch => {
        assert.equal(batch.entries.length, 1);
        assert.equal(batch.entries[0].sgv, 100);
        persisted++;
        return {entries: new Date()};
      };
      output.gap_for = async () => ({entries: new Date(Date.now() - 300000)});
      const make = builder({output});
      driver(true).generate_driver(make);
      const actorLogs = [];
      const actor = interpret(make(), {clock, logger: (...args) => actorLogs.push(inspect(args, {depth: 15}))});
      const count = suffix => requests.slice(before).filter(req => req.path.endsWith(suffix)).length;
      async function until(predicate) {
        for (let attempt = 0; attempt < 400; attempt++) {
          clock.increment(0);
          if (predicate()) return;
          await delay(5);
        }
        assert.fail('Dexcom actor did not finish the owned polling cycle');
      }
      try {
        actor.start(); actor.send('START');
        await until(() => persisted === 1 && actor.children.get('DexcomShare').state.matches('After'));
        assert.equal(count('/AuthenticatePublisherAccount'), 1);
        assert.equal(count('/LoginPublisherAccountById'), 1);
        actor.send('SESSION_REQUIRED');
        await delay(5);
        assert.equal(count('/AuthenticatePublisherAccount'), 1);
        assert.equal(actor.children.get('Session').state.value, 'Active');
        clock.increment(24 * 60 * 60 * 1000);
        actor.send('SESSION_REQUIRED');
        await until(() => persisted === 2 && actor.children.get('DexcomShare').state.matches('After'));
        assert.equal(count('/AuthenticatePublisherAccount'), 2);
        assert.equal(count('/LoginPublisherAccountById'), 2);
        assert.equal(count('/ReadPublisherLatestGlucoseValues'), 2);
        const readings = requests.slice(before).filter(req => req.path.endsWith('/ReadPublisherLatestGlucoseValues'));
        assert.deepEqual(readings.map(req => req.query.sessionID), ['owned-session-1', 'owned-session-2']);
        assert.equal(actor.children.get('Session').state.value, 'Active');
      } finally {
        actor.stop(); numberedSessions = false;
      }
      assert.equal(clock.timeouts.size, 0);
      for (const secret of ['owned-user', 'owned-password', 'owned-account', 'owned-session']) {
        assert.ok(!actorLogs.join('\n').includes(secret), 'Actor log contains owned secret: ' + secret);
      }
    }
  });

});
