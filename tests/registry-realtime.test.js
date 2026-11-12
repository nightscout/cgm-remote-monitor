'use strict';

// Registry mode for realtime, the api's socket forwarding, tenant removal on the
// admin REST API and the static-tenants lab gate, without a database. The
// PostgreSQL halves are tests/tenant-registry-provision.integration.test.js
// (PV_REMOVE, PV_SETTINGS). Synthetic tenants and hosts only.
// covers: lib/server/realtime/config.js, lib/server/realtime/registry-admission.js, lib/server/realtime/private-api.js, lib/server/realtime/private-config.js, lib/tenant-registry/rest.js, lib/cli/commands/admin.js, lib/server/serve/static-tenants.js
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const scope = require('../lib/storage/tenant-scope');

const A = randomUUID(), B = randomUUID();
const namespaces = Object.fromEntries(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'clock', 'checkpoint'].map(k => [k, 'rr_' + k]));
const SOURCE = { RT_DB: 'postgres://synthetic:synthetic@127.0.0.1/disposable_test', RT_ADMISSION: '/tmp/admission.json', NS_API_INTERNAL_SOCKET: '/tmp/a.sock' };
const realtimeConfig = extra => ({ version: 1, postgres: { connectionEnv: 'RT_DB', namespaces },
  consumer: 'realtime-registry', pageSize: 1, maxRows: 10, maxBytes: 10000, maxTenants: 2, recoveryIntervalMs: 100,
  registry: { namespace: 'rr_registry', refreshMs: 500 }, maxMessageBytes: 10000, operationTimeoutMs: 1000, maxSockets: 10, ...extra });
const request = host => ({ rawHeaders: ['Host', host], socket: {} });
// A registry resolver double: hosts map to tenants; the registry decides activity.
const resolverOf = hosts => ({ resolve: async req => { const host = req.rawHeaders[1]; if (!hosts.has(host)) throw new Error('TENANT_HOST_UNKNOWN'); return hosts.get(host); } });

