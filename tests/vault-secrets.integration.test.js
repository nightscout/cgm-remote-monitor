'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createSecrets } = require('../lib/secrets/component');
const { createVaultTransit } = require('../lib/secrets/vault-transit');
const { optInSuite } = require('./support/opt-in');

const image = 'hashicorp/vault@sha256:962a92876e168d68eaaa24b0b8b49bbce1cb63024060a67bba95cd158a366fc2';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

optInSuite(process.env.NS_VAULT_DOCKER_TEST === '1', 'NS_VAULT_DOCKER_TEST=1')('Vault secrets adapter (disposable Docker)', function () {
  this.timeout(30000);
  const name = 'ns-secrets-test-' + crypto.randomBytes(8).toString('hex');
  const root = crypto.randomBytes(32).toString('hex');
  const tokens = new Map(), providers = new Map(), records = new Map(), events = [];
  const context = tenant => ({ tenant, principal: 'test-issuer', consumer: 'test-runtime' });
  let owned = false, address, component;

  async function api (path, body, token = root) {
    const response = await fetch(address + '/v1/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    });
    assert.ok(response.ok, 'Vault test fixture HTTP ' + response.status);
    return response.status === 204 ? {} : response.json();
  }

  // Vault holds per tenant only the data key (decision deployment-signing-secret).
  function provider (tenant, overrides = {}) {
    return createVaultTransit({
      address, mount: 'transit', encryptionKey: tenant + '-data',
      getToken: async () => tokens.get(tenant), allowInsecureLoopback: true, ...overrides
    });
  }

  before(async function () {
    execFileSync('docker', ['run', '--rm', '--name', name, '-d', '-p', '127.0.0.1::8200',
      '-e', 'VAULT_DEV_ROOT_TOKEN_ID', image, 'server', '-dev', '-dev-listen-address=0.0.0.0:8200'],
    { env: { ...process.env, VAULT_DEV_ROOT_TOKEN_ID: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    owned = true;
    address = 'http://127.0.0.1:' + docker(['port', name, '8200/tcp']).split(':').pop();
    const deadline = Date.now() + 15000;
    let ready = false;
    do {
      try {
        const health = await fetch(address + '/v1/sys/health', { signal: AbortSignal.timeout(1000) });
        ready = health.ok;
        await health.body.cancel();
      } catch (error) {
        if (!error.cause || !['ECONNREFUSED', 'UND_ERR_SOCKET', 'ECONNRESET'].includes(error.cause.code)) throw error;
      }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
    } while (!ready && Date.now() < deadline);
    assert.ok(ready, 'owned Vault must become responsive');
    assert.equal(docker(['inspect', '--format', '{{.State.Running}}', name]), 'true');
    await api('sys/mounts/transit', { type: 'transit' });
    for (const tenant of ['tenant-a', 'tenant-b']) {
      await api('transit/keys/' + tenant + '-data', { type: 'aes256-gcm96', exportable: false });
      const policy = ['encrypt', 'decrypt'].map(op =>
        `path "transit/${op}/${tenant}-data" { capabilities = ["update"] }`).join('\n');
      await api('sys/policies/acl/' + tenant, { policy });
      const result = await api('auth/token/create', {
        policies: [tenant], no_default_policy: true, ttl: '5m', renewable: false
      });
      tokens.set(tenant, result.auth.client_token);
      providers.set(tenant, provider(tenant));
    }
    component = createSecrets({
      providerFor: async tenant => {
        assert.ok(providers.has(tenant), 'no default provider');
        return providers.get(tenant);
      },
      authorize: async c => c.principal === 'test-issuer' && c.consumer === 'test-runtime',
      audit: async event => { events.push(event); },
      store: {
        async insert (record) {
          const id = JSON.stringify([record.tenant, record.id]);
          assert.ok(!records.has(id), 'immutable reference');
          records.set(id, record);
        },
        async get (tenant, id) { return records.get(JSON.stringify([tenant, id])); }
      },
      maxTokenLifetimeSeconds: 60
    });
  });

  after(function () { if (owned) docker(['rm', '-f', '-v', name]); });

  it('encrypts stored references and reveals only through the audited component', async function () {
    const ref = await component.encrypt(context('tenant-a'), 'connector', Buffer.from('synthetic-secret'));
    assert.equal((await component.decrypt(context('tenant-a'), ref)).toString(), 'synthetic-secret');
    assert.equal((await component.reveal(context('tenant-a'), ref)).toString(), 'synthetic-secret');
    assert.match([...records.values()][0].ciphertext, /^vault:v1:/);
    assert.equal(events.at(-1).operation, 'reveal');
    assert.doesNotMatch(JSON.stringify([...records.values(), ...events]), /synthetic-secret/);
    await assert.rejects(component.decrypt(context('tenant-b'), ref), { code: 'SECRETS_REFERENCE_MISMATCH' });
  });

  // The HS256 profile, Transit HMAC signing and the Vault-backed DATA verifier
  // and exchange are retired (decision deployment-signing-secret); their tests
  // retired with them. DATA credentials are covered by the local verifier suites.

  it('enforces tenant-scoped provider ACLs even when a foreign key is configured', async function () {
    const foreign = provider('tenant-a', { encryptionKey: 'tenant-b-data' });
    await assert.rejects(foreign.encrypt(Buffer.from('synthetic-secret')), { code: 'SECRETS_PROVIDER_REFUSED' });
  });

  it('keeps old ciphertext usable through provider data key rotation', async function () {
    const ref = await component.encrypt(context('tenant-a'), 'rotation', Buffer.from('synthetic-rotation'));
    await api('transit/keys/tenant-a-data/rotate', {});
    providers.set('tenant-a', provider('tenant-a'));
    assert.equal((await component.decrypt(context('tenant-a'), ref)).toString(), 'synthetic-rotation');
    const fresh = await component.encrypt(context('tenant-a'), 'rotation-fresh', Buffer.from('synthetic-fresh'));
    assert.equal((await component.decrypt(context('tenant-a'), fresh)).toString(), 'synthetic-fresh');
  });

  it('red control: overbroad provider credentials can decrypt another tenant outside the component', async function () {
    const a = providers.get('tenant-a');
    const ciphertext = await a.encrypt(Buffer.from('synthetic-control'));
    const broad = provider('tenant-b', { encryptionKey: 'tenant-a-data', getToken: async () => root });
    assert.equal((await broad.decrypt(ciphertext)).toString(), 'synthetic-control');
  });

  it('refuses revoked provider credentials without plaintext', async function () {
    await api('auth/token/revoke', { token: tokens.get('tenant-b') });
    await assert.rejects(component.encrypt(context('tenant-b'), 'revoked', Buffer.from('synthetic-secret')),
      { code: 'SECRETS_PROVIDER_REFUSED' });
    assert.equal(records.has(JSON.stringify(['tenant-b', 'revoked'])), false);
  });
});
