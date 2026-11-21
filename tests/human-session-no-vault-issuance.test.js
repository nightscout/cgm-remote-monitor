'use strict';

// Gate (decision deployment-signing-secret): multitenant human-session issuance
// never calls Vault. Login and renewal reach a signer only through the access
// object's issue() (lib/human-session/engine.js), so every multitenant access
// composition is exercised here with the network and the Vault Transit signer
// trapped: registry mode (registry-access) and the static key list
// (access-config loadHumanAccess, mode multi). A single site's Vault-bound key
// list is outside this decision and is not covered.
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fixture = require('./fixtures/signing-secret');
const derived = require('../lib/secrets/derived-signing');

const LIB = path.join(__dirname, '..', 'lib');
const SIGNER = require.resolve(path.join(LIB, 'secrets/vault-access-signing'));
const LOADERS = ['human-session/access-config', 'human-session/registry-access'].map(name => require.resolve(path.join(LIB, name)));
const A = randomUUID(), B = randomUUID();
const ISSUER = 'https://human.synthetic.invalid';
const AUDIENCES = { data: 'synthetic-human-data', management: 'synthetic-human-management' };
const VAULT = { addressEnv: 'SYNTHETIC_VAULT_ADDR', tokenEnv: 'SYNTHETIC_VAULT_TOKEN', mount: 'transit' };
const VAULT_ENV = { SYNTHETIC_VAULT_ADDR: 'https://vault.synthetic.invalid', SYNTHETIC_VAULT_TOKEN: 'synthetic-placeholder' };

// Fresh copies of the access loaders bound to a counting stand-in for the Vault
// Transit signer, with fetch and node http(s) requests trapped and counted.
function trapped () {
  const counts = { signers: 0, network: 0 };
  const saved = { fetch: globalThis.fetch, http: http.request, https: https.request, signer: require.cache[SIGNER] };
  const refuse = () => { counts.network++; throw new Error('network forbidden during human-session issuance'); };
  globalThis.fetch = async () => refuse();
  http.request = refuse; https.request = refuse;
  const real = require(SIGNER);
  require.cache[SIGNER] = { ...saved.signer, id: SIGNER, filename: SIGNER, loaded: true,
    exports: { createVaultAccessSigner: options => { counts.signers++; return real.createVaultAccessSigner(options); } } };
  for (const file of LOADERS) delete require.cache[file];
  const accessConfig = require(LOADERS[0]), registryAccess = require(LOADERS[1]);
  return { counts, accessConfig, registryAccess, restore () {
    globalThis.fetch = saved.fetch; http.request = saved.http; https.request = saved.https;
    if (saved.signer) require.cache[SIGNER] = saved.signer; else delete require.cache[SIGNER];
    for (const file of LOADERS) delete require.cache[file];
  } };
}

function staticKeys (tenants, signing = fixture.signing, version = 1) {
  return tenants.flatMap(tenant => ['data', 'management'].map(purpose => {
    const key = signing.key(tenant, 'human-' + purpose, version);
    return { tenant, purpose, kid: key.kid, publicKey: key.raw, current: true };
  }));
}
const staticSource = (extra = {}, keys = staticKeys([A, B])) => ({ ...fixture.env(), ...VAULT_ENV,
  OIDC_ACCESS_CONFIG: JSON.stringify({ version: 1, issuer: ISSUER, audiences: AUDIENCES, keys, ...extra }) });

async function issueAndVerify (access, tenant) {
  const at = Math.floor(Date.now() / 1000), kids = [];
  for (const purpose of ['data', 'management']) {
    const token = await access.issue({ tenant, subject: 'synthetic_subject', session: 'synthetic_session_' + purpose, purpose,
      credentialVersion: 1, issuedAt: at, expiresAt: at + 600 });
    const claims = await access.verify({ tenant, token });
    assert.equal(claims.tid, tenant); assert.equal(claims.purpose, purpose);
    kids.push(claims.kid);
  }
  return kids;
}