describe('registry mode: realtime, socket forwarding, removal and the static lab gate', function () {
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));

  it('RR_CONFIG: realtime takes `registry` in place of `tenants` and the admission file, and refuses both together', function () {
    const { parse } = require('../lib/server/realtime/config');
    const parsed = parse(realtimeConfig(), SOURCE);
    assert.equal(parsed.registry.namespace, 'rr_registry'); assert.equal(parsed.registry.refreshMs, 500);
    assert.equal(parsed.tenants.size, 0); assert.equal(parsed.admissionFile, null);
    for (const extra of [{ tenants: [{ id: A, revision: 'v1', settings: {} }] }, { admissionFileEnv: 'RT_ADMISSION' }]) {
      assert.throws(() => parse(realtimeConfig(extra), SOURCE), { code: 'REALTIME_REGISTRY_REFUSES_TENANT_LIST' });
    }
    assert.throws(() => parse(realtimeConfig({ registry: { namespace: 'rr_registry', refreshMs: 10 } }), SOURCE));
  });

  it('RR_ADMISSION: sockets are admitted by registry host lookup and the registry tenant set; anything else is SOCKET_ADMISSION_REFUSED', async function () {
    const active = new Set([A]);
    const admission = require('../lib/server/realtime/registry-admission').create({ resolver: resolverOf(new Map([['a.example.test', A], ['b.example.test', B]])),
      active: tenant => active.has(tenant), enabled: () => active });
    assert.equal(await admission.resolve(request('a.example.test')), A);
    assert.equal(await admission.resolveHost('a.example.test'), A);
    await assert.rejects(admission.resolve(request('b.example.test')), { code: 'SOCKET_ADMISSION_REFUSED' }, 'resolves, but not in the served set');
    await assert.rejects(admission.resolve(request('unknown.example.test')), { code: 'SOCKET_ADMISSION_REFUSED' });
    assert.equal(await admission.allows(A), true); assert.equal(await admission.allows('not-a-uuid'), false);
    assert.deepEqual([...await admission.enabled()], [A]);
    active.delete(A);
    await assert.rejects(admission.resolve(request('a.example.test')), { code: 'SOCKET_ADMISSION_REFUSED' }, 'removal applies to the next socket');
    const failing = require('../lib/server/realtime/registry-admission').create({ resolver: resolverOf(new Map()), active: () => { throw new Error('down'); } });
    assert.equal(await failing.allows(A), false, 'fails closed');
  });

  it('RR_PRIVATE_CONFIG: socket forwarding in registry mode names no admission file', function () {
    const privateConfig = require('../lib/server/realtime/private-config');
    const existing = { namespaces: { entries: 'rr_entries' }, connections: ['postgres://app:synthetic@db.example.test/ns'] };
    const value = { maxTenants: 10, maxMessageBytes: 10000, operationTimeoutMs: 1000, alarm: { connectionEnv: 'ALARM_PG', namespace: 'rr_alarm' } };
    const source = { ALARM_PG: 'postgres://alarm:synthetic@db.example.test/ns', ADMISSION: '/tmp/a.json' };
    assert.equal(privateConfig(value, source, { ...existing, registry: true }).admissionFile, null);
    assert.throws(() => privateConfig({ ...value, admissionFileEnv: 'ADMISSION' }, source, { ...existing, registry: true }), { code: 'SOCKET_PRIVATE_CONFIG_REFUSED' });
    assert.throws(() => privateConfig(value, source, existing), { code: 'SOCKET_PRIVATE_CONFIG_REFUSED' }, 'static mode still needs its admission file');
  });

  it('RR_WARM: the registry-mode warm names the tenant only; the api prepares an admitted tenant and answers denied; static mode refuses a hostless call', async function () {
    const { operations } = require('../lib/server/realtime/private-api');
    const token = Symbol('transport'), prepared = [];
    const active = new Set([A]);
    const registryAdmission = require('../lib/server/realtime/registry-admission').create({ resolver: resolverOf(new Map([['a.example.test', A]])), active: tenant => active.has(tenant) });
    const base = { token, authority: { verify: async () => ({ permissions: {}, collections: [] }) }, executeWrite: async () => [],
      alarmConnection: require('./fixtures/tenant-alarm-protocol')().db, prepareTenant: async tenant => { prepared.push(tenant); } };
    const config = { bindings: new Map([[A, true]]), aliases: null, socketForwarding: { alarm: { namespace: 'rr_alarm' } }, namespaces: { authorization: 'rr_auth' } };
    const ops = operations({ ...base, admission: registryAdmission, config });
    assert.deepEqual(await ops.authorizeSocket({ transport: token }, { tenant: A, namespace: '/', credential: {} }), { denied: true });
    assert.deepEqual(prepared, [A]);
    await assert.rejects(ops.authorizeSocket({ transport: token }, { tenant: B, namespace: '/', credential: {} }), { code: 'SOCKET_PRIVATE_TENANT_REFUSED' }, 'a tenant the registry does not admit');
    await assert.rejects(ops.authorizeSocket({ transport: token }, { tenant: A, namespace: '/', credential: { secret: 'x' } }), { code: 'SOCKET_PRIVATE_TENANT_REFUSED' }, 'a hostless call carries no credential');
    await assert.rejects(ops.authorizeSocket({ transport: token }, { tenant: A, namespace: '/storage', credential: {} }), { code: 'SOCKET_PRIVATE_TENANT_REFUSED' });
    await assert.rejects(ops.authorizeSocket({ transport: Symbol('other') }, { tenant: A, namespace: '/', credential: {} }), { code: 'SOCKET_PRIVATE_REQUEST_REFUSED' });
    // With a host, the registry path resolves through the same admission (no static alias list).
    assert.deepEqual(Object.keys(await ops.authorizeSocket({ transport: token }, { host: 'a.example.test', tenant: A, namespace: '/', credential: {} })).sort(), ['collections', 'permissions']);
    const staticOps = operations({ ...base, config: { ...config, aliases: [{ host: 'a.example.test', tenant: A }] },
      admission: { resolveHost: async () => A, allows: async () => true } });
    await assert.rejects(staticOps.authorizeSocket({ transport: token }, { tenant: A, namespace: '/', credential: {} }), { code: 'SOCKET_PRIVATE_REQUEST_REFUSED' });
  });

  it('RR_REMOVE_REST: DELETE /v1/tenants/{id} answers removed, already removed, or 409 until the deletion ceremony executed; the CLI prints one line', async function () {
    const { createProvisioningApi } = require('../lib/tenant-registry/rest');
    const state = new Map([[A, 'executed'], [B, 'active']]), calls = [];
    const provisioning = { provision: async () => ({}), provisionBatch: async () => [], get: async () => null,
      async remove (id) {
        calls.push(id);
        if (!state.has(id)) return { id, outcome: 'refused', code: 'TENANT_NOT_FOUND' };
        if (state.get(id) === 'removed') return { id, outcome: 'existing', state: 'removed' };
        if (state.get(id) !== 'executed') return { id, outcome: 'refused', code: 'TENANT_REMOVAL_REQUIRES_DELETION' };
        state.set(id, 'removed'); return { id, outcome: 'removed', state: 'removed' };
      } };
    const handler = createProvisioningApi({ provisioning });
    const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const call = (method, route, headers = {}) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: route, headers }, res => {
        let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      }); req.on('error', reject); req.end();
    });
    try {
      assert.deepEqual(await call('DELETE', '/v1/tenants/' + A), { status: 200, body: { id: A, outcome: 'removed', state: 'removed' } });
      assert.deepEqual(await call('DELETE', '/v1/tenants/' + A), { status: 200, body: { id: A, outcome: 'existing', state: 'removed' } });
      const refused = await call('DELETE', '/v1/tenants/' + B);
      assert.equal(refused.status, 409); assert.equal(refused.body.code, 'TENANT_REMOVAL_REQUIRES_DELETION');
      assert.equal((await call('DELETE', '/v1/tenants/' + randomUUID())).status, 404);
      assert.equal((await call('DELETE', '/v1/tenants/' + B, { 'idempotency-key': A })).body.code, 'TENANT_PROVISION_IDEMPOTENCY_KEY_MISMATCH');
      assert.equal((await call('DELETE', '/v1/tenants/not-a-uuid')).status, 422);
      assert.equal((await call('PUT', '/v1/tenants/' + B)).status, 405);
      const openapi = (await call('GET', '/v1/openapi.json')).body;
      assert.equal(openapi.paths['/v1/tenants/{id}'].delete.operationId, 'removeTenant');
      assert.ok(openapi.components.schemas.Code.enum.includes('TENANT_REMOVAL_REQUIRES_DELETION'));
      // The CLI adapter.
      const admin = require('../lib/cli/commands/admin');
      const out = { stdout: '', stderr: '' };
      const io = { env: {}, stdout: { write: text => { out.stdout += text; } }, stderr: { write: text => { out.stderr += text; } } };
      state.set(B, 'executed');
      assert.equal(await admin.run(['remove', '--id', B, '--url', 'http://127.0.0.1:' + port], io), 0);
      assert.equal(out.stdout, B + ' removed\n');
      const other = randomUUID(); state.set(other, 'active'); out.stdout = '';
      assert.equal(await admin.run(['remove', '--id', other, '--url', 'http://127.0.0.1:' + port], io), 1);
      assert.equal(out.stdout, other + ' refused TENANT_REMOVAL_REQUIRES_DELETION\n');
      assert.equal(await admin.run(['remove', '--id', other, '--host', 'a.example.test', '--url', 'http://127.0.0.1:' + port], io), 64);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  it('RR_STATIC_LAB: a role configuration that lists tenants is refused without MULTITENANT_STATIC_TENANTS=lab; registry mode needs no flag', function () {
    const gate = require('../lib/server/serve/static-tenants');
    const configs = { preview: { registry: null }, adminPreview: { ownership: { tenants: [A] } }, operationConfig: { locks: [{ tenant: A, key: '1' }] } };
    assert.throws(() => gate.check({}, configs), error => error.code === 'STATIC_TENANTS_REFUSED' && /api, admin, operation cohort/.test(error.message));
    assert.match(gate.check({ MULTITENANT_STATIC_TENANTS: 'lab' }, configs), /lab and test only\): api, admin, operation cohort/);
    assert.throws(() => gate.check({ MULTITENANT_STATIC_TENANTS: 'yes' }, configs), { code: 'STATIC_TENANTS_REFUSED' });
    const registry = { preview: { registry: { namespace: 'r' } }, realtimePreview: { registry: { namespace: 'r' } }, evaluatorPreview: { registry: { namespace: 'r' } },
      ownerPreview: { registry: { namespace: 'r' } }, adminPreview: { ownership: { registry: { namespace: 'r' } }, provisioning: {} }, operationConfig: { locks: null } };
    assert.equal(gate.check({}, registry), null);
    assert.equal(gate.check({}, { adminPreview: { provisioning: {} } }), null, 'provisioning alone lists no tenants');
    assert.deepEqual(gate.staticRoles({ vcpoolPreview: {} }), ['vcpool'], 'vcpool has no registry mode yet');
  });
});
