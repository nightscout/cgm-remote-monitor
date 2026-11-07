'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const provider = require('./fixtures/tenant-credential-provider');
const { createSecrets } = require('../lib/secrets/component');
const extract = require('../lib/authorization/credential-extraction');
const createDataAccess = require('../lib/server/tenant-app/data-access');
const createExchange = require('../lib/server/tenant-app/exchange');
const { createTenantApp } = require('../lib/server/tenant-app');
const demo = require('../deploy/multitenant/demo');

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const SUBJECT = '000000000000000000000001';
const sha1 = value => crypto.createHash('sha1').update(value).digest('hex');

async function laboratory () {
  const records = new Map(), states = new Map([A, B].map(tenant => [tenant, {
    root: crypto.randomBytes(24).toString('hex'), provider: provider(), current: true, credentialPresent: true
  }]));
  let time = 1794000000000;
  const context = tenant => ({ tenant, principal: 'verifier', consumer: 'api' });
  const component = createSecrets({
    providerFor: async tenant => states.get(tenant).provider,
    store: { get: async (tenant, id) => records.get(tenant + ':' + id),
      insert: async record => records.set(record.tenant + ':' + record.id, record) },
    authorize: async () => true, audit: async () => {}, maxTokenLifetimeSeconds: 28800, now: () => time,
    legacyAuthorityFor: async tenant => ({ reference: { tenant, id: 'root' },
      subjects: states.get(tenant).credentialPresent ? [{ subjectId: SUBJECT, tokenPrefix: 'demo' }] : [] })
  });
  for (const [tenant, state] of states) await component.encrypt(context(tenant), 'root', Buffer.from(state.root));
  const authority = {
    authorize: async ({ tenant, principal }) => states.get(tenant).current && principal.kind === 'subject' && principal.subjectId === SUBJECT,
    subjectSnapshot: async ({ tenant, principal }) => states.get(tenant).current && principal.kind === 'subject' && principal.subjectId === SUBJECT
      ? { sub: 'Synthetic demo uploader', permissionGroups: [['api:entries:read', 'api:entries:create', 'api:entries:update']] } : null
  };
  const exchange = createExchange({ secrets: component, authority, verifierContext: async tenant => context(tenant) });
  const access = createDataAccess({ secrets: component, authority, verifierContext: async tenant => context(tenant), collections: ['entries'] });
  const config = { apiOrigin: 'http://api:1337', tenants: [
    { id: A, host: 'one.example.test', tokenEnv: 'A_TOKEN' }, { id: B, host: 'two.example.test', tokenEnv: 'B_TOKEN' }
  ] };
  const env = Object.fromEntries(config.tenants.map(tenant => [tenant.tokenEnv, 'demo-' + sha1(sha1(states.get(tenant.id).root) + SUBJECT).slice(0, 16)]));
  const unsupported = async () => { throw new Error('unselected test operation'); };
  const app = createTenantApp({ resolver: { resolve: async req => config.tenants.find(tenant => tenant.host === req.headers.host)?.id },
    verifyCredential: async () => null, authorizeRequest: async () => false, dataRouter: (req, res, next) => next(),
    tenantSettings: { read: unsupported, replace: unsupported, rollback: unsupported }, subjectPolicy: { read: unsupported, replace: unsupported }, exchange });
  // Invoke the actual registered HTTP exchange handler without opening a socket.
  const handler = app.router.stack.find(layer => layer.route?.path === '/api/v2/authorization/request/:accessToken').route.stack.at(-1).handle;
  async function httpExchange (tenant, credential) {
    let body, status = 200;
    const req = { headers: { host: tenant.host }, params: { accessToken: credential } };
    const res = { status (value) { status = value; return this; }, json (value) { body = value; return this; } };
    await handler(req, res, error => { throw error; });
    return { status, body };
  }
  function request (token, path = '/entries', method = 'GET', headers = {}) {
    return { path, method, query: {}, body: {}, rawHeaders: Object.entries({ authorization: 'Bearer ' + token, ...headers }).flat() };
  }
  const calls = [];
  const fetchImpl = async (address, options) => {
    const url = new URL(address), tenant = config.tenants.find(tenant => tenant.host === options.headers.host);
    assert(tenant, 'the request must retain its selected tenant Host');
    calls.push({ path: url.pathname, options, tenant: tenant.id });
    let result;
    if (url.pathname.startsWith('/api/v2/authorization/request/')) {
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.authorization, undefined);
      assert.equal(options.headers['api-secret'], undefined);
      result = await httpExchange(tenant, decodeURIComponent(url.pathname.slice('/api/v2/authorization/request/'.length)));
    } else {
      assert(url.pathname.startsWith('/api/v3/entries'));
      assert.equal(options.headers['api-secret'], undefined);
      const req = request(options.headers.authorization.slice('Bearer '.length), url.pathname.slice('/api/v3'.length), options.method);
      let actor;
      try { actor = await access({ tenant: tenant.id, request: req }); } catch (error) {
        if (error.code !== 'TENANT_DATA_FORBIDDEN') throw error;
      }
      result = actor ? { status: 200, body: { status: 200, result: [{ identifier: 'synthetic', sgv: 123 }] } }
        : { status: 403, body: { status: 403 } };
    }
    return { status: result.status, json: async () => structuredClone(result.body), body: { cancel: async () => {} } };
  };
  return { component, config, env, states, calls, fetchImpl, request, httpExchange,
    access: (tenant, token) => access({ tenant, request: request(token) }), advance: milliseconds => { time += milliseconds; } };
}

