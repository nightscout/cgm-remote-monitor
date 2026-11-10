'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
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

// In-memory HTTP wire model: no listener, DNS or external request is opened.
// Explicit Host is forwarded as node:http does in the selected-image proof;
// the old fetch counterfactual selects the URL authority instead.
function wireLaboratory (lab) {
  const original = { request: http.request, fetch: global.fetch, timeout: AbortSignal.timeout };
  const wire = [], clocks = [];
  let now = 0, mode = 'normal', response, destroyed = 0, headersReady;
  const firstHeaders = new Promise(resolve => { headersReady = resolve; });
  const dispatch = async (url, options) => lab.config.tenants.some(tenant => tenant.host === options.headers.host)
    ? lab.fetchImpl(url, options) : { status: 403, json: async () => ({ status: 403 }), body: { cancel: async () => {} } };
  global.fetch = async (url, options) => dispatch(url, { ...options, headers: { ...options.headers, host: new URL(url).host } });
  AbortSignal.timeout = milliseconds => {
    assert.equal(milliseconds, 10000);
    const controller = new AbortController();
    clocks.push({ controller, deadline: now + milliseconds });
    return controller.signal;
  };
  http.request = (url, options, callback) => {
    assert(options.signal instanceof AbortSignal, 'the original absolute deadline must reach node:http');
    assert.equal(options.agent, false);
    const record = { url, options, started: now };
    wire.push(record);
    const req = new EventEmitter();
    req.destroy = () => { destroyed++; };
    options.signal.addEventListener('abort', () => {
      response?.destroy(); req.emit('error', new Error('private transport ' + url));
    }, { once: true });
    req.end = body => {
      record.body = body;
      if (mode === 'transport-error') return req.emit('error', new Error('private transport ' + url));
      if (mode === 'headers') return;
      Promise.resolve().then(async () => {
        const result = mode === 'redirect' ? { status: 302, json: async () => ({}) } : await dispatch(url, { ...options, body });
        const res = response = new EventEmitter();
        let closed = false;
        res.statusCode = result.status;
        res.destroy = () => { closed = true; destroyed++; };
        callback(res);
        if (mode === 'body') { res.emit('data', Buffer.from('{')); headersReady(); return; }
        const raw = mode === 'limit' ? '"' + 'x'.repeat(1024 * 1024) + '"'
          : mode === 'json-error' ? 'private malformed ' + lab.env.A_TOKEN : JSON.stringify(await result.json());
        res.emit('data', Buffer.from(raw));
        if (!closed) res.emit('end');
        headersReady();
      }).catch(error => req.emit('error', error));
    };
    return req;
  };
  return { wire, clocks, firstHeaders, setMode: value => { mode = value; }, destroyed: () => destroyed,
    chunk: value => response.emit('data', Buffer.from(value)),
    tick: milliseconds => {
      now += milliseconds;
      for (const clock of clocks) if (clock.deadline <= now && !clock.controller.signal.aborted) clock.controller.abort(new Error('private deadline ' + lab.env.A_TOKEN));
    },
    restore: () => { http.request = original.request; global.fetch = original.fetch; AbortSignal.timeout = original.timeout; } };
}

function omittedTransport (before, after) {
  const filename = require.resolve('../deploy/multitenant/demo');
  const original = fs.readFileSync(filename, 'utf8'), source = original.replaceAll(before, after);
  assert.notEqual(source, original, 'the omission must change the actual demo source');
  const module = { exports: {} };
  vm.runInNewContext(source, { module, require: createRequire(filename), process, Buffer, AbortSignal, fetch: global.fetch }, { filename });
  return module.exports;
}

