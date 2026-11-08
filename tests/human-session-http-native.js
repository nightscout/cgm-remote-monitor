'use strict';

// Opt-in actual HTTPS transport acceptance. The provider is synthetic and the
// aggregate collection is a source double; this is NOT native Mongo/PG evidence.
// TLS key/certificate are generated into owned scratch before the reserved run.
const assert = require('node:assert/strict');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const express = require('express');
const { randomBytes } = require('node:crypto');
const { createProvider } = require('../lib/human-session/provider');
const { createHumanHTTP, COOKIE, FLOW, PREFIX } = require('../lib/human-session/http');
const { createEngine } = require('../lib/human-session/engine');
const { createMongoStore, principalId } = require('../lib/human-session/mongo');
const fixture = require('./fixtures/human-oidc-provider');

function assertPort (port) {
  if ([18080, 18081, 18082].includes(port)) throw new Error('Fixture assigned a reserved port');
}

async function closeOwned ({ servers, sockets, socketClosures, resources = [], timeoutMs = 15000, onDeadline = () => {} }) {
  let timer;
  const closing = Promise.resolve().then(async () => {
    const settled = [...socketClosures.values()];
    for (const socket of sockets) socket.destroy();
    const closed = servers.map(server => new Promise((resolve, reject) => {
      server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
    }));
    const outcomes = await Promise.allSettled([...settled, ...closed,
      ...resources.map(resource => Promise.resolve().then(() => resource.close()))]);
    const errors = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new globalThis.AggregateError(errors, 'Owned fixture cleanup failures');
    assert.equal(sockets.size, 0, 'owned socket close events must settle');
  });
  try {
    await Promise.race([closing, new Promise((resolve, reject) => {
      timer = setTimeout(() => { const error = new Error('Fixture cleanup exceeded its reserved deadline');
        reject(error); onDeadline(error); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function assertEndpointClosed (host, port) {
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(1000, () => socket.destroy(new Error('Owned browser listener closure probe timed out')));
    socket.once('connect', () => { socket.destroy(); reject(new Error('Owned browser listener remains open after cleanup')); });
    socket.once('error', error => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(); else reject(error);
    });
  });
}

async function closeBrowser (server, { graceMs = 5000, probe = assertEndpointClosed } = {}) {
  let timer;
  const errors = [], endpoint = new URL(server.wsEndpoint());
  try {
    await Promise.race([server.close(), new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Browser graceful cleanup deadline exceeded')), graceMs);
    })]);
  } catch (error) {
    errors.push(error);
    try { await server.kill(); } catch (killError) { errors.push(killError); }
  } finally { clearTimeout(timer); }
  try { await probe(endpoint.hostname, Number(endpoint.port)); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new globalThis.AggregateError(errors, 'Browser cleanup failures');
}

async function run () {
  if (process.env.HUMAN_HTTPS_RESERVED !== '1') throw new Error('Explicit one-run HTTPS reservation required');
  const tls = { key: fs.readFileSync(process.env.HUMAN_HTTPS_KEY), cert: fs.readFileSync(process.env.HUMAN_HTTPS_CERT) };
  const servers = [], sockets = new Set(), socketClosures = new Map();
  let timedOut = false, deadlineExit;
  const deadline = setTimeout(() => {
    timedOut = true;
    for (const socket of sockets) socket.destroy();
    for (const server of servers) server.close();
    if (ownedBrowserServer) ownedBrowserServer.kill().catch(() => {});
    // This also bounds a stuck browser RPC that would otherwise never enter
    // finally. Timers are cooperative; no external wall-clock guarantee exists.
    deadlineExit = setTimeout(() => { console.error('Fixture active deadline and abort cleanup exceeded'); process.exit(1); }, 15000);
  }, 60000);
  const counts = { assertions: 0 };
  let result;
  let primary, cleanupError;
  let nativeStore;
  let ownedBrowserServer;
  let providerFixture, mounted;
  function check (actual, expected) { assert.deepEqual(actual, expected); counts.assertions++; }
  async function listen (handler) {
    const server = https.createServer(tls, handler); servers.push(server);
    server.on('connection', socket => {
      sockets.add(socket);
      socketClosures.set(socket, new Promise(resolve => socket.once('close', () => {
        sockets.delete(socket); socketClosures.delete(socket); resolve();
      })));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    assertPort(server.address().port);
    console.log(JSON.stringify({ event: 'owned-listener', pid: process.pid, host: '127.0.0.1', port: server.address().port }));
    return 'https://127.0.0.1:' + server.address().port;
  }
  const allowed = new Set();
  async function transport (input, options = {}) {
    const request = input instanceof Request ? input : new Request(input, options), url = new URL(request.url);
    if (!allowed.has(url.origin)) throw new Error('Fixture outbound URL refused');
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer());
    return new Promise((resolve, reject) => {
      const req = https.request(url, { method: request.method, headers: Object.fromEntries(request.headers), ca: tls.cert,
        timeout: 3000, agent: false }, res => {
        const chunks = []; let length = 0;
        res.once('error', reject); res.once('aborted', () => reject(new Error('Fixture TLS response aborted')));
        res.on('data', chunk => { length += chunk.length; if (length > 262144) req.destroy(new Error('Fixture response bound')); else chunks.push(chunk); });
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      });
      req.once('timeout', () => req.destroy(new Error('Fixture timeout'))); req.once('error', reject); req.end(body);
    });
  }
  try {
    const site = await listen((req, res) => mounted ? mounted(req, res) : res.writeHead(503).end()); allowed.add(site);
    const issuerListener = await listen(async (req, res) => {
      try {
        const url = new URL(req.url, issuer);
        if (url.pathname === '/authorize') { res.writeHead(303, { location: providerFixture.authorize(url) }); return res.end(); }
        const chunks = []; let length = 0;
        for await (const chunk of req) { length += chunk.length; if (length > 16384) throw new Error('Fixture body bound'); chunks.push(chunk); }
        const result = await providerFixture.fetch(new Request(url, { method: req.method, headers: req.headers,
          ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) }));
        res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(Buffer.from(await result.arrayBuffer()));
      } catch { res.writeHead(503).end(); }
    });
    // Browser scope acceptance uses two distinct loopback hosts, rather than
    // pretending ports isolate cookies. The certificate needs DNS:localhost as
    // well as IP:127.0.0.1 in that separately reserved browser fixture.
    const issuer = process.env.HUMAN_BROWSER_RESERVED === '1'
      ? 'https://localhost:' + new URL(issuerListener).port : issuerListener;
    allowed.add(issuer);
    providerFixture = await fixture({ issuer, redirectUri: site + PREFIX + '/callback' });
    const provider = await createProvider({ ...providerFixture, fetch: transport });
    const persistence = process.env.HUMAN_HTTP_STORE || 'double';
    if (!['double', 'mongo', 'postgres'].includes(persistence)) throw new Error('Explicit fixture persistence kind refused');
    if (persistence !== 'double') nativeStore = await require('./fixtures/human-native-stores').createNativeStore({
      kind: persistence, issuer, providerSubject: 'synthetic-subject', providerSession: 'synthetic-provider-session' });
    const tenant = nativeStore?.tenant || 'single', subject = 'synthetic-subject';
    let document = { _id: principalId(tenant, issuer, subject), tenant, issuer, providerSubject: subject,
      subject: 'synthetic_local', consumer: 'oidc', enabled: true, generation: 1, revision: 1,
      purposes: ['data', 'management'], permissionGroups: [['api:entries:read']], sessions: [], logoutEvents: [] };
    const clone = value => JSON.parse(JSON.stringify(value));
    const collection = {
      async findOne (query) {
        if (query._id && query._id !== document._id || query.tenant !== tenant ||
            query['sessions.tokens.hash'] && !document.sessions.some(session => session.tokens.some(token => token.hash === query['sessions.tokens.hash']))) return null;
        return clone(document);
      },
      async findOneAndReplace (query, replacement) {
        if (Object.keys(query).some(key => JSON.stringify(query[key]) !== JSON.stringify(document[key]))) return null;
        document = clone(replacement); return clone(document);
      },
      find () { return { limit: () => ({ toArray: async () => [clone(document)] }) }; }
    };
    const engine = createEngine({ store: nativeStore?.store || createMongoStore({ collection, tenant, consumer: 'oidc' }) });
    const workerB = createEngine({ store: nativeStore ? await nativeStore.createWorkerStore()
      : createMongoStore({ collection, tenant, consumer: 'oidc' }) });
    const http = createHumanHTTP({ engine, provider, resolver: { resolve: async () => tenant }, originFor: () => site, cookieKey: randomBytes(32) });
    const app = express(); app.use(PREFIX, http.router);
    app.get('/', (req, res) => res.set('Cache-Control', 'no-store').type('html').send('<!doctype html><title>Synthetic session fixture</title><p>Session acceptance fixture</p>'));
    app.get('/protected', async (req, res) => {
      try { const supplied = http.credential(req); await workerB.authenticate({ tenant, token: supplied?.token, purpose: 'data' }); res.json({ allowed: true }); }
      catch (error) { res.status(error.code === 'HUMAN_SESSION_UNAVAILABLE' ? 503 : 401).json({ allowed: false }); }
    });
    mounted = app;
    const json = (path, body, headers = {}) => transport(site + PREFIX + path, { method: 'POST',
      headers: { origin: site, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    async function login (mode) {
      const started = await json('/login', { transport: mode }); check(started.status, 200);
      const flowCookie = started.headers.get('set-cookie').split(';')[0]; assert(flowCookie.startsWith(FLOW + '-'));
      const location = (await started.json()).location;
      const authorize = await transport(location); check(authorize.status, 303);
      return transport(authorize.headers.get('location'), { headers: { cookie: flowCookie } });
    }
    const cookieReply = await login('cookie'); check(cookieReply.status, 303);
    const cookie = cookieReply.headers.get('set-cookie').split(',').map(value => value.trim()).find(value => value.startsWith(COOKIE + '='));
    assert(cookie && /HttpOnly/i.test(cookie) && /Secure/i.test(cookie) && /SameSite=Strict/i.test(cookie)); counts.assertions++;
    const credentialCookie = cookie.split(';')[0];
    check((await transport(site + '/protected', { headers: { cookie: credentialCookie } })).status, 200);
    const session = await transport(site + PREFIX + '/session', { headers: { cookie: credentialCookie } }); check(session.status, 200);
    const csrf = (await session.json()).csrf;
    check((await json('/logout', {}, { cookie: credentialCookie })).status, 403);
    check((await json('/logout', {}, { cookie: credentialCookie, 'x-ns-csrf': csrf })).status, 200);
    check((await transport(site + '/protected', { headers: { cookie: credentialCookie } })).status, 401);
    const bearerReply = await login('bearer'); check(bearerReply.status, 200);
    const token = (await bearerReply.json()).token;
    check((await transport(site + '/protected', { headers: { authorization: 'Bearer ' + token } })).status, 200);
    const renewal = await json('/renew', {}, { authorization: 'Bearer ' + token }); check(renewal.status, 200);
    const renewalLocation = (await renewal.json()).location;
    const renewalCookie = renewal.headers.get('set-cookie').split(';')[0];
    const pendingProof = await transport(renewalLocation); check(pendingProof.status, 303);
    providerFixture.state.offline = true;
    check((await transport(site + '/protected', { headers: { authorization: 'Bearer ' + token } })).status, 200);
    // The provider disappears after code acquisition. Its actual token-endpoint
    // 503 must remain unavailable at the consuming HTTP callback, with no new
    // local access issuance or cached provider-identity fallback.
    check((await transport(pendingProof.headers.get('location'), { headers: { cookie: renewalCookie } })).status, 503);
    check((await transport(renewalLocation)).status, 503);
    check((await json('/logout', {}, { authorization: 'Bearer ' + token })).status, 200);
    check((await transport(site + '/protected', { headers: { authorization: 'Bearer ' + token } })).status, 401);
    if (process.env.HUMAN_BROWSER_RESERVED === '1') {
      providerFixture.state.offline = false;
      const { chromium } = require('playwright-core');
      ownedBrowserServer = await chromium.launchServer({ executablePath: process.env.HUMAN_BROWSER_EXECUTABLE,
        host: '127.0.0.1', port: 0, headless: true, args: ['--no-proxy-server'], timeout: 10000 });
      const browserEndpoint = new URL(ownedBrowserServer.wsEndpoint());
      assert.equal(browserEndpoint.hostname, '127.0.0.1'); assertPort(Number(browserEndpoint.port));
      console.log(JSON.stringify({ event: 'owned-browser', pid: ownedBrowserServer.process().pid,
        host: browserEndpoint.hostname, port: Number(browserEndpoint.port) }));
      const browser = await chromium.connect(ownedBrowserServer.wsEndpoint(), { timeout: 5000 });
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        await context.route('**/*', route => allowed.has(new URL(route.request().url()).origin) ? route.continue() : route.abort());
        const page = await context.newPage(); await page.goto(site);
        const location = await page.evaluate(async prefix => {
          const reply = await fetch(prefix + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          return (await reply.json()).location;
        }, PREFIX);
        await page.goto(location); await page.waitForURL(site + '/');
        check(await page.evaluate(() => document.cookie.includes('__Host-ns-human')), false);
        const browserCookies = await context.cookies();
        check(browserCookies.filter(value => value.name === COOKIE).map(value => [value.httpOnly, value.secure, value.sameSite]), [[true, true, 'Strict']]);
        check((await context.cookies(issuer)).some(value => value.name === COOKIE), false);
        const tab = await context.newPage(); await tab.goto(site);
        check(await tab.evaluate(async () => (await fetch('/protected')).status), 200);
        const managementLocation = await page.evaluate(async prefix => (await (await fetch(prefix + '/login', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'management' })
        })).json()).location, PREFIX);
        await page.goto(managementLocation); await page.waitForURL(site + '/');
        check(await tab.evaluate(async () => (await fetch('/protected')).status), 200);
        check(await page.evaluate(async prefix => {
          const state = await (await fetch(prefix + '/session?purpose=management')).json();
          return (await fetch(prefix + '/logout', { method: 'POST', headers: { 'content-type': 'application/json',
            'x-ns-csrf': state.csrf }, body: JSON.stringify({ purpose: 'management' }) })).status;
        }, PREFIX), 200);
        check(await tab.evaluate(async () => (await fetch('/protected')).status), 200);
        check(await page.evaluate(async prefix => (await fetch(prefix + '/session?purpose=management')).status, PREFIX), 401);
        check(await page.evaluate(async prefix => (await fetch(prefix + '/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, PREFIX), 403);
        check(await page.evaluate(async prefix => {
          const state = await (await fetch(prefix + '/session')).json();
          return (await fetch(prefix + '/logout', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ns-csrf': state.csrf }, body: '{}' })).status;
        }, PREFIX), 200);
        check(await tab.evaluate(async () => (await fetch('/protected')).status), 401);
        await page.goto(site + '/protected'); await page.goBack();
        check(await page.evaluate(async () => (await fetch('/protected', { cache: 'no-store' })).status), 401);
        await page.goto(site);
        const directLocation = await page.evaluate(async prefix => {
          const reply = await fetch(prefix + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transport: 'bearer' }) });
          return (await reply.json()).location;
        }, PREFIX);
        const directResponse = await page.goto(directLocation);
        const direct = (await directResponse.json()).token;
        assert(/^nsh_[A-Za-z0-9_-]{43}$/.test(direct)); counts.assertions++;
        check(new URL(page.url()).searchParams.has('token'), false);
        check((await context.cookies()).some(value => value.name === COOKIE), false);
        const bearerRequest = (target, selected) => target.evaluate(async value => (await fetch('/protected', {
          headers: { authorization: 'Bearer ' + value }
        })).status, selected);
        check(await bearerRequest(page, direct), 200);
        check(await bearerRequest(tab, direct), 200);
        check(await page.evaluate(async ({ prefix, token }) => (await fetch(prefix + '/logout', {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: '{}'
        })).status, { prefix: PREFIX, token: direct }), 200);
        check(await bearerRequest(tab, direct), 401);
        await page.goto(site); await page.goBack();
        check(await bearerRequest(page, direct), 401);
        await page.goto(site);
        const managementBearerLocation = await page.evaluate(async prefix => (await (await fetch(prefix + '/login', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ purpose: 'management', transport: 'bearer' })
        })).json()).location, PREFIX);
        const managementBearerResponse = await page.goto(managementBearerLocation);
        const managementBearer = (await managementBearerResponse.json()).token;
        check(await bearerRequest(page, managementBearer), 401);
        check(await page.evaluate(async ({ prefix, token }) => (await fetch(prefix + '/session?purpose=management', {
          headers: { authorization: 'Bearer ' + token }
        })).status, { prefix: PREFIX, token: managementBearer }), 200);
        check(await page.evaluate(async ({ prefix, token }) => (await fetch(prefix + '/logout', {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
          body: JSON.stringify({ purpose: 'management' })
        })).status, { prefix: PREFIX, token: managementBearer }), 200);
        await context.close();
        counts.browser = 'actual-chromium-cookie-and-bearer-https';
    }
    result = { kind: 'actual-https-synthetic-provider', persistence: persistence === 'double' ? 'source-double' : persistence, ...counts, verdict: 'pass' };
  } catch (error) { primary = error; }
  finally {
    clearTimeout(deadline);
    try {
      const resources = nativeStore ? [nativeStore] : [];
      if (ownedBrowserServer) resources.push({ close: () => closeBrowser(ownedBrowserServer) });
      await closeOwned({ servers, sockets, socketClosures, resources, onDeadline: error => {
        if (primary) console.error(primary.name + ': ' + primary.message);
        if (ownedBrowserServer) ownedBrowserServer.kill().catch(() => {});
        console.error(error.message); process.exit(1);
      } });
      assert.equal(timedOut, false, 'fixture exceeded its reserved active deadline');
      console.log(JSON.stringify({ cleanup: 'closed', listeners: servers.length + (ownedBrowserServer ? 1 : 0) }));
    } catch (error) { cleanupError = error; }
    finally { clearTimeout(deadlineExit); }
  }
  if (primary && cleanupError) throw new globalThis.AggregateError([primary, cleanupError], 'Fixture operation and cleanup failed');
  if (primary || cleanupError) throw primary || cleanupError;
  console.log(JSON.stringify(result));
}

if (require.main === module) run().catch(error => {
  const failures = error.errors || [error];
  for (const failure of failures) console.error(failure.name + ': ' + failure.message);
  process.exit(1);
});
module.exports = { run, closeOwned, closeBrowser, assertPort };
