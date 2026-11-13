'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express'), request = require('supertest');
const configuration = require('../lib/tenant-connector/config');
const { create } = require('../lib/tenant-connector/runtime');
const contracts = require('../lib/server/internal-api/contracts');
const { validate } = require('../lib/server/internal-api/schema');
const A = randomUUID(), B = randomUUID();
const definition = n => ({ collections: ['entries'], sourceEndpoint: 'endpoint-' + n, sourceCredential: 'credential-' + n, writeCredential: 'write-' + n, sourceCredentialKind: 'token' });
function runtimeLab () {
  const map = new Map(), activityStates = new Map([[A, 'active'], [B, 'active']]), decrypted = [], runs = [], callbacks = [], values = new Map();
  let now = 0, current = true;
  const activity = require('../lib/tenant-activity/eligibility').create({ read: async id => ({ state: activityStates.get(id) }) });
  const member = { configured: { mode: 'standalone', ordinal: 0 }, slice: async () => ({ eligible: true, includes: id => { assert.ok([A, B].includes(id), 'pool slices are tenant ids, never source ids'); return true; } }),
    inspect: async () => ({ configured: { mode: 'standalone', ordinal: 0 }, observed: null }) };
  const config = { tenants: map, currentTenants: () => { if (!current) throw new Error('unavailable'); return map; },
    api: 'https://api.example.test/', sources: { allowHosts: ['source.example.test'] }, egress: { proxy: null }, cycleMs: 100, pollIntervalMs: 300000, retryMs: 100 };
  const runtime = create({ config, member, activity, now: () => now, log: () => {},
    decrypt: async (tenant, ref) => { decrypted.push([tenant.id, ref]); const key = tenant.id + ':' + ref;
      if (values.get(key) === null) throw Object.assign(new Error(), { code: 'SECRETS_RECORD_MISSING' });
      return Buffer.from(values.get(key) || (ref.startsWith('endpoint-') ? 'https://source.example.test/' : 'synthetic-' + ref)); },
    frame: { create: options => { callbacks.push(options.beforeRequest); return { run: async () => { await options.beforeRequest(); runs.push(options.tenant); return { counts: { entries: 1 } }; } }; } } });
  return { runtime, map, runs, decrypted, callbacks, activityStates, values,
    advance: () => { now += 300001; }, unavailable: () => { current = false; },
    add (tenant, source, generation = 1, n = 1) { map.set(tenant + '/' + source, { id: tenant, sourceId: source, definitionGeneration: generation, connector: definition(n),
      host: tenant === A ? 'a.example.test' : 'b.example.test', binding: { tenant, principal: 'vcpool', consumer: 'tenant-connector' } }); } };
}
describe('durable connector source configuration', function () {
  it('CS_REGISTRY_CONFIG: registry mode carries no tenant list or per-tenant Vault binding and needs no lab flag', function () {
    const raw = { version: 1, api: { url: 'http://api:1337/' }, postgres: { connectionEnv: 'SECRET_DB', namespaces: { secrets: 'cs_secrets' } },
      activity: { connectionEnv: 'ACTIVITY_DB', namespace: 'cs_control' }, sources: { allowHosts: ['source.example.test'] },
      registry: { namespace: 'cs_registry', refreshMs: 500 }, definitions: { connectionEnv: 'DEFINITION_DB', namespaces: { settings: 'cs_settings', secrets: 'cs_secrets', registry: 'cs_registry', control: 'cs_control' } },
      vault: { address: 'https://vault.example.test/', mount: 'transit', tokenEnv: 'VAULT_TOKEN' } };
    const source = { SECRET_DB: 'postgres://synthetic:synthetic@127.0.0.1/connector_test', ACTIVITY_DB: 'postgres://activity:synthetic@127.0.0.1/connector_test', DEFINITION_DB: 'postgres://definitions:synthetic@127.0.0.1/connector_test', VAULT_TOKEN: 'synthetic' };
    const parsed = configuration.parse(raw, source); assert.equal(parsed.tenants.size, 0); assert.equal(parsed.registry.namespace, 'cs_registry');
    assert.equal(require('../lib/server/serve/static-tenants').check({}, { vcpoolPreview: parsed }), null);
    assert.throws(() => configuration.parse({ ...raw, tenants: [] }, source), /registry mode refuses/);
  });
  it('CS_DYNAMIC: sources add/update/delete without restart; all sources of a tenant share one pool slice; credentials are re-read per poll', async function () {
    const f = runtimeLab();
    try {
      f.add(A, 'one'); f.add(A, 'two'); f.add(B, 'one'); await f.runtime.cycle(); assert.deepEqual(f.runs, [A, A, B]);
      const first = f.decrypted.length, frames = f.callbacks.length; f.advance(); await f.runtime.cycle(); assert.equal(f.decrypted.length, first * 2);
      assert.equal(f.callbacks.length, frames, 'unchanged credentials preserve the driver bookmark/session');
      f.map.delete(A + '/two'); f.add(A, 'one', 2, 2); f.add(B, 'two'); await f.runtime.cycle();
      assert.equal(f.runs.length, 8, 'only updated/new sources are immediately due');
      const view = await f.runtime.inspect(); validate(contracts.connectorInspection.operations.inspectConnectors.response, view);
      assert.equal(view.tenants.find(row => row.tenant === A).definitionGeneration, 2); assert.equal(view.tenants.filter(row => row.tenant === A).length, 1);
      await assert.rejects(f.callbacks[0](), { code: 'CONNECTOR_CONFIGURATION_CHANGED' });
    } finally { await f.runtime.close(); }
  });
  it('CS_SECRET_REFRESH: changed or removed secret references replace/refuse the retained driver at the next poll', async function () {
    const f = runtimeLab();
    try {
      f.add(A, 'one'); await f.runtime.cycle(); assert.equal(f.callbacks.length, 1);
      f.values.set(A + ':credential-1', 'synthetic-replacement'); f.advance(); await f.runtime.cycle();
      assert.equal(f.callbacks.length, 2, 'changed credential rebuilds the driver');
      const before = f.runs.length;
      f.values.set(A + ':credential-1', null); f.advance(); await f.runtime.cycle(); assert.equal(f.runs.length, before);
    } finally { await f.runtime.close(); }
  });
  it('CS_ELIGIBILITY: paused polling continues, suspended source sends no requests, and return to eligibility rebuilds without restart', async function () {
    const f = runtimeLab();
    try {
      f.add(A, 'one'); f.add(B, 'one'); f.activityStates.set(A, 'paused'); f.activityStates.set(B, 'suspended');
      await f.runtime.cycle(); assert.deepEqual(f.runs, [A]);
      f.activityStates.set(A, 'suspended'); await assert.rejects(f.callbacks[0](), { code: 'CONNECTOR_TENANT_INELIGIBLE' });
      f.activityStates.set(B, 'active'); await f.runtime.cycle(); assert.deepEqual(f.runs, [A, B]);
      f.unavailable(); f.advance(); await f.runtime.cycle(); assert.deepEqual(f.runs, [A, B]);
      assert.ok((await f.runtime.inspect()).tenants.every(row => row.status === 'configuration-refused'));
    } finally { await f.runtime.close(); }
  });
  it('CS_REST: admin API exposes generation CAS, bounded list, tombstone delete and OpenAPI without accepting values or logging them', async function () {
    const calls = [], store = {
      async put (...args) { calls.push(args); return { outcome: 'created', definition: { generation: 1 } }; },
      async get () { return { sourceId: 'one', generation: 1 }; }, async list () { return []; },
      async remove (...args) { calls.push(args); return { outcome: 'deleted' }; }
    };
    const rest = require('../lib/tenant-connector/source-rest').create({ store }), app = express(); app.use(rest.handle);
    const path = '/v1/tenants/' + A + '/connector-sources/one';
    assert.equal((await request(app).put(path).send({ ifGeneration: 0, enabled: true, connector: definition(1) })).status, 201);
    assert.equal((await request(app).delete(path).set('If-Match', '"1"')).status, 200); assert.equal(calls.at(-1)[2], 1);
    assert.equal((await request(app).delete(path)).status, 422);
    assert.equal((await request(app).get('/v1/tenants/' + A + '/connector-sources?limit=2')).status, 200);
    const spec = await request(app).get('/v1/openapi.json'); assert.equal(spec.body.paths['/v1/tenants/{id}/connector-sources/{source}'].put.operationId, 'putConnectorSource');
  });
  it('CS_REQUEST_GATE: actual connector transports send no request after configuration/activity admission is withdrawn', async function () {
    const http = require('node:http'), events = [];
    let admitted = false, checks = 0;
    const server = http.createServer((req, res) => {
      events.push(req.url); res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.url.startsWith('/api/v2/authorization/request/') ? JSON.stringify({ token: 'synthetic.jwt', iat: 1, exp: 3601 }) : '[]');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port + '/';
    const frame = require('../lib/tenant-connector/frame').create({ tenant: A, api: base, host: 'a.example.test', endpoint: new URL(base), credential: 'synthetic-source',
      credentialKind: 'token', writeCredential: 'synthetic-writer', collections: ['entries'], proxy: null,
      beforeRequest: async () => { checks++; if (!admitted) throw Object.assign(new Error(), { code: 'CONNECTOR_CONFIGURATION_CHANGED' }); } });
    try {
      await assert.rejects(frame.run()); assert.equal(events.length, 0); assert.ok(checks > 0);
      admitted = true; await frame.run(); assert.ok(events.some(url => url.startsWith('/api/v2/authorization/request/')));
      const before = events.length; admitted = false; await assert.rejects(frame.run()); assert.equal(events.length, before);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

});
