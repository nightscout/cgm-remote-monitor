'use strict';

// Opt-in native HTTPS transport acceptance with a synthetic provider. Every
// invocation requires explicit native persistence, Transit and bounded stage.
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
const fixture = require('./fixtures/human-oidc-provider');

function assertPort (port) {
  if ([18080, 18081, 18082].includes(port)) throw new Error('Fixture assigned a reserved port');
}

function fixtureOrigins (siteListener, issuerListener, { owner = false, browser = false } = {}) {
  const site = new URL(siteListener), issuer = new URL(issuerListener);
  // Real owner hostname resolution refuses IP selectors. Keep distinct cookie
  // hosts for the provider in both modes; ports alone cannot isolate cookies.
  if (owner) site.hostname = 'localhost';
  else if (browser) issuer.hostname = 'localhost';
  return { site: site.origin, issuer: issuer.origin };
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

function admitOwnerExtension (createOwnerExtension, source = process.env) {
  if (createOwnerExtension === undefined) return;
  if (typeof createOwnerExtension !== 'function' || typeof createOwnerExtension.admit !== 'function' ||
      source.HUMAN_HTTPS_RESERVED !== '1' || source.HUMAN_SESSION_NATIVE_RESERVED !== '1' ||
      source.HUMAN_HTTP_STORE !== 'postgres' || !source.HUMAN_HTTP_SIGNER_CONFIG ||
      !source.HUMAN_SESSION_PG_ADMIN_URL || !source.HUMAN_SESSION_PG_APP_URL) {
    throw new Error('Owner extension requires explicit reserved native PostgreSQL and Transit configuration');
  }
  // Pure, synchronous admission checks all extension-specific owned inputs
  // before this harness reads TLS material or acquires any runtime resource.
  const admitted = createOwnerExtension.admit();
  if (admitted && typeof admitted.then === 'function') throw new Error('Owner extension admission must be synchronous');
}

function admitNativeStage (stage, source = process.env, at = Date.now()) {
  const owner = stage?.id?.startsWith('owner-');
  if (!stage || !['mongo-http', 'owner-consumer', 'owner-authority', 'owner-browser', 'owner-compatibility'].includes(stage.id) ||
      stage.persistence !== (owner ? 'postgres' : 'mongo') || stage.signing !== 'configured-transit' ||
      stage.activeMs !== 120000 || stage.cleanupMs !== 15000 ||
      stage.transportMs !== (stage.id === 'owner-authority' ? 8000 : 5000) ||
      !Number.isSafeInteger(stage.activeEndsAt) || stage.activeEndsAt <= at || stage.activeEndsAt > at + stage.activeMs ||
      !Number.isSafeInteger(stage.cleanupEndsAt) || stage.cleanupEndsAt < stage.activeEndsAt ||
      stage.cleanupEndsAt > stage.activeEndsAt + stage.cleanupMs ||
      source.HUMAN_HTTPS_RESERVED !== '1' || source.HUMAN_SESSION_NATIVE_RESERVED !== '1' || source.HUMAN_VAULT_RESERVED !== '1' ||
      source.HUMAN_HTTP_STORE !== stage.persistence || !source.HUMAN_HTTP_SIGNER_CONFIG ||
      (stage.persistence === 'mongo' ? !source.HUMAN_SESSION_MONGO_URL : !source.HUMAN_SESSION_PG_ADMIN_URL || !source.HUMAN_SESSION_PG_APP_URL) ||
      stage.browser !== ['mongo-http', 'owner-browser'].includes(stage.id) ||
      stage.browser && (source.HUMAN_BROWSER_RESERVED !== '1' || !source.HUMAN_BROWSER_EXECUTABLE)) {
    throw new Error('NATIVE_HTTPS_COMPLETE_STAGE_REQUIRED');
  }
  return true;
}

async function closeOwnerAndNative (ownerExtension, nativeStore) {
  const errors = [];
  // Owner stores depend on the shared native schemas. Drain them before the
  // native fixture drops those schemas, including when owner cleanup refuses.
  for (const resource of [ownerExtension, nativeStore]) {
    if (!resource) continue;
    try { await resource.close(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new globalThis.AggregateError(errors, 'Owner and native fixture cleanup failed');
}

async function run ({ createOwnerExtension, createSingleExtension, nativeStage } = {}) {
  if (process.env.HUMAN_HTTPS_RESERVED !== '1') throw new Error('Explicit one-run HTTPS reservation required');
  admitOwnerExtension(createOwnerExtension);
  admitNativeStage(nativeStage);
  if (nativeStage.id.startsWith('owner-') !== (typeof createOwnerExtension === 'function') ||
      (nativeStage.id === 'mongo-http') !== (typeof createSingleExtension === 'function')) {
    throw new Error('NATIVE_HTTPS_REQUIRED_EXTENSION_MISSING');
  }
  if (createSingleExtension) {
    if (typeof createSingleExtension.admit !== 'function') throw new Error('NATIVE_SINGLE_ADMISSION_REQUIRED');
    createSingleExtension.admit();
  }
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
    deadlineExit = setTimeout(() => { console.error('Fixture active deadline and absolute cleanup exceeded'); process.exit(1); },
      Math.max(1, nativeStage.cleanupEndsAt - Date.now()));
  }, Math.max(1, nativeStage.activeEndsAt - Date.now()));
  const counts = { assertions: 0 };
  let result;
  let primary, cleanupError;
  let nativeStore, ownerExtension;
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
  const children = new Set();
  function registerChild (child, metadata) {
    if (!child || typeof child.once !== 'function' || !Number.isSafeInteger(child.pid) ||
        !metadata || metadata.kind !== 'client' || metadata.label !== 'oref0-ns-get' || children.size) {
      throw new Error('NATIVE_CHILD_BINDING_REFUSED');
    }
    const record = { child, closed: false };
    record.closedPromise = new Promise(resolve => child.once('close', () => { record.closed = true; children.delete(record); resolve(); }));
    children.add(record);
    console.log(JSON.stringify({ event: 'owned-child', pid: child.pid, kind: metadata.kind, label: metadata.label }));
    return record.closedPromise;
  }
  async function closeChildren () {
    const waitClosed = async (record, milliseconds) => {
      let timer;
      try { return await Promise.race([record.closedPromise.then(() => true), new Promise(resolve => {
        timer = setTimeout(() => resolve(false), Math.max(1, Math.min(milliseconds, nativeStage.cleanupEndsAt - Date.now())));
      })]); } finally { clearTimeout(timer); }
    };
    for (const record of [...children]) {
      if (record.closed) continue;
      // Pinned client creates its own process group; terminate descendants too.
      const kill = signal => { try { process.kill(-record.child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
      kill('SIGTERM');
      if (!await waitClosed(record, 1000)) { kill('SIGKILL');
        if (!await waitClosed(record, 1000)) throw new Error('NATIVE_CHILD_EXIT_UNOBSERVED'); }
    }
  }
  async function listenOwned (handler, { plane, tenant: selected, host = 'localhost' } = {}) {
    if (!['data', 'operator', 'single'].includes(plane) || !['localhost', '127.0.0.1'].includes(host) ||
        typeof selected !== 'string' || servers.length >= 12) throw new Error('NATIVE_LISTENER_BINDING_REFUSED');
    const address = new URL(await listen(handler)); address.hostname = host;
    allowed.add(address.origin);
    return address.origin;
  }
  async function transport (input, options = {}) {
    const request = input instanceof Request ? input : new Request(input, options), url = new URL(request.url);
    if (!allowed.has(url.origin)) throw new Error('Fixture outbound URL refused');
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer());
    return new Promise((resolve, reject) => {
      const req = https.request(url, { method: request.method, headers: Object.fromEntries(request.headers), ca: tls.cert, family: 4,
        timeout: nativeStage.transportMs, signal: AbortSignal.timeout(Math.max(1, Math.min(nativeStage.transportMs, nativeStage.activeEndsAt - Date.now()))), agent: false }, res => {
        const chunks = []; let length = 0;
        res.once('error', reject); res.once('aborted', () => reject(new Error('Fixture TLS response aborted')));
        res.on('data', chunk => { length += chunk.length; if (length > 262144) req.destroy(new Error('Fixture response bound')); else chunks.push(chunk); });
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      });
      req.once('timeout', () => req.destroy(new Error('Fixture timeout'))); req.once('error', reject); req.end(body);
    });
  }
  try {
    const siteListener = await listen((req, res) => mounted ? mounted(req, res) : res.writeHead(503).end());
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
    const { site, issuer } = fixtureOrigins(siteListener, issuerListener, {
      owner: !!createOwnerExtension, browser: process.env.HUMAN_BROWSER_RESERVED === '1'
    });
    allowed.add(site); allowed.add(issuer);
    providerFixture = await fixture({ issuer, redirectUri: site + PREFIX + '/callback' });
    const provider = await createProvider({ ...providerFixture, fetch: transport });
    const persistence = nativeStage.persistence;
    const tenant = persistence === 'postgres' ? '11111111-1111-4111-8111-111111111111' : 'single';
    const subject = 'synthetic-subject';
    const access = require('../lib/human-session/access-config').loadHumanAccess({ mode: tenant === 'single' ? 'single' : 'multi',
      tenants: [tenant], source: { ...process.env, OIDC_ACCESS_CONFIG: process.env.HUMAN_HTTP_SIGNER_CONFIG } });
    const acceptedKeys = access.keyBindings.map(({ kid, purpose }) => ({ kid, purpose, active: true }));
    nativeStore = await require('./fixtures/human-native-stores').createNativeStore({
      kind: persistence, tenant, issuer, providerSubject: subject, providerSession: 'synthetic-provider-session', acceptedKeys });
    const engine = createEngine({ store: nativeStore.store, access });
    const workerB = createEngine({ store: await nativeStore.createWorkerStore(), access });
    const http = createHumanHTTP({ engine, provider, resolver: { resolve: async () => tenant }, originFor: () => site, cookieKey: randomBytes(32) });
    const app = express(); app.use(PREFIX, http.router);
    app.get('/', (req, res) => res.set('Cache-Control', 'no-store').type('html').send('<!doctype html><title>Synthetic session fixture</title><p>Session acceptance fixture</p>'));
    app.get('/protected', async (req, res) => {
      try { const supplied = http.credential(req); await workerB.authenticate({ tenant, token: supplied?.token, purpose: 'data' }); res.json({ allowed: true }); }
      catch (error) { res.status(error.code === 'HUMAN_SESSION_UNAVAILABLE' ? 503 : 401).json({ allowed: false }); }
    });
    if (createOwnerExtension || createSingleExtension) {
      ownerExtension = await (createOwnerExtension || createSingleExtension)({ nativeStore, human: http, access, tenant, origin: site,
        stage: nativeStage, binding: { persistence, signing: 'configured-transit' }, listenOwned, registerChild,
        remainingActiveMs: () => Math.max(0, nativeStage.activeEndsAt - Date.now()) });
      if (!ownerExtension || typeof ownerExtension.router !== 'function' ||
          typeof ownerExtension.exercise !== 'function' || typeof ownerExtension.close !== 'function') {
        throw new Error('Owner extension requires a router, exercise and owned close');
      }
      console.log(JSON.stringify({ event: 'owned-extension-custody', stage: nativeStage.id,
        resources: ownerExtension.custody ? ownerExtension.custody() : ownerExtension.manifest }));
      app.use(ownerExtension.router);
    }
    mounted = app;
    const json = (path, body, headers = {}) => transport(site + PREFIX + path, { method: 'POST',
      headers: { origin: site, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    async function login (mode, purpose = 'data') {
      const started = await json('/login', { transport: mode, purpose }); check(started.status, 200);
      const flowCookie = started.headers.get('set-cookie').split(';')[0]; assert(flowCookie.startsWith(FLOW + '-'));
      const location = (await started.json()).location;
      const authorize = await transport(location); check(authorize.status, 303);
      return transport(authorize.headers.get('location'), { headers: { cookie: flowCookie } });
    }
    if (ownerExtension) counts.owner = await ownerExtension.exercise({ transport, site, login, check, providerFixture });
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
    if (nativeStage.browser) {
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
        assert.equal(access.accepts(direct), true); access.verify({ tenant, token: direct }); counts.assertions++;
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
        if (ownerExtension?.exerciseBrowser) {
          const ownerContext = await browser.newContext({ ignoreHTTPSErrors: true });
          try {
            await ownerContext.route('**/*', route => allowed.has(new URL(route.request().url()).origin) ? route.continue() : route.abort());
            const ownerPage = await ownerContext.newPage();
            counts.ownerBrowser = await ownerExtension.exerciseBrowser({ browserContext: ownerContext, page: ownerPage,
              site, providerFixture, check });
          } finally { await ownerContext.close(); }
        }
    }
    result = { kind: 'actual-https-synthetic-provider', stage: nativeStage.id, persistence,
      accessSigning: 'configured-transit', ...counts, verdict: 'pass' };
  } catch (error) { primary = error; }
  finally {
    clearTimeout(deadline);
    try {
      const resources = [{ close: async () => {
        const errors = [];
        // Sequential dependency teardown: browser/client users first, then
        // extension pools/private schemas, then the shared native store.
        for (const close of [
          () => ownedBrowserServer && closeBrowser(ownedBrowserServer), closeChildren,
          () => closeOwnerAndNative(ownerExtension, nativeStore)
        ]) { try { await close(); } catch (error) { errors.push(error); } }
        if (errors.length) throw new globalThis.AggregateError(errors, 'Native dependency cleanup failed');
      } }];
      await closeOwned({ servers, sockets, socketClosures, resources,
        timeoutMs: Math.max(1, nativeStage.cleanupEndsAt - Date.now()), onDeadline: () => {
        if (primary) console.error('Native stage failed before cleanup deadline');
        if (ownedBrowserServer) ownedBrowserServer.kill().catch(() => {});
        console.error('Native stage absolute cleanup deadline exceeded'); process.exit(1);
      } });
      assert.equal(timedOut, false, 'fixture exceeded its reserved active deadline');
      console.log(JSON.stringify({ cleanup: 'closed', listeners: servers.length + (ownedBrowserServer ? 1 : 0) }));
    } catch (error) { cleanupError = error; }
    finally { clearTimeout(deadlineExit); }
  }
  if (primary && cleanupError) throw new globalThis.AggregateError([primary, cleanupError], 'Fixture operation and cleanup failed');
  if (primary || cleanupError) throw primary || cleanupError;
  console.log(JSON.stringify(result));
  return result;
}

if (require.main === module) run().catch(error => {
  const failures = error.errors || [error];
  for (const failure of failures) console.error(JSON.stringify({ error: failure.code || failure.name }));
  process.exit(1);
});
module.exports = { run, closeOwned, closeBrowser, assertPort, admitOwnerExtension, closeOwnerAndNative, fixtureOrigins, admitNativeStage };
