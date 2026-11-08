'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const fixture = require('./fixtures/human-access-issuer');
const { loadHumanAccess, humanRouting } = require('../lib/human-session/access-config');

describe('explicit private human access configuration', function () {
  let directory, filename, config, source, local;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'human-access-config-'));
    filename = path.join(directory, 'public-issuer.json');
    local = fixture({ tenant: 'single' });
    config = { version: 1, issuer: local.issuer, audiences: local.audiences,
      vault: { addressEnv: 'TEST_HUMAN_VAULT_ADDRESS', tokenEnv: 'TEST_HUMAN_VAULT_TOKEN', mount: 'transit' },
      keys: local.keys.map(key => ({ tenant: key.tenant, purpose: key.purpose, kid: key.kid, current: key.current,
        publicKey: Buffer.from(key.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'),
        signingKey: 'synthetic-' + key.purpose, signingVersion: 1 })) };
    source = { ENABLE: 'oidc', OIDC_ACCESS_CONFIG: filename, TEST_HUMAN_VAULT_ADDRESS: 'https://vault.synthetic.invalid',
      TEST_HUMAN_VAULT_TOKEN: randomBytes(24).toString('base64url') };
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
  function write () { fs.writeFileSync(filename, JSON.stringify(config)); }

  it('keeps default-off routing free of files, databases and signing-provider dependencies', function () {
    assert.equal(humanRouting({})('arbitrary'), false);
    assert.equal(humanRouting({ ENABLE: 'careportal', OIDC_ACCESS_CONFIG: '/not/a/file' })('arbitrary'), false);
  });

  it('verifies provisioned public keys locally and refuses issuance while Vault is unavailable', async function () {
    write(); const fetch = globalThis.fetch; let calls = 0;
    try {
      globalThis.fetch = async () => { calls++; throw new TypeError('synthetic unreachable provider'); };
      const loaded = loadHumanAccess({ source, mode: 'single', tenants: ['single'] });
      const issued = await local.access.issue({ tenant: 'single', subject: 'reader', session: 'session', purpose: 'data',
        credentialVersion: 1, issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 600 });
      assert.equal(loaded.verify({ tenant: 'single', token: issued }).sub, 'reader');
      assert.equal(calls, 0);
      await assert.rejects(loaded.issue({ tenant: 'single', subject: 'reader', session: 'session', purpose: 'data',
        credentialVersion: 1, issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 600 }), { code: 'HUMAN_SESSION_UNAVAILABLE' });
      assert.equal(calls, 1);
    } finally { globalThis.fetch = fetch; }
  });

  it('rejects headless namespace collisions and arbitrary single auth scopes before any signing', function () {
    write();
    assert.throws(() => loadHumanAccess({ source, mode: 'single', tenants: ['single'],
      legacyProfiles: [{ issuer: local.issuer, audience: local.audiences.management }] }), /disjoint/);
    config.keys[0].tenant = 'arbitrary'; write();
    assert.throws(() => loadHumanAccess({ source, mode: 'single', tenants: ['single'] }), TypeError);
    assert.throws(() => loadHumanAccess({ source, mode: 'single', tenants: ['arbitrary'] }), TypeError);
  });

  it('requires explicit private signer references and refuses private material in the public binding file', function () {
    write(); const absent = { ...source }; delete absent.TEST_HUMAN_VAULT_TOKEN;
    assert.throws(() => loadHumanAccess({ source: absent, mode: 'single', tenants: ['single'] }), TypeError);
    config.keys[0].privateKey = 'forbidden'; write();
    assert.throws(() => loadHumanAccess({ source, mode: 'single', tenants: ['single'] }), TypeError);
  });
});
