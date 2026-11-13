'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto'), http = require('node:http');
const { createVaultKeySource } = require('../lib/management-sessions/vault');
const { createManagementApi } = require('../lib/management-sessions/rest');
const tenant = '10000000-0000-0000-0000-000000000001', requestId = '20000000-0000-0000-0000-000000000001';
const raw = () => crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
const public1 = Buffer.from(raw(), 'base64url').toString('base64'), public2 = Buffer.from(raw(), 'base64url').toString('base64');
const metadata = { type: 'ed25519', exportable: false, latest_version: 2, min_encryption_version: 1, keys: { 1: { public_key: public1 }, 2: { public_key: public2 } } };
const keys = [{ kid: 'old', public_key: public1 }, { kid: 'current', public_key: public2 }];
describe('private management issuance key and HTTP boundaries', function () {
  const source = (data = metadata, extra = {}) => createVaultKeySource({ address: 'http://127.0.0.1:8200', mount: 'transit', allowInsecureLoopback: true,
    getToken: async () => 'synthetic-private-capability', fetch: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:8200/v1/transit/keys/tenant-management-' + tenant);
      assert.equal(options.redirect, 'manual'); return new Response(JSON.stringify({ data }));
    }, ...extra });
  it('chooses highest matching explicit version and preserves an enabled retry mapping', async () => {
    assert.equal((await source().select({ tenant, keys })).keyVersion, 2);
    assert.equal((await source().select({ tenant, keys, expected: { kid: 'old', key_version: 1 } })).keyVersion, 1);
  });
  it('refuses missing, ambiguous, exported or retired authority mappings', async () => {
    for (const [data, mapped] of [[metadata, []], [metadata, [...keys, { kid: 'duplicate', public_key: public2 }]], [{ ...metadata, exportable: true }, keys],
      [{ ...metadata, min_encryption_version: 3 }, keys]]) await assert.rejects(source(data).select({ tenant, keys: mapped }), { code: 'MANAGEMENT_SESSION_KEY_REFUSED' });
  });
  it('bounds a token callback that never resolves and sanitizes transport errors', async () => {
    await assert.rejects(source(metadata, { timeoutMs: 10, getToken: () => new Promise(() => {}) }).select({ tenant, keys }), { code: 'MANAGEMENT_SESSION_UNAVAILABLE' });
    await assert.rejects(source(metadata, { fetch: async () => { throw new Error('synthetic-secret'); } }).select({ tenant, keys }), error => error.message === 'MANAGEMENT_SESSION_UNAVAILABLE');
  });
  it('serves strict private POSTs with no-store and logs no token or subject', async () => {
    const logs = [], calls = []; let created = true;
    const server = http.createServer(createManagementApi({ service: { issue: async value => {
      calls.push(value); return { token: 'synthetic-private-token', expiresAt: 600, sessionId: requestId, requestId, outcome: created ? 'created' : 'existing' };
    } }, log: value => logs.push(value) }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/v1/tenants/' + tenant + '/management-sessions';
    const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': requestId }, body: JSON.stringify(body) });
    try {
      let response = await post({ subjectId: 'synthetic-owner', requestId }); assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'no-store'); await response.text();
      created = false; response = await post({ subjectId: 'synthetic-owner', requestId }); assert.equal(response.status, 200); await response.text();
      response = await post({ subjectId: 'synthetic-owner', requestId, tenant: 'injected' }); assert.equal(response.status, 422); await response.text();
      response = await fetch(url); assert.equal(response.status, 405); await response.text();
      assert.equal(calls.length, 2); assert(calls.every(value => value.tenant === tenant));
      assert(!JSON.stringify(logs).includes('synthetic-owner')); assert(!JSON.stringify(logs).includes('synthetic-private-token'));
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});

describe('management issuer configuration and protocol', function () {
  const source = { NS_SYNTHETIC_ISSUER_DB: 'postgres://synthetic_issuer:synthetic@127.0.0.1:5432/nightscout_test', NS_SYNTHETIC_VAULT: 'synthetic-private' };
  const configuration = () => ({ version: 1, maxBytes: 16384, timeoutMs: 5000,
    managementSessions: { connectionEnv: 'NS_SYNTHETIC_ISSUER_DB',
      namespaces: { authorization: 'sample_auth', registry: 'sample_registry', access: 'sample_access', control: 'sample_control' },
      consumer: 'owner-ui', issuer: 'management', audience: 'management', operator: { principal: 'synthetic', consumer: 'private-operator' },
      vault: { address: 'http://127.0.0.1:8200', mount: 'transit', tokenEnv: 'NS_SYNTHETIC_VAULT', allowInsecureLoopback: true } } });
  it('parses a standalone issuer with explicit identities and a bounded default', function () {
    const parsed = require('../lib/server/serve/admin-config').parse(configuration(), source);
    assert.equal(parsed.managementSessions.maxLifetimeSeconds, 600);
    assert.equal(parsed.managementSessions.connectionString, source.NS_SYNTHETIC_ISSUER_DB);
    assert.equal(parsed.managementSessions.consumer, 'owner-ui');
  });
  it('refuses widened lifetimes, merged namespaces, implicit subjects and missing secrets', function () {
    const mutations = [c => { c.managementSessions.maxLifetimeSeconds = 601; }, c => { c.managementSessions.namespaces.access = 'sample_auth'; },
      c => { c.managementSessions.subjectId = 'implicit'; }, c => { delete c.managementSessions.operator; },
      c => { c.managementSessions.vault.tokenEnv = 'ABSENT'; }];
    for (const mutate of mutations) { const value = configuration(); mutate(value); assert.throws(() => require('../lib/server/serve/admin-config').parse(value, source)); }
  });
  it('uses the existing management protocol without embedding permission grants', async function () {
    let bytes;
    const service = require('../lib/management-sessions/component').createManagementSessions({ issuer: 'management', audience: 'management',
      store: { issue: async (input, sign) => sign({ existing: false, keys: [], record: { tenant_id: tenant, subject_id: 'synthetic-owner', session_id: requestId,
        credential_generation: 1, issued_at: 100, expires_at: 700 } }) },
      keySource: { select: async () => ({ kid: 'management1', keyVersion: 1, sign: async input => { bytes = input; return Buffer.alloc(64); } }) } });
    const result = await service.issue({}); const [header, payload] = bytes.toString().split('.').map(value => JSON.parse(Buffer.from(value, 'base64url')));
    assert.deepEqual(header, { alg: 'EdDSA', typ: 'ns-access+jwt', kid: 'management1' });
    assert.deepEqual(payload, { iss: 'management', aud: 'management', tid: tenant, purpose: 'management', sub: 'synthetic-owner', sid: requestId, cv: 1, iat: 100, nbf: 100, exp: 700 });
    assert.equal(result.keyVersion, 1);
  });
});