describe('Compose demo private node:http transport', function () {
  let lab, wire;
  beforeEach(async function () { lab = await laboratory(); wire = wireLaboratory(lab); });
  afterEach(function () { wire.restore(); });
  const ordinary = async (client, lab) => assert.equal((await client.request(lab.config, lab.config.tenants[0], '/api/v3/entries', { env: lab.env })).status, 200);

  it('uses the actual default transport for Host-routed exchange and API3 with unchanged method/body and tenant-local JWT', async function () {
    const tenant = lab.config.tenants[0], body = { sgv: 123 };
    await demo.request(lab.config, tenant, '/api/v3/entries/synthetic', { env: lab.env, method: 'PUT', body });
    assert.equal(wire.wire.length, 2);
    assert.equal(wire.wire[0].options.headers.host, tenant.host);
    assert.equal(wire.wire[0].options.method, 'GET');
    assert.equal(wire.wire[1].options.headers.host, tenant.host);
    assert.equal(wire.wire[1].options.method, 'PUT');
    assert.equal(wire.wire[1].body, JSON.stringify(body));
    assert.equal(new URL(wire.wire[0].url).hostname, 'api');
    assert.equal(new URL(wire.wire[0].url).pathname, '/api/v2/authorization/request/' + encodeURIComponent(lab.env.A_TOKEN));
    const token = wire.wire[1].options.headers.authorization.slice(7);
    assert.equal((await lab.access(A, token)).principal, SUBJECT);
    assert.equal(await lab.access(B, token), null);
    assert.equal(wire.wire[1].options.headers['api-secret'], undefined);
  });

  it('makes default-transport and Host-assignment omissions red, then restores ordinary access', async function () {
    await ordinary(demo, lab);
    const oldFetch = omittedTransport('fetchImpl = privateFetch', 'fetchImpl = fetch');
    await assert.rejects(ordinary(oldFetch, lab), { code: 'COMPOSE_DEMO_EXCHANGE_REFUSED' });
    await ordinary(demo, lab);
    const noHost = omittedTransport('headers: options.headers', 'headers: { ...options.headers, host: undefined }');
    await assert.rejects(ordinary(noHost, lab), { code: 'COMPOSE_DEMO_EXCHANGE_REFUSED' });
    await ordinary(demo, lab);
  });

  it('refuses a wrong tenant Host without issuing or substituting credentials', async function () {
    const wrongTenant = omittedTransport('headers: options.headers', "headers: { ...options.headers, host: 'two.example.test' }");
    await assert.rejects(ordinary(wrongTenant, lab), { code: 'COMPOSE_DEMO_EXCHANGE_REFUSED' });
    assert.equal(wire.wire.length, 1);
    await ordinary(demo, lab);
  });

  it('does not follow redirects and redacts transport/JSON failures', async function () {
    for (const [mode, code] of [['redirect', 'COMPOSE_DEMO_EXCHANGE_REFUSED'], ['transport-error', 'COMPOSE_DEMO_EXCHANGE_UNAVAILABLE'], ['json-error', 'COMPOSE_DEMO_EXCHANGE_SHAPE']]) {
      wire.setMode(mode);
      const before = wire.wire.length;
      await assert.rejects(ordinary(demo, lab), error => {
        assert.equal(error.code, code);
        assert(!String(error.stack).includes(lab.env.A_TOKEN));
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(wire.wire.length, before + 1, 'a refused exchange cannot follow a redirect or reach API3');
    }
    wire.setMode('normal'); await ordinary(demo, lab);
  });

  it('bounds response bytes before JSON parsing, and detects omission of that bound', async function () {
    wire.setMode('limit');
    await assert.rejects(ordinary(demo, lab), { code: 'COMPOSE_DEMO_EXCHANGE_UNAVAILABLE' });
    assert(wire.destroyed() > 0);
    const noLimit = omittedTransport('bytes > 1024 * 1024', 'false');
    await assert.rejects(ordinary(noLimit, lab), { code: 'COMPOSE_DEMO_EXCHANGE_SHAPE' });
    await assert.rejects(ordinary(demo, lab), { code: 'COMPOSE_DEMO_EXCHANGE_UNAVAILABLE' });
  });

  for (const mode of ['headers', 'body']) it('keeps one absolute ten-second deadline through ' + mode + ', including streaming progress', async function () {
    wire.setMode(mode);
    const pending = ordinary(demo, lab);
    const refused = assert.rejects(pending, error => {
      assert.equal(error.code, 'COMPOSE_DEMO_EXCHANGE_UNAVAILABLE');
      assert(!String(error.stack).includes(lab.env.A_TOKEN));
      return true;
    });
    if (mode === 'body') await wire.firstHeaders;
    assert.equal(wire.clocks.length, 1);
    wire.tick(9000);
    if (mode === 'body') wire.chunk(' ');
    wire.tick(999);
    assert.equal(wire.clocks[0].controller.signal.aborted, false);
    if (mode === 'body') wire.chunk(' ');
    wire.tick(1);
    await refused;
    assert.equal(wire.wire.length, 1);
  });
});

describe('Compose role health uses the lifecycle participant contract', function () {
  async function check (mutateReply = reply => reply) {
    const file = require.resolve('../deploy/multitenant/health'), calls = [], facade = { argv: ['node', file, 'api'], exitCode: 0 };
    const source = fs.readFileSync(file, 'utf8');
    const nativeRequire = createRequire(file);
    const localRequire = name => {
      if (name === 'node:fs') return { lstatSync: () => ({ isSocket: () => true }) };
      if (name === 'node:net') return { connect: () => {
        const socket = new EventEmitter(); socket.setTimeout = () => {}; socket.end = () => {}; socket.destroy = () => {};
        queueMicrotask(() => socket.emit('connect')); return socket;
      } };
      if (name === '../../lib/server/internal-api/clients') return { lifecycleParticipant: options => {
        calls.push(options);
        return { getStatus: async body => { calls.push(body); return mutateReply({ request: body.request, participant: 'api', roles: ['api'] }); } };
      } };
      return nativeRequire(name);
    };
    vm.compileFunction(source, ['require', 'process'], { filename: file })(localRequire, facade);
    await new Promise(resolve => setImmediate(resolve));
    return { calls, code: facade.exitCode };
  }
  it('checks the exact lifecycle status acknowledgement and rejects another participant', async function () {
    const valid = await check(); assert.equal(valid.code, 0);
    assert.deepEqual(valid.calls[0], { socketPath: '/run/ns-ipc/cohort-api.sock', maxBytes: 1048576, timeoutMs: 1500 });
    assert.match(valid.calls[1].request, /^[0-9a-f-]{36}$/);
    assert.equal((await check(reply => ({ ...reply, participant: 'realtime' }))).code, 1);
    assert.equal((await check(reply => ({ ...reply, request: 'wrong' }))).code, 1);
  });
});
