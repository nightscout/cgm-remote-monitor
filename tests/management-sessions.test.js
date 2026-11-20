'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto'), http = require('node:http');
const { createDerivedKeySource } = require('../lib/management-sessions/keys');
const { createManagementApi } = require('../lib/management-sessions/rest');
const fixture = require('./fixtures/signing-secret');
const tenant = '10000000-0000-0000-0000-000000000001', requestId = '20000000-0000-0000-0000-000000000001';
const other = '10000000-0000-0000-0000-000000000002';
// Derived management keys (decision deployment-signing-secret): rows hold kid
// management-<version> and the public key; the issuer derives the private key.
const row = (version, t = tenant) => ({ kid: 'management-' + version, public_key: fixture.signing.key(t, 'management', version).raw });
const keys = [row(1), row(2)];
describe('private management issuance key and HTTP boundaries', function () {
  const source = () => createDerivedKeySource({ signing: fixture.signing });
  it('chooses the highest matching version and preserves an enabled retry mapping; signs in process', async () => {
    const chosen = await source().select({ tenant, keys });
    assert.equal(chosen.keyVersion, 2); assert.equal(chosen.kid, 'management-2');
    const input = Buffer.from('synthetic-signing-input'), signature = await chosen.sign(input);
    assert(crypto.verify(null, input, fixture.signing.key(tenant, 'management', 2).publicKey, signature));
    assert.equal((await source().select({ tenant, keys, expected: { kid: 'management-1', key_version: 1 } })).keyVersion, 1);
  });
  it('refuses missing, mismatched, foreign-tenant or wrong-purpose key rows, and needs no Vault', async () => {
    const foreignSecret = require('../lib/secrets/derived-signing').fromSecret(Buffer.alloc(32, 9));
    for (const mapped of [[], [row(1, other)], [{ kid: 'management-1', public_key: foreignSecret.key(tenant, 'management', 1).raw }],
      [{ kid: 'human-management-1', public_key: fixture.signing.key(tenant, 'human-management', 1).raw }], [{ kid: 'management1', public_key: row(1).public_key }]]) {
      await assert.rejects(source().select({ tenant, keys: mapped }), { code: 'MANAGEMENT_SESSION_KEY_REFUSED' }, JSON.stringify(mapped));
    }
    await assert.rejects(source().select({ tenant, keys, expected: { kid: 'management-3', key_version: 3 } }), { code: 'MANAGEMENT_SESSION_KEY_REFUSED' });
    assert.throws(() => createDerivedKeySource({}), TypeError);
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
  const source = { NS_SYNTHETIC_ISSUER_DB: 'postgres://synthetic_issuer:synthetic@127.0.0.1:5432/nightscout_test', ...fixture.env() };
  const configuration = () => ({ version: 1, maxBytes: 16384, timeoutMs: 5000,
    managementSessions: { connectionEnv: 'NS_SYNTHETIC_ISSUER_DB',
      namespaces: { authorization: 'sample_auth', registry: 'sample_registry', access: 'sample_access', control: 'sample_control' },
      consumer: 'owner-ui', issuer: 'management', audience: 'management', operator: { principal: 'synthetic', consumer: 'private-operator' } } });
  it('parses a standalone issuer with explicit identities and a bounded default', function () {
    const parsed = require('../lib/server/serve/admin-config').parse(configuration(), source);
    assert.equal(parsed.managementSessions.maxLifetimeSeconds, 600);
    assert.equal(parsed.managementSessions.connectionString, source.NS_SYNTHETIC_ISSUER_DB);
    assert.equal(parsed.managementSessions.consumer, 'owner-ui');
    assert.equal(typeof parsed.managementSessions.signing.matching, 'function');
  });
  it('refuses widened lifetimes, merged namespaces, implicit subjects and missing secrets', function () {
    const mutations = [c => { c.managementSessions.maxLifetimeSeconds = 601; }, c => { c.managementSessions.namespaces.access = 'sample_auth'; },
      c => { c.managementSessions.subjectId = 'implicit'; }, c => { delete c.managementSessions.operator; },
      c => { c.managementSessions.vault = { address: 'http://127.0.0.1:8200', mount: 'transit', tokenEnv: 'NS_SYNTHETIC_VAULT' }; }];
    for (const mutate of mutations) { const value = configuration(); mutate(value); assert.throws(() => require('../lib/server/serve/admin-config').parse(value, source)); }
    // The issuer does not start without the deployment signing secret.
    assert.throws(() => require('../lib/server/serve/admin-config').parse(configuration(), { NS_SYNTHETIC_ISSUER_DB: source.NS_SYNTHETIC_ISSUER_DB }), /NS_SIGNING_SECRET_FILE/);
  });
  it('uses the existing management protocol without embedding permission grants', async function () {
    let bytes;
    const service = require('../lib/management-sessions/component').createManagementSessions({ issuer: 'management', audience: 'management',
      store: { issue: async (input, sign) => sign({ existing: false, keys: [], record: { tenant_id: tenant, subject_id: 'synthetic-owner', session_id: requestId,
        credential_generation: 1, issued_at: 100, expires_at: 700 } }) },
      keySource: { select: async () => ({ kid: 'management-1', keyVersion: 1, sign: async input => { bytes = input; return Buffer.alloc(64); } }) } });
    const result = await service.issue({}); const [header, payload] = bytes.toString().split('.').map(value => JSON.parse(Buffer.from(value, 'base64url')));
    assert.deepEqual(header, { alg: 'EdDSA', typ: 'ns-access+jwt', kid: 'management-1' });
    assert.deepEqual(payload, { iss: 'management', aud: 'management', tid: tenant, purpose: 'management', sub: 'synthetic-owner', sid: requestId, cv: 1, iat: 100, nbf: 100, exp: 700 });
    assert.equal(result.keyVersion, 1);
  });
});