describe('Compose client uses the shipping legacy exchange before API3 Bearer', function () {
  let lab;
  beforeEach(async function () { lab = await laboratory(); });

  it('reproduces raw Bearer refusal through actual extraction, dataAccess and secrets, then restores proper exchange', async function () {
    assert.equal(extract(lab.request(lab.env.A_TOKEN), { version: 3 }).tokenCarrier, 'bearer');
    assert.equal(await lab.access(A, lab.env.A_TOKEN), null);
    const issued = await lab.httpExchange(lab.config.tenants[0], lab.env.A_TOKEN);
    assert.equal(issued.status, 200);
    assert.deepEqual(Object.keys(issued.body).sort(), ['exp', 'iat', 'permissionGroups', 'sub', 'token']);
    assert.equal(issued.body.exp - issued.body.iat, 28800);
    assert.equal((await lab.access(A, issued.body.token)).principal, SUBJECT);
    assert.equal(await lab.access(A, lab.env.A_TOKEN), null, 'raw-carrier control must remain refused');
    assert.equal((await lab.access(A, (await lab.httpExchange(lab.config.tenants[0], lab.env.A_TOKEN)).body.token)).principal, SUBJECT);
  });

  it('uses the actual HTTP exchange response and sends only its JWT to API3, separately per tenant and operation', async function () {
    for (const tenant of [lab.config.tenants[0], lab.config.tenants[1], lab.config.tenants[0]]) {
      assert.equal((await demo.request(lab.config, tenant, '/api/v3/entries', { env: lab.env, fetchImpl: lab.fetchImpl })).result[0].sgv, 123);
    }
    assert.equal(lab.calls.length, 6);
    for (let i = 0; i < lab.calls.length; i += 2) {
      const issuer = lab.calls[i], api = lab.calls[i + 1];
      const selected = lab.config.tenants.find(tenant => tenant.id === issuer.tenant);
      assert.equal(issuer.path, '/api/v2/authorization/request/' + encodeURIComponent(lab.env[selected.tokenEnv]));
      assert.equal(api.tenant, issuer.tenant);
      assert.notEqual(api.options.headers.authorization, 'Bearer ' + lab.env[selected.tokenEnv]);
      assert.equal((await lab.access(issuer.tenant, api.options.headers.authorization.slice(7))).principal, SUBJECT);
    }
    assert.equal(await lab.access(B, lab.calls[1].options.headers.authorization.slice(7)), null);
    assert.equal(await lab.access(A, lab.calls[3].options.headers.authorization.slice(7)), null);
  });

  it('checks current subject authority and credential metadata without stale JWT fallback, then restores ordinary access', async function () {
    const tenant = lab.config.tenants[0];
    await demo.request(lab.config, tenant, '/api/v3/entries', { env: lab.env, fetchImpl: lab.fetchImpl });
    const issued = lab.calls[1].options.headers.authorization.slice(7);
    lab.states.get(A).current = false;
    await assert.rejects(lab.access(A, issued), { code: 'TENANT_DATA_FORBIDDEN' });
    await assert.rejects(demo.request(lab.config, tenant, '/api/v3/entries', { env: lab.env, fetchImpl: lab.fetchImpl }), { code: 'COMPOSE_DEMO_EXCHANGE_REFUSED' });
    assert.equal(lab.calls.length, 3, 'a refused exchange must not reach API3');
    lab.states.get(A).current = true;
    lab.states.get(A).credentialPresent = false;
    assert.equal(await lab.access(A, issued), null);
    await assert.rejects(demo.request(lab.config, tenant, '/api/v3/entries', { env: lab.env, fetchImpl: lab.fetchImpl }), { code: 'COMPOSE_DEMO_EXCHANGE_REFUSED' });
    lab.states.get(A).credentialPresent = true;
    assert.equal((await demo.request(lab.config, tenant, '/api/v3/entries', { env: lab.env, fetchImpl: lab.fetchImpl })).status, 200);
  });

  it('refuses cross-tenant legacy input and expires issued credentials without changing the issuer contract', async function () {
    const tenant = lab.config.tenants[0];
    await assert.rejects(demo.request(lab.config, tenant, '/api/v3/entries', { env: { ...lab.env, A_TOKEN: lab.env.B_TOKEN }, fetchImpl: lab.fetchImpl }), { code: 'COMPOSE_DEMO_EXCHANGE_REFUSED' });
    const issued = await lab.httpExchange(tenant, lab.env.A_TOKEN);
    lab.advance(28800000);
    assert.equal(await lab.access(A, issued.body.token), null);
    assert.equal((await demo.request(lab.config, tenant, '/api/v3/entries', { env: lab.env, fetchImpl: lab.fetchImpl })).status, 200);
  });

  it('redacts credential-bearing exchange transport/JSON failures and refuses an API3-shaped exchange response', async function () {
    const tenant = lab.config.tenants[0];
    for (const [fetchImpl, code] of [
      [async url => { throw new Error(url); }, 'COMPOSE_DEMO_EXCHANGE_UNAVAILABLE'],
      [async url => ({ status: 200, json: async () => { throw new Error(url); } }), 'COMPOSE_DEMO_EXCHANGE_SHAPE'],
      [async () => ({ status: 200, json: async () => ({ status: 200, result: { token: lab.env.A_TOKEN } }) }), 'COMPOSE_DEMO_EXCHANGE_SHAPE']
    ]) {
      await assert.rejects(demo.request(lab.config, tenant, '/api/v3/entries', { env: lab.env, fetchImpl }), error => {
        assert.equal(error.code, code);
        assert(!String(error.stack).includes(lab.env.A_TOKEN));
        assert.equal(error.cause, undefined);
        return true;
      });
    }
    assert.equal((await demo.request(lab.config, tenant, '/api/v3/entries', { env: lab.env, fetchImpl: lab.fetchImpl })).status, 200);
  });

  it('redacts API transport failure after the exchange and never substitutes an api-secret carrier', async function () {
    const tenant = lab.config.tenants[0];
    let issued;
    const fetchImpl = async (url, options) => {
      if (url.includes('/api/v2/authorization/request/')) {
        const response = await lab.fetchImpl(url, options);
        issued = (await response.json()).token;
        return response;
      }
      assert.equal(options.headers['api-secret'], undefined);
      throw new Error('private token ' + issued);
    };
    await assert.rejects(demo.request(lab.config, tenant, '/api/v3/entries', { env: lab.env, fetchImpl }), error => {
      assert.equal(error.code, 'COMPOSE_DEMO_HTTP_UNAVAILABLE');
      assert(!String(error.stack).includes(issued));
      return true;
    });
  });
});
