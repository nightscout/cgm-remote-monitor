'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { randomBytes } = require('node:crypto');
const { createHumanHTTP, credential, COOKIE, MANAGEMENT_COOKIE, FLOW, PREFIX } = require('../lib/human-session/http');
const { createProvider } = require('../lib/human-session/provider');
const fixture = require('./fixtures/human-oidc-provider');
const humanAccessFixture = require('./fixtures/human-access-issuer');

// Real Express router/body parser and real protocol adapter over synthetic HTTP
// Request/Response transport. This helper never opens a socket; browser, native
// persistence and deployed-provider claims require their separate acceptance.
function request (router, { method = 'GET', path, headers = {}, body, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const data = rawBody === undefined ? (body === undefined ? '' : JSON.stringify(body)) : rawBody;
    const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    if (data) {
      lower['content-type'] ||= 'application/json';
      lower['content-length'] = String(Buffer.byteLength(data));
    }
    const req = Readable.from(data ? [Buffer.from(data)] : []);
    Object.assign(req, { method, url: path, originalUrl: PREFIX + path, headers: lower,
      rawHeaders: Object.entries(lower).flat(), query: Object.fromEntries(new URL(path, 'https://nightscout.synthetic.invalid').searchParams) });
    const result = { status: 200, headers: {}, cookies: [], cleared: [] };
    const res = {
      headersSent: false,
      set (name, value) { result.headers[name.toLowerCase()] = value; return this; },
      status (value) { result.status = value; return this; },
      cookie (name, value, options) { result.cookies.push({ name, value, options }); return this; },
      clearCookie (name, options) { result.cleared.push({ name, options }); return this; },
      json (body) { result.body = body; this.headersSent = true; resolve(result); return this; },
      redirect (status, location) { result.status = status; result.location = location; this.headersSent = true; resolve(result); return this; }
    };
    router.handle(req, res, error => error ? reject(error) : resolve(result));
  });
}

