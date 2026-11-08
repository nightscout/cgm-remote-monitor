'use strict';

// Opt-in actual HTTPS transport acceptance. The provider is synthetic and the
// aggregate collection is a source double; this is NOT native Mongo/PG evidence.
// TLS key/certificate are generated into owned scratch before the reserved run.
const assert = require('node:assert/strict');
const https = require('node:https');
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

async function closeOwned ({ servers, sockets, socketClosures, timeoutMs = 15000, onDeadline = () => {} }) {
  let timer;
  const closing = Promise.resolve().then(async () => {
    const settled = [...socketClosures.values()];
    for (const socket of sockets) socket.destroy();
    const closed = servers.map(server => new Promise((resolve, reject) => {
      server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
    }));
    await Promise.all([...settled, ...closed]);
    assert.equal(sockets.size, 0, 'owned socket close events must settle');
  });
  try {
    await Promise.race([closing, new Promise((resolve, reject) => {
      timer = setTimeout(() => { const error = new Error('Fixture cleanup exceeded its reserved deadline');
        reject(error); onDeadline(error); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function run () {
  if (process.env.HUMAN_HTTPS_RESERVED !== '1') throw new Error('Explicit one-run HTTPS reservation required');
  const tls = { key: fs.readFileSync(process.env.HUMAN_HTTPS_KEY), cert: fs.readFileSync(process.env.HUMAN_HTTPS_CERT) };
  const servers = [], sockets = new Set(), socketClosures = new Map();
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; for (const socket of sockets) socket.destroy(); for (const server of servers) server.close(); }, 60000);
  const counts = { assertions: 0 };
  let result;
  let primary, cleanupError;
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
    const issuer = await listen(async (req, res) => {
      try {
        const url = new URL(req.url, issuer);
        if (url.pathname === '/authorize') { res.writeHead(303, { location: providerFixture.authorize(url) }); return res.end(); }
        const chunks = []; let length = 0;
        for await (const chunk of req) { length += chunk.length; if (length > 16384) throw new Error('Fixture body bound'); chunks.push(chunk); }
        const result = await providerFixture.fetch(new Request(url, { method: req.method, headers: req.headers,
          ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) }));
        res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(Buffer.from(await result.arrayBuffer()));
      } catch { res.writeHead(503).end(); }
    }); allowed.add(issuer);
    providerFixture = await fixture({ issuer, redirectUri: site + PREFIX + '/callback' });
    const provider = await createProvider({ ...providerFixture, fetch: transport });
    const tenant = 'single', subject = 'synthetic-subject';
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
    const engine = createEngine({ store: createMongoStore({ collection, tenant, consumer: 'oidc' }) });
    const workerB = createEngine({ store: createMongoStore({ collection, tenant, consumer: 'oidc' }) });
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
    providerFixture.state.offline = true;
    check((await transport(site + '/protected', { headers: { authorization: 'Bearer ' + token } })).status, 200);
    const renewal = await json('/renew', {}, { authorization: 'Bearer ' + token }); check(renewal.status, 200);
    // Begin is local URL construction; actual provider-dependent code proof is
    // unavailable, and cannot mint/renew a Nightscout credential.
    check((await transport((await renewal.json()).location)).status, 503);
    check((await json('/logout', {}, { authorization: 'Bearer ' + token })).status, 200);
    check((await transport(site + '/protected', { headers: { authorization: 'Bearer ' + token } })).status, 401);
    if (process.env.HUMAN_BROWSER_RESERVED === '1') {
      providerFixture.state.offline = false;
      const { chromium } = require('playwright-core');
      const browser = await chromium.launch({ executablePath: process.env.HUMAN_BROWSER_EXECUTABLE,
        headless: true, args: ['--no-proxy-server'] });
      try {
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
        const tab = await context.newPage(); await tab.goto(site);
        check(await tab.evaluate(async () => (await fetch('/protected')).status), 200);
        check(await page.evaluate(async prefix => (await fetch(prefix + '/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, PREFIX), 403);
        check(await page.evaluate(async prefix => {
          const state = await (await fetch(prefix + '/session')).json();
          return (await fetch(prefix + '/logout', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ns-csrf': state.csrf }, body: '{}' })).status;
        }, PREFIX), 200);
        check(await tab.evaluate(async () => (await fetch('/protected')).status), 401);
        await page.goto(site + '/protected'); await page.goBack();
        check(await page.evaluate(async () => (await fetch('/protected', { cache: 'no-store' })).status), 401);
        await context.close();
        counts.browser = 'actual-chromium-cookie-https-source-store';
      } finally { await browser.close(); }
    }
    result = { kind: 'actual-https-synthetic-provider-source-store', ...counts, verdict: 'pass' };
  } catch (error) { primary = error; }
  finally {
    clearTimeout(deadline);
    try {
      await closeOwned({ servers, sockets, socketClosures, onDeadline: error => {
        if (primary) console.error(primary.name + ': ' + primary.message);
        console.error(error.message); process.exit(1);
      } });
      assert.equal(timedOut, false, 'fixture exceeded its reserved active deadline');
      console.log(JSON.stringify({ cleanup: 'closed', listeners: servers.length }));
    } catch (error) { cleanupError = error; }
  }
  if (primary && cleanupError) throw new AggregateError([primary, cleanupError], 'Fixture operation and cleanup failed');
  if (primary || cleanupError) throw primary || cleanupError;
  console.log(JSON.stringify(result));
}

if (require.main === module) run().catch(error => { console.error(error.name + ': ' + error.message); process.exitCode = 1; });
module.exports = { run, closeOwned, assertPort };