describe('human-session issuance makes no Vault call (multitenant)', function () {
  let lab;
  beforeEach(() => { lab = trapped(); });
  afterEach(() => lab.restore());

  it('NV_STATIC: a multitenant static key list issues and renews with derived keys, no Vault signer and no network', async function () {
    const access = lab.accessConfig.loadHumanAccess({ source: staticSource(), mode: 'multi', tenants: [A, B] });
    assert.deepEqual(await issueAndVerify(access, A), ['human-data-1', 'human-management-1']);
    // Renewal issues again through the same seam (engine.issue -> access.issue).
    assert.deepEqual(await issueAndVerify(access, B), ['human-data-1', 'human-management-1']);
    assert.deepEqual(lab.counts, { signers: 0, network: 0 });
  });

  it('NV_STATIC_VAULT: a multitenant static key list naming a Vault signer refuses at start', function () {
    const keys = staticKeys([A]).map(key => ({ ...key, signingKey: 'synthetic-' + key.purpose, signingVersion: 1 }));
    assert.throws(() => lab.accessConfig.loadHumanAccess({ source: staticSource({ vault: VAULT }, keys), mode: 'multi', tenants: [A] }),
      /derived keys|configuration/);
    assert.throws(() => lab.accessConfig.loadHumanAccess({ source: staticSource({ vault: VAULT }), mode: 'multi', tenants: [A, B] }),
      /derived keys|configuration/);
    assert.equal(lab.counts.signers, 0);
  });

  it('NV_STATIC_FOREIGN: a static public key that is not this deployment\'s derivation refuses at start', function () {
    const foreign = derived.fromSecret(Buffer.alloc(32, 7));
    assert.throws(() => lab.accessConfig.loadHumanAccess({ source: staticSource({}, staticKeys([A], foreign)), mode: 'multi', tenants: [A] }),
      /configuration/);
    assert.equal(lab.counts.signers, 0);
  });

  it('NV_REGISTRY: registry-backed human access issues with derived keys, no Vault signer and no network', async function () {
    const entries = new Map([A, B].map(tenant => [tenant, Object.freeze({ tenant, state: 'active', signingVersion: 1,
      keys: ['management', 'human-data', 'human-management'].map(purpose => {
        const key = fixture.signing.key(tenant, purpose, 1);
        return { purpose, kid: key.kid, publicKey: key.raw };
      }) })]));
    const source = { ...fixture.env(), OIDC_ACCESS_CONFIG: JSON.stringify({ version: 1, registry: true, issuer: ISSUER, audiences: AUDIENCES }) };
    const access = lab.registryAccess.createRegistryHumanAccess({ source, registry: { maxTenants: 2, entry: async tenant => entries.get(tenant) } });
    assert.deepEqual(await issueAndVerify(access, A), ['human-data-1', 'human-management-1']);
    assert.deepEqual(await issueAndVerify(access, B), ['human-data-1', 'human-management-1']);
    assert.deepEqual(lab.counts, { signers: 0, network: 0 });
  });

  it('NV_CONTROL: the trap sees a Vault-bound signer (single site), so a green run is not a blind trap', async function () {
    const keys = staticKeys([A]).map(key => ({ ...key, tenant: 'single', signingKey: 'synthetic-' + key.purpose, signingVersion: 1 }));
    const access = lab.accessConfig.loadHumanAccess({ source: staticSource({ vault: VAULT }, keys), mode: 'single', tenants: ['single'] });
    assert.equal(lab.counts.signers, 2);
    const at = Math.floor(Date.now() / 1000);
    await assert.rejects(access.issue({ tenant: 'single', subject: 'synthetic_subject', session: 'synthetic_session', purpose: 'data',
      credentialVersion: 1, issuedAt: at, expiresAt: at + 600 }), { code: 'HUMAN_SESSION_UNAVAILABLE' });
    assert.equal(lab.counts.network, 1);
  });
});