describe('shared human OIDC HTTP boundary (Express without listening)', function () {
  this.timeout(10000);
  const tenant = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  const origin = 'https://nightscout.synthetic.invalid';
  let token, managementToken, profile, source, provider, service, calls, time, resolvedTenant, engine;

  beforeEach(async function () {
    time = Math.floor(Date.now() / 1000);
    resolvedTenant = tenant;
    calls = [];
    source = await fixture({ redirectUri: origin + PREFIX + '/callback' });
    provider = await createProvider(source);
    profile = humanAccessFixture({ tenant, now: () => time });
    async function issue (purpose) {
      return profile.access.issue({ tenant, subject: 'synthetic-subject', session: 'synthetic-' + purpose,
        purpose, credentialVersion: 1, issuedAt: time, expiresAt: time + 600 });
    }
    token = await issue('data'); managementToken = await issue('management');
    // Transport fake only; actual signature/profile validation is retained.
    // Durable/current-authority evidence belongs to engine/adapter acceptance.
    engine = {
      accepts: value => profile.access.accepts(value),
      async login (input) { calls.push(['login', input]); return { token: input.purpose === 'management' ? managementToken : token, expiresAt: time + 600, session: {
        id: 'synthetic-session', purpose: input.purpose, absoluteExpiresAt: input.purpose === 'management' ? time + 43200 : null
      } }; },
      async renew (input) { calls.push(['renew', input]); return { token, expiresAt: time + 600, session: { id: 'synthetic-session', purpose: 'data', absoluteExpiresAt: null } }; },
      async authenticate (input) {
        calls.push(['authenticate', input]);
        const claims = profile.access.verify({ tenant: input.tenant, token: input.token });
        if (claims.purpose !== input.purpose) throw Object.assign(new Error(), { code: 'HUMAN_SESSION_REFUSED' });
        return { session: { id: claims.sid, purpose: claims.purpose }, actor: { permissionGroups: [['api:entries:read']] } };
      },
      async logout (input) { calls.push(['logout', input]); profile.access.verify({ tenant: input.tenant, token: input.token, allowExpiredLookup: true }); }
    };
    service = createHumanHTTP({ engine, provider, resolver: { resolve: async () => resolvedTenant },
      originFor: () => origin, cookieKey: randomBytes(32), now: () => time });
  });

  async function start (body = {}, extra = {}) {
    const reply = await request(service.router, { method: 'POST', path: '/login', headers: { origin }, body, ...extra });
    assert.equal(reply.status, 200);
    const flow = reply.cookies.find(cookie => cookie.name.startsWith(FLOW + '-'));
    return { reply, flow, callback: new URL(source.authorize(reply.body.location)) };
  }
  function callback (flow, url) {
    return request(service.router, { path: url.pathname.slice(PREFIX.length) + url.search,
      headers: { cookie: flow.name + '=' + flow.value } });
  }

  it('requires same-origin POST to start login and seals browser/tenant state in a host cookie', async function () {
    for (const headers of [{}, { origin: 'https://foreign.synthetic.invalid' }, { origin, 'sec-fetch-site': 'cross-site' }]) {
      assert.equal((await request(service.router, { method: 'POST', path: '/login', headers, body: {} })).status, 403);
    }
    const { reply, flow } = await start({ purpose: 'management' });
    assert.deepEqual(flow.options, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 300000 });
    assert.ok(!flow.value.includes('management'));
    assert.equal(reply.headers['cache-control'], 'no-store');
    assert.equal(reply.headers['referrer-policy'], 'no-referrer');
  });

  it('consumes actual provider proof then issues default HttpOnly host cookie without a token in the URL', async function () {
    const flow = await start({ purpose: 'management' });
    const reply = await callback(flow.flow, flow.callback);
    assert.equal(reply.status, 303);
    assert.equal(reply.location, '/');
    const session = reply.cookies.find(cookie => cookie.name === MANAGEMENT_COOKIE);
    assert.equal(session.value, managementToken);
    assert.equal(session.options.httpOnly, true);
    assert.equal(session.options.secure, true);
    assert.equal(session.options.sameSite, 'strict');
    assert.equal(session.options.path, '/');
    assert.ok(reply.cleared.some(cookie => cookie.name.startsWith(FLOW + '-')));
    assert.equal(calls[0][0], 'login');
    assert.equal(calls[0][1].tenant, tenant);
    assert.equal(calls[0][1].purpose, 'management');
  });

  it('returns direct bearer only in a no-store response body and refuses callback/code replay', async function () {
    const flow = await start({ transport: 'bearer' });
    const first = await callback(flow.flow, flow.callback);
    assert.equal(first.status, 200);
    assert.equal(first.body.token, token);
    assert.equal(first.cookies.some(cookie => cookie.name === COOKIE), false);
    assert.equal((await callback(flow.flow, flow.callback)).status, 401);
    assert.equal(calls.filter(call => call[0] === 'login').length, 1);
  });

  it('refuses missing/tampered/expired flow and a foreign-tenant callback before creating authority', async function () {
    const flow = await start();
    const missing = await request(service.router, { path: '/callback' + flow.callback.search });
    assert.equal(missing.status, 401);
    assert.equal((await callback({ ...flow.flow, value: flow.flow.value + 'a' }, flow.callback)).status, 401);
    resolvedTenant = other;
    assert.equal((await callback(flow.flow, flow.callback)).status, 401);
    resolvedTenant = tenant;
    time += 300;
    assert.equal((await callback(flow.flow, flow.callback)).status, 401);
    assert.equal(calls.length, 0);
  });

  it('refuses cookie renewal/logout without same-origin CSRF, including non-ASCII header', async function () {
    const auth = { cookie: COOKIE + '=' + token };
    const state = await request(service.router, { path: '/session', headers: auth });
    assert.equal(state.status, 200);
    assert.ok(state.body.csrf);
    for (const csrf of ['', 'x'.repeat(state.body.csrf.length), 'é'.repeat(state.body.csrf.length)]) {
      const headers = { ...auth, origin, 'x-ns-csrf': csrf };
      const reply = await request(service.router, { method: 'POST', path: '/renew', headers, body: {} });
      assert.equal(reply.status, 403);
      assert.equal(reply.body.error, 'HUMAN_CSRF_REFUSED');
    }
    const reply = await request(service.router, { method: 'POST', path: '/renew',
      headers: { ...auth, origin, 'x-ns-csrf': state.body.csrf }, body: {} });
    assert.equal(reply.status, 200);
    assert.equal(new URL(reply.body.location).searchParams.get('prompt'), 'none');
    // Starting renewal neither authorizes data nor touches management idle.
    assert.equal(calls.filter(call => call[0] === 'authenticate').length, 1);
    assert.equal(calls.filter(call => call[0] === 'renew').length, 0);
  });

  it('renews only through provider proof with original selected local session', async function () {
    const reply = await request(service.router, { method: 'POST', path: '/renew',
      headers: { origin, authorization: 'Bearer ' + token }, body: { transport: 'bearer' } });
    const flow = reply.cookies.find(cookie => cookie.name.startsWith(FLOW + '-'));
    const result = await callback(flow, new URL(source.authorize(reply.body.location)));
    assert.equal(result.status, 200);
    assert.equal(calls[0][0], 'renew');
    assert.equal(calls[0][1].token, token);
  });

  it('isolates concurrent renewal proof cookies so both valid provider callbacks succeed', async function () {
    const begin = () => request(service.router, { method: 'POST', path: '/renew',
      headers: { origin, authorization: 'Bearer ' + token }, body: { transport: 'bearer' } });
    const starts = await Promise.all([begin(), begin()]);
    const flows = starts.map(reply => reply.cookies.find(cookie => cookie.name.startsWith(FLOW + '-')));
    assert.notEqual(flows[0].name, flows[1].name);
    const jar = flows.map(flow => flow.name + '=' + flow.value).join('; ');
    const callbacks = starts.map(reply => new URL(source.authorize(reply.body.location)));
    const replies = await Promise.all(callbacks.map(url => request(service.router, {
      path: url.pathname.slice(PREFIX.length) + url.search, headers: { cookie: jar }
    })));
    assert.deepEqual(replies.map(reply => reply.status), [200, 200]);
    assert.equal(calls.filter(call => call[0] === 'renew').length, 2);
  });

  it('keeps data and management cookies independent and logs out only the selected purpose', async function () {
    const jar = COOKIE + '=' + token + '; ' + MANAGEMENT_COOKIE + '=' + managementToken;
    const req = { headers: { cookie: jar }, rawHeaders: [] };
    assert.equal(credential(req).token, token);
    assert.equal(credential(req, { purpose: 'management' }).token, managementToken);
    const data = await request(service.router, { path: '/session', headers: { cookie: jar } });
    const management = await request(service.router, { path: '/session?purpose=management', headers: { cookie: jar } });
    assert.equal(data.status, 200);
    assert.equal(management.status, 200);
    assert.deepEqual(calls.filter(call => call[0] === 'authenticate').map(call => [call[1].token, call[1].purpose]),
      [[token, 'data'], [managementToken, 'management']]);
    const logout = await request(service.router, { method: 'POST', path: '/logout',
      headers: { cookie: jar, origin, 'x-ns-csrf': management.body.csrf }, body: { purpose: 'management' } });
    assert.equal(logout.status, 200);
    assert.equal(calls.find(call => call[0] === 'logout')[1].token, managementToken);
    assert.deepEqual(logout.cleared.map(cookie => cookie.name), [MANAGEMENT_COOKIE]);
    assert.equal(credential(req).token, token);
  });

  it('maps provider outage to unavailable and never calls session issuance', async function () {
    const flow = await start();
    source.state.offline = true;
    const reply = await callback(flow.flow, flow.callback);
    assert.equal(reply.status, 503);
    assert.equal(reply.body.error, 'OIDC_PROVIDER_UNAVAILABLE');
    assert.equal(calls.length, 0);
  });

  it('commits logout before browser clear/provider redirect and reports unconfirmed store failure', async function () {
    let invalidated = false;
    engine.logout = async () => { invalidated = true; };
    provider = { ...provider, logoutURL () { assert.equal(invalidated, true); return 'https://identity.synthetic.invalid/logout'; } };
    service = createHumanHTTP({ engine, provider, resolver: { resolve: async () => tenant },
      originFor: () => origin, cookieKey: randomBytes(32), now: () => time });
    const headers = { authorization: 'Bearer ' + token };
    const good = await request(service.router, { method: 'POST', path: '/logout', headers, body: {} });
    assert.equal(good.status, 200);
    assert.equal(good.body.local, 'revoked');
    assert.ok(good.cleared.some(cookie => cookie.name === COOKIE));
    engine.logout = async () => { throw Object.assign(new Error(), { code: 'HUMAN_SESSION_UNAVAILABLE' }); };
    const bad = await request(service.router, { method: 'POST', path: '/logout', headers, body: {} });
    assert.equal(bad.status, 503);
    assert.equal(bad.body.error, 'LOCAL_REVOCATION_UNCONFIRMED');
    assert.ok(bad.cleared.some(cookie => cookie.name === COOKIE));
  });

  it('returns request-invalid for malformed JSON and refuses malformed cookie instead of anonymous', async function () {
    const reply = await request(service.router, { method: 'POST', path: '/login', headers: { origin }, rawBody: '{invalid' });
    assert.equal(reply.status, 400);
    for (const value of ['', 'junk', token + ',extra']) {
      assert.throws(() => credential({ headers: { cookie: COOKIE + '=' + value }, rawHeaders: [] }), /HUMAN_/);
    }
  });

  it('discloses enabled/absent without inventing a session or permission groups', async function () {
    const reply = await request(service.router, { path: '/session' });
    assert.equal(reply.status, 401);
    assert.deepEqual(reply.body, { error: 'HUMAN_SESSION_ABSENT', enabled: true, credentialPresent: false });
    assert.equal(calls.length, 0);
  });

  it('returns transport CSRF without grants for an actually expired signed selector, and requires new provider proof for renewal', async function () {
    const parts = token.split('.');
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    claims.iat = time - 1200; claims.nbf = claims.iat; claims.exp = time - 600;
    const input = parts[0] + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url');
    const expired = input + '.' + (await profile.keys.find(key => key.purpose === 'data').sign(Buffer.from(input))).toString('base64url');
    assert.equal(profile.access.accepts(expired), true);
    assert.throws(() => profile.access.verify({ tenant, token: expired }), { code: 'HUMAN_SESSION_REFUSED' });
    const auth = { cookie: COOKIE + '=' + expired };
    const probe = await request(service.router, { path: '/session', headers: auth });
    assert.equal(probe.status, 401);
    assert.equal(probe.body.credentialPresent, true);
    assert.match(probe.body.csrf, /^[A-Za-z0-9_-]{43}$/);
    for (const key of ['session', 'permissionGroups', 'provider']) assert.equal(Object.hasOwn(probe.body, key), false);
    const renewed = await request(service.router, { method: 'POST', path: '/renew',
      headers: { ...auth, origin, 'x-ns-csrf': probe.body.csrf }, body: {} });
    assert.equal(renewed.status, 200);
    assert.equal(new URL(renewed.body.location).searchParams.get('prompt'), 'none');
    assert.equal(calls.filter(call => call[0] === 'renew').length, 0, 'CSRF alone does not invoke provider-backed issuance');
    const logout = await request(service.router, { method: 'POST', path: '/logout',
      headers: { ...auth, origin, 'x-ns-csrf': probe.body.csrf }, body: {} });
    assert.equal(logout.status, 200);
    assert.equal(calls.find(call => call[0] === 'logout')[1].token, expired);
    assert.ok(logout.cleared.some(cookie => cookie.name === COOKIE));
  });

  it('returns CSRF without authority on current-grant refusal or store outage and never discloses it cross-origin', async function () {
    for (const [code, expected] of [['HUMAN_AUTHORITY_REFUSED', 403], ['HUMAN_SESSION_UNAVAILABLE', 503]]) {
      engine.authenticate = async () => { throw Object.assign(new Error(code), { code }); };
      const auth = { cookie: COOKIE + '=' + token };
      const probe = await request(service.router, { path: '/session', headers: auth });
      assert.equal(probe.status, expected);
      assert.equal(probe.body.enabled, true);
      assert.equal(probe.body.credentialPresent, true);
      assert.match(probe.body.csrf, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(probe.body.error, code);
      assert.equal(Object.hasOwn(probe.body, 'permissionGroups'), false);
      assert.equal(Object.hasOwn(probe.body, 'session'), false);
      const foreign = await request(service.router, { path: '/session', headers: { ...auth, origin: 'https://foreign.synthetic.invalid' } });
      assert.equal(foreign.status, 403);
      assert.equal(foreign.body.csrf, undefined);
    }
  });

  it('lets the same-origin browser clear malformed human material without authorizing it or falling back', async function () {
    const auth = { cookie: COOKIE + '=malformed-selector' };
    const probe = await request(service.router, { path: '/session', headers: auth });
    assert.equal(probe.status, 401);
    assert.equal(probe.body.error, 'HUMAN_COOKIE_REFUSED');
    assert.equal(probe.body.credentialPresent, true);
    assert.match(probe.body.csrf, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(calls.length, 0, 'strict access syntax refuses before the fake engine');
    const logout = await request(service.router, { method: 'POST', path: '/logout',
      headers: { ...auth, origin, 'x-ns-csrf': probe.body.csrf }, body: {} });
    assert.equal(logout.status, 401);
    assert.equal(logout.body.error, 'HUMAN_SESSION_REFUSED');
    assert.ok(logout.cleared.some(cookie => cookie.name === COOKIE));
    assert.equal(logout.body.local, undefined, 'a malformed selector never claims durable revocation');
  });

  it('refuses duplicate credentials and cross-origin browser requests while preserving Origin-less direct human bearer', async function () {
    assert.throws(() => credential({ headers: { cookie: COOKIE + '=' + token }, rawHeaders: ['Authorization', 'Bearer ' + token] }),
      /HUMAN_CREDENTIAL_AMBIGUOUS/);
    assert.throws(() => credential({ headers: {}, rawHeaders: ['Authorization', 'Bearer ' + token, 'Authorization', 'Bearer ' + token] }),
      /HUMAN_CREDENTIAL_AMBIGUOUS/);
    assert.throws(() => credential({ headers: { cookie: COOKIE + '=' + token + '; ' + COOKIE + '=' + token }, rawHeaders: [] }),
      /HUMAN_COOKIE_REFUSED/);
    const foreign = await request(service.router, { path: '/session', headers: { origin: 'https://foreign.synthetic.invalid', authorization: 'Bearer ' + token } });
    assert.equal(foreign.status, 403);
    const headless = await request(service.router, { path: '/session', headers: { authorization: 'Bearer ' + token } });
    assert.equal(headless.status, 200);
  });
});

module.exports = { request };
