'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const http = require('node:http'), { PassThrough } = require('node:stream');
const express = require('express');
const { createTenantApp } = require('../lib/server/tenant-app');
const createCache = require('../lib/server/serve/api-tenant-cache').create;
const rules = require('../lib/tenant-registry/rules');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const request = host => ({ rawHeaders: ['Host', host] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function httpRequest (app, { host = 'one.example.test', method = 'GET', body, rawHeaders } = {}) {
  const req = new http.IncomingMessage(new PassThrough());
  req.method = method; req.url = '/api/v3/entries'; req.headers = { host, authorization: 'Bearer synthetic' };
  req.rawHeaders = rawHeaders || ['Host', host, 'Authorization', 'Bearer synthetic'];
  if (body !== undefined) {
    req.headers['content-type'] = 'application/json'; req.headers['content-length'] = String(Buffer.byteLength(body));
    req.rawHeaders.push('Content-Type', 'application/json', 'Content-Length', req.headers['content-length']);
  }
  const res = new http.ServerResponse(req);
  const result = new Promise((resolve, reject) => {
    res.end = function (bytes) { this.finished = true; this.emit('finish'); resolve({ status: this.statusCode, body: JSON.parse(String(bytes)) }); };
    app(req, res, error => reject(error || new Error('Synthetic request had no response')));
  });
  let sent = false;
  return { result, send: () => { if (!sent) { sent = true; req.push(body); req.push(null); } } };
}

function tenantApp ({ resolver, verifyCredential = async () => null, prepareTenant = async () => {}, dataRouter = express.Router() }) {
  const unavailable = async () => null;
  return createTenantApp({ resolver, prepareTenant, verifyCredential, authorizeRequest: async () => true,
    tenantSettings: { read: unavailable, replace: unavailable, rollback: unavailable },
    subjectPolicy: { read: unavailable, replace: unavailable }, dataRouter });
}

// The api's registry view as preview-api.js composes it (decision
// deployment-signing-secret): the shared service LRU, a binding, the Vault
// provider for the tenant's one `data` key, and no registry token keys (the
// api verifies no `ns-access+jwt` data token; only the owner role reads
// management keys). Per-tenant metadata pinned through a request is therefore
// the binding, the environment and the data-key provider.
async function fixture ({ cache = createCache({ capacity: 1, concurrency: 2, pendingLimit: 2, waitMs: 1000 }), pin = true, options = {} } = {}) {
  const rows = new Map(); let revision = 1, underlying;
  for (const tenant of [A, B]) rows.set(tenant, { tenant, state: 'active', signingVersion: 1, keys: [] });
  const store = { revision: async () => String(revision), lookup: async host => {
    const tenant = host === 'one.example.test' ? A : host === 'two.example.test' ? B : undefined;
    return tenant ? { tenant, state: rows.get(tenant).state } : null;
  }, entry: async tenant => { const row = rows.get(tenant); return row ? { ...row } : null; } };
  const filename = require.resolve('../lib/server/serve/registry-tenants'), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => {
    if (name === '../../storage/postgres-connection') return async () => ({ end: async () => {} });
    if (name === '../../tenant-registry/postgres') return { create: () => store };
    if (name === '../../tenant-registry/resolver') return { createRegistryResolver (options) {
      underlying = require('../lib/tenant-registry/resolver').createRegistryResolver({ ...options, schedule: () => null, cancel: () => {} });
      return underlying;
    } };
    if (name === '../../secrets/vault-transit') return { createVaultTransit: options => ({ encryptionKey: options.encryptionKey }) };
    return Module.prototype.require.call(loaded, name);
  };
  let source = fs.readFileSync(filename, 'utf8');
  if (!pin) {
    const changed = source.replace('return current?.registry.entry.tenant === tenant ? current : undefined;', 'return undefined;');
    assert.notEqual(changed, source, 'pin-removal control must apply'); source = changed;
  }
  loaded._compile(source, filename);
  const view = await loaded.exports.create({ settings: { namespace: 'synthetic_registry', maxTenants: 10000, refreshMs: 1000 },
    connectionString: 'synthetic', binding: { principal: 'api', consumer: 'data' }, vault: {},
    environment: tenant => ({ tenant }), cache, ...options });
  return { view, cache, update: async (tenant, changes) => { rows.set(tenant, { ...rows.get(tenant), ...changes }); revision++; await underlying.poll(); },
    close: async () => { await view.close(); await cache.close(); } };
}

async function pinnedCriterion (pin = true) {
  const f = await fixture({ pin }), entered = deferred(), release = deferred();
  let pending;
  try {
    pending = f.view.resolver.runRequest(request('one.example.test'), async () => {
      const record = f.view.record(A);
      const service = await f.cache.load(record, () => ({ tenant: A }));
      entered.resolve(); await release.promise;
      assert.equal(f.view.bindings.get(A)?.tenant, A, 'IN_FLIGHT_REGISTRY_BINDING_MUST_SURVIVE_EVICTION');
      assert.equal(f.view.environments.get(A).tenant, A);
      assert.equal(f.view.providers.get(A).encryptionKey, rules.vaultKey(A, 'data'));
      assert.equal(f.view.record(A), record);
      assert.equal(record.service, service);
      assert.equal(f.view.bindings.has(B), true, 'other retained tenant remains addressable');
    });
    await entered.promise;
    await f.view.resolver.runRequest(request('two.example.test'), async () => {
      assert.equal(f.view.bindings.get(B).tenant, B);
      assert.equal(f.view.environments.get(B).tenant, B);
      assert.equal(f.view.bindings.get(A), undefined, 'request B must not borrow request A pin');
    });
    assert.equal(f.cache.stats().entries, 1); assert.equal(f.cache.peek(A), undefined);
    release.resolve(); await pending;
  } finally { release.resolve(); await pending?.catch(() => {}); await f.close(); }
}

describe('API registry metadata shares the service LRU', function () {
  it('pins current request metadata and service while another tenant evicts its record', () => pinnedCriterion());

  it('control: omitting request pinning loses the evicted binding, restored request pin passes', async function () {
    await assert.rejects(pinnedCriterion(false), /IN_FLIGHT_REGISTRY_BINDING_MUST_SURVIVE_EVICTION/);
    await pinnedCriterion();
  });

  it('uses the selected shared capacity for metadata and registry resolver caches', async function () {
    const f = await fixture();
    try {
      for (const host of ['one.example.test', 'two.example.test']) await f.view.resolver.resolve(request(host));
      assert.equal(f.view.stats().materialized, 1); assert.equal(f.view.stats().entries, 1); assert.equal(f.view.stats().cached, 1);
      assert.equal(f.view.humanRegistry.maxTenants, 1); assert.equal(f.view.record(A), undefined);
    } finally { await f.close(); }
  });

  it('coalesces concurrent first registry requests into one service record and build', async function () {
    const f = await fixture(), gate = deferred(); let builds = 0;
    try {
      const pending = Array.from({ length: 8 }, () => f.view.resolver.runRequest(request('one.example.test'), async () => {
        const record = f.view.record(A);
        return f.cache.load(record, async () => { builds++; await gate.promise; return { tenant: A }; });
      }));
      await new Promise(setImmediate); gate.resolve();
      const services = await Promise.all(pending);
      assert.equal(builds, 1, 'CONCURRENT_REGISTRY_MISS_MUST_BUILD_ONCE');
      for (const service of services) assert.equal(service, services[0]);
    } finally { gate.resolve(); await f.close(); }
  });

  it('replaces a service record when a registry revision changes its metadata', async function () {
    const f = await fixture();
    try {
      await f.view.prepare(A); const original = f.view.record(A), originalProvider = f.view.providers.get(A);
      await f.cache.load(original, () => ({ version: 1 }));
      // The signing version stays in the registry (revocation and rotation of
      // the derived keys); a new entry rebuilds the record and its provider.
      await f.update(A, { signingVersion: 2 }); await f.view.prepare(A);
      const current = f.view.record(A);
      assert.notEqual(current, original, 'REGISTRY_REVISION_MUST_REPLACE_RECORD'); assert.equal(current.service, undefined);
      assert.equal(current.registry.entry.signingVersion, 2);
      assert.notEqual(f.view.providers.get(A), originalProvider);
      assert.equal(f.view.providers.get(A).encryptionKey, rules.vaultKey(A, 'data'));
      assert.equal(original.service.version, 1, 'old in-flight object remains usable');
      await f.cache.load(current, () => ({ version: 2 }));
      assert.equal(current.service.version, 2);
    } finally { await f.close(); }
  });

  it('pins private operations by tenant and refuses cross-tenant rebinding', async function () {
    const f = await fixture();
    try {
      await f.view.run(A, async record => {
        await f.view.prepare(B); // materializes B but cannot replace the pin
        assert.equal(f.view.record(A), record); assert.equal(f.view.bindings.get(A).tenant, A);
        await assert.rejects(f.view.run(B, () => assert.fail('foreign callback must not run')), /Cannot rebind/);
        await f.view.run(A, nested => assert.equal(nested, record));
      });
      assert.equal(f.view.bindings.get(A), undefined, 'pin ends with the operation');
    } finally { await f.close(); }
  });

  it('refuses a removed tenant on the next operation', async function () {
    const f = await fixture();
    try {
      await f.view.run(A, () => assert.equal(f.view.bindings.get(A).tenant, A));
      await f.update(A, { state: 'removed' });
      await assert.rejects(f.view.run(A, () => assert.fail('removed callback must not run')), { code: 'TENANT_REMOVED' });
    } finally { await f.close(); }
  });

  it('preserves public resolver refusal responses with and without the request pin wrapper', async function () {
    const f = await fixture();
    try {
      for (const pin of [false, true]) {
        const resolver = pin ? f.view.resolver : { resolve: f.view.resolver.resolve };
        const app = tenantApp({ resolver });
        const unknown = await httpRequest(app, { host: 'unknown.example.test' }).result;
        assert.deepEqual(unknown, { status: 404, body: { error: 'TENANT_REFUSED' } }, 'UNKNOWN_HOST_REFUSAL_MUST_SURVIVE_REGISTRY_PIN_' + pin);
        const duplicate = await httpRequest(app, { rawHeaders: ['Host', 'one.example.test', 'Host', 'two.example.test'] }).result;
        assert.deepEqual(duplicate, { status: 400, body: { error: 'TENANT_REFUSED' } }, 'INVALID_SELECTOR_REFUSAL_MUST_SURVIVE_REGISTRY_PIN_' + pin);
      }
    } finally { await f.close(); }
  });

  it('refuses registry token keys for any purpose but management (the api reads none)', async function () {
    for (const options of [{ accessTokens: { issuer: 'synthetic-issuer' } }, { accessTokens: { issuer: 'synthetic-issuer' }, keyPurpose: 'access' }]) {
      await assert.rejects(fixture({ options }), /Registry token keys are management keys/);
    }
    const f = await fixture({ options: { accessTokens: { issuer: 'synthetic-issuer' }, keyPurpose: 'management' } });
    await f.close();
  });

  it('keeps registry metadata pinned through a delayed JSON body after another request evicts it', async function () {
    const f = await fixture(), preparing = deferred();
    const router = express.Router();
    const respond = (req, res) => {
      const tenant = req.tenantContext.tenant;
      res.json({ tenant, binding: f.view.bindings.get(tenant)?.tenant, environment: f.view.environments.get(tenant)?.tenant,
        provider: f.view.providers.get(tenant)?.encryptionKey, body: req.body });
    };
    router.post('/entries', respond); router.get('/entries', respond);
    const app = tenantApp({ resolver: f.view.resolver, dataRouter: router,
      prepareTenant: async (tenant, req) => { if (tenant === A && req.method === 'POST') preparing.resolve(); },
      verifyCredential: async ({ tenant }) => {
        assert.equal(f.view.bindings.get(tenant)?.tenant, tenant, 'JSON_PARSER_MUST_PRESERVE_REGISTRY_AUTHORITY_PIN');
        return f.view.bindings.get(tenant);
      } });
    let first;
    try {
      first = httpRequest(app, { method: 'POST', body: JSON.stringify({ marker: 'synthetic-a' }) });
      await preparing.promise; await new Promise(setImmediate);
      const second = await httpRequest(app, { host: 'two.example.test' }).result;
      assert.equal(second.status, 200); assert.equal(second.body.binding, B);
      assert.equal(f.cache.peek(A), undefined, 'second request must actually evict the first tenant');
      first.send();
      assert.deepEqual(await first.result, { status: 200, body: { tenant: A, binding: A, environment: A,
        provider: rules.vaultKey(A, 'data'), body: { marker: 'synthetic-a' } } });
    } finally { first?.send(); await first?.result.catch(() => {}); await f.close(); }
  });
});
