'use strict';

// covers: lib/server/serve/registry-config.js, lib/server/serve/preview-config.js, lib/tenant-registry/rules.js
// Role-token scope (decision core-static-plan-retired): in registry mode a
// server component holds one Vault credential for every tenant. The token
// reaches exactly its key purposes on its mount; it cannot reach another key
// purpose, another operation on its own purpose, key management, or another
// mount. Tenant isolation is the application authority's and row-level
// security's (tests/multitenant-preview-replicas.integration.test.js), not the
// token's. Actual Vault and PostgreSQL; synthetic tenants only.
const assert = require('node:assert/strict');
const { optInSuite } = require('./support/opt-in');
const createFixture = require('./fixtures/multitenant-preview-replicas');
const rules = require('../lib/tenant-registry/rules');

optInSuite(process.env.NS_ROLE_VAULT_TOKEN_SCOPE_DOCKER_TEST === '1',
  'NS_ROLE_VAULT_TOKEN_SCOPE_DOCKER_TEST=1')('api role Vault token scope in registry mode (owned PostgreSQL/Vault)', function () {
  this.timeout(120000);
  const fixture = createFixture();
  const [A, B] = fixture.tenants;
  const input = Buffer.from('synthetic').toString('base64');
  // The HTTP status Vault gives the api role's own token for one request.
  async function status (resource, body) {
    const response = await fetch(fixture.vaultAddress + '/v1/' + resource, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Vault-Token': fixture.roleToken, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    await response.body?.cancel();
    return response.status;
  }
  before(() => fixture.setup());
  after(() => fixture.cleanup());
  afterEach(async () => { for (const worker of [...fixture.workers]) await fixture.stop(worker); });

  it('RTS_GRANTED: the one role token serves both tenants and reaches each tenant\'s data and signing purposes', async function () {
    const worker = fixture.start(); await fixture.ready(worker);
    for (const tenant of [A, B]) {
      assert.equal((await fixture.exchange(worker, tenant)).status, 200, 'legacy exchange decrypts the tenant root secret and signs with the tenant signing key');
      assert.equal(await status('transit/hmac/' + rules.vaultKey(tenant, 'signing'), { input }), 200);
    }
  });

  it('RTS_PURPOSE: the role token cannot use another key purpose or another operation', async function () {
    for (const tenant of [A, B]) {
      for (const purpose of ['access', 'management', 'human-data', 'human-management']) {
        assert.equal(await status('transit/sign/' + rules.vaultKey(tenant, purpose), { input }), 403, purpose + ' signing');
      }
      assert.equal(await status('transit/encrypt/' + rules.vaultKey(tenant, 'data'), { plaintext: input }), 403, 'data encryption');
      assert.equal(await status('transit/hmac/' + rules.vaultKey(tenant, 'data'), { input }), 403, 'HMAC with the data key');
      assert.equal(await status('transit/decrypt/' + rules.vaultKey(tenant, 'signing'), { ciphertext: 'vault:v1:AAAA' }), 403, 'decrypt with the signing key');
    }
  });

  it('RTS_MANAGEMENT: the role token cannot read, create, rotate or configure keys, or read the mount table', async function () {
    const key = rules.vaultKey(A, 'data');
    assert.equal(await status('transit/keys/' + key), 403, 'read key');
    assert.equal(await status('transit/keys/' + rules.vaultKey(A, 'signing') + '/rotate', {}), 403, 'rotate key');
    assert.equal(await status('transit/keys/tenant-data-planted', { type: 'aes256-gcm96' }), 403, 'create key');
    assert.equal(await status('transit/keys/' + key + '/config', { deletion_allowed: true }), 403, 'configure key');
    assert.equal(await status('sys/mounts'), 403, 'mount table');
  });

  it('RTS_MOUNT: the role token cannot use a key of the same name on another mount', async function () {
    const key = rules.vaultKey(A, 'data');
    await fixture.operatorVault('sys/mounts/other', { type: 'transit' });
    await fixture.operatorVault('other/keys/' + key, { type: 'aes256-gcm96', exportable: false });
    const ciphertext = (await fixture.operatorVault('other/encrypt/' + key, { plaintext: input })).data.ciphertext;
    assert.equal(await status('other/decrypt/' + key, { ciphertext }), 403);
    assert.equal(await status('other/hmac/' + rules.vaultKey(A, 'signing'), { input }), 403);
  });
});
