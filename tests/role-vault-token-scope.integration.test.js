'use strict';

// covers: lib/server/serve/registry-config.js, lib/server/serve/preview-config.js, lib/tenant-registry/rules.js
// Role-token scope (decision core-static-plan-retired): in registry mode a
// server component holds one Vault credential for every tenant. Since decision
// deployment-signing-secret the api's only Vault use is decrypting with each
// tenant's one `data` Transit key; token signing keys are derived in process.
// The token reaches exactly that operation on its mount; it cannot sign, HMAC,
// verify or encrypt, use a key outside the `tenant-data-` prefix, manage keys,
// or reach another mount. Tenant isolation is the application authority's and row-level
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

  it('RTS_GRANTED: the one role token serves both tenants through each tenant\'s data key', async function () {
    const worker = fixture.start(); await fixture.ready(worker);
    for (const tenant of [A, B]) {
      // The exchange checks one-way verifiers in PostgreSQL and signs with the
      // derived data key: it needs no Vault call, only a serving worker.
      assert.equal((await fixture.exchange(worker, tenant)).status, 200, 'legacy exchange serves the tenant');
      const key = rules.vaultKey(tenant, 'data');
      const { ciphertext } = (await fixture.operatorVault('preview_transit/encrypt/' + key, { plaintext: input })).data;
      assert.equal(await status('preview_transit/decrypt/' + key, { ciphertext }), 200, 'decrypt with the tenant data key');
    }
  });

  it('RTS_PURPOSE: the role token cannot use another operation or a key outside the data prefix', async function () {
    for (const tenant of [A, B]) {
      const data = rules.vaultKey(tenant, 'data');
      assert.equal(await status('preview_transit/encrypt/' + data, { plaintext: input }), 403, 'data encryption');
      assert.equal(await status('preview_transit/hmac/' + data, { input }), 403, 'HMAC with the data key');
      assert.equal(await status('preview_transit/sign/' + data, { input }), 403, 'sign with the data key');
      assert.equal(await status('preview_transit/verify/' + data, { input, signature: 'vault:v1:AAAA' }), 403, 'verify with the data key');
      // A name outside the `tenant-data-` prefix (here the retired signing key's
      // name, which no longer exists) is unreachable for every operation.
      const outside = 'tenant-signing-' + tenant;
      for (const [operation, body] of [['decrypt', { ciphertext: 'vault:v1:AAAA' }], ['sign', { input }], ['hmac', { input }], ['verify', { input, signature: 'vault:v1:AAAA' }]]) {
        assert.equal(await status('preview_transit/' + operation + '/' + outside, body), 403, operation + ' outside the data prefix');
      }
    }
  });

  it('RTS_MANAGEMENT: the role token cannot read, create, rotate or configure keys, or read the mount table', async function () {
    const key = rules.vaultKey(A, 'data');
    assert.equal(await status('preview_transit/keys/' + key), 403, 'read key');
    assert.equal(await status('preview_transit/keys/' + key + '/rotate', {}), 403, 'rotate key');
    assert.equal(await status('preview_transit/keys/tenant-data-planted', { type: 'aes256-gcm96' }), 403, 'create key');
    assert.equal(await status('preview_transit/keys/' + key + '/config', { deletion_allowed: true }), 403, 'configure key');
    assert.equal(await status('sys/mounts'), 403, 'mount table');
  });

  it('RTS_MOUNT: the role token cannot use a key of the same name on another mount', async function () {
    const key = rules.vaultKey(A, 'data');
    await fixture.operatorVault('sys/mounts/other', { type: 'transit' });
    await fixture.operatorVault('other/keys/' + key, { type: 'aes256-gcm96', exportable: false });
    const ciphertext = (await fixture.operatorVault('other/encrypt/' + key, { plaintext: input })).data.ciphertext;
    assert.equal(await status('other/decrypt/' + key, { ciphertext }), 403);
  });
});
