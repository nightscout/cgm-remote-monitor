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

  function provider (tenant, signingVersion = 1, overrides = {}) {
    return createVaultTransit({
      address, mount: 'transit', encryptionKey: tenant + '-data', signingKey: tenant + '-signing',
      signingVersion, getToken: async () => tokens.get(tenant), allowInsecureLoopback: true, ...overrides
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
      for (const purpose of ['data', 'signing']) {
        await api('transit/keys/' + tenant + '-' + purpose, { type: 'aes256-gcm96', exportable: false });
      }
      const policy = ['encrypt', 'decrypt'].map(op =>
        `path "transit/${op}/${tenant}-data" { capabilities = ["update"] }`).concat(
        ['hmac', 'verify'].map(op =>
          `path "transit/${op}/${tenant}-signing" { capabilities = ["update"] }`)).join('\n');
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

  after(function () { if (owned) docker(['rm', '-f', name]); });

  it('encrypts stored references and reveals only through the audited component', async function () {
    const ref = await component.encrypt(context('tenant-a'), 'connector', Buffer.from('synthetic-secret'));
    assert.equal((await component.decrypt(context('tenant-a'), ref)).toString(), 'synthetic-secret');
    assert.equal((await component.reveal(context('tenant-a'), ref)).toString(), 'synthetic-secret');
    assert.match([...records.values()][0].ciphertext, /^vault:v1:/);
    assert.equal(events.at(-1).operation, 'reveal');
    assert.doesNotMatch(JSON.stringify([...records.values(), ...events]), /synthetic-secret/);
    await assert.rejects(component.decrypt(context('tenant-b'), ref), { code: 'SECRETS_REFERENCE_MISMATCH' });
  });

  it('signs actual HS256 JWTs using versioned Transit HMAC without exporting keys', async function () {
    const token = await component.signJWT(context('tenant-a'), 'synthetic-subject', 30);
    assert.equal((await component.verifyJWT(context('tenant-a'), token)).accessToken, 'synthetic-subject');
    await assert.rejects(component.verifyJWT(context('tenant-b'), token), { code: 'SECRETS_TOKEN_INVALID' });
    const [header, payload, signature] = token.split('.');
    const verified = await api('transit/verify/tenant-a-signing', {
      input: Buffer.from(header + '.' + payload).toString('base64'),
      hmac: 'vault:v1:' + Buffer.from(signature, 'base64url').toString('base64'),
      hash_algorithm: 'sha2-256'
    }, tokens.get('tenant-a'));
    assert.equal(verified.data.valid, true);
  });

  it('enforces tenant-scoped provider ACLs even when a foreign key is configured', async function () {
    const foreign = provider('tenant-a', 1, { encryptionKey: 'tenant-b-data', signingKey: 'tenant-b-signing' });
    await assert.rejects(foreign.encrypt(Buffer.from('synthetic-secret')), { code: 'SECRETS_PROVIDER_REFUSED' });
    await assert.rejects(foreign.sign(Buffer.from('input')), { code: 'SECRETS_PROVIDER_REFUSED' });
  });

  it('keeps old ciphertext and tokens usable through provider key rotation', async function () {
    const ref = await component.encrypt(context('tenant-a'), 'rotation', Buffer.from('synthetic-rotation'));
    const old = await component.signJWT(context('tenant-a'), 'synthetic-subject', 30);
    await api('transit/keys/tenant-a-data/rotate', {});
    await api('transit/keys/tenant-a-signing/rotate', {});
    providers.set('tenant-a', provider('tenant-a', 2));
    const fresh = await component.signJWT(context('tenant-a'), 'synthetic-subject', 30);
    assert.equal(JSON.parse(Buffer.from(fresh.split('.')[0], 'base64url')).kid, '2');
    await component.verifyJWT(context('tenant-a'), old);
    await component.verifyJWT(context('tenant-a'), fresh);
    assert.equal((await component.decrypt(context('tenant-a'), ref)).toString(), 'synthetic-rotation');
  });

  it('red control: overbroad provider credentials can decrypt another tenant outside the component', async function () {
    const a = providers.get('tenant-a');
    const ciphertext = await a.encrypt(Buffer.from('synthetic-control'));
    const broad = provider('tenant-b', 1, { encryptionKey: 'tenant-a-data', getToken: async () => root });
    assert.equal((await broad.decrypt(ciphertext)).toString(), 'synthetic-control');
  });

  it('verifies imported legacy credentials inside the boundary using Transit decrypt, not Transit HMAC', async function () {
    const rootSecret = crypto.randomBytes(24).toString('hex');
    const subjectId = '000000000000000000000001';
    const sha1 = value => crypto.createHash('sha1').update(value).digest('hex');
    const digest = sha1(sha1(rootSecret) + subjectId);
    await component.encrypt(context('tenant-a'), 'imported-authority', Buffer.from(rootSecret));
    const verifier = createSecrets({
      providerFor: async tenant => ({
        ...providers.get(tenant),
        async sign () { throw new Error('legacy verification must not call Transit HMAC'); }
      }),
      authorize: async c => c.principal === 'test-issuer' && c.consumer === 'test-runtime',
      audit: async event => { events.push(event); },
      store: { async get (tenant, id) { return records.get(JSON.stringify([tenant, id])); },
        async insert () { throw new Error('verifier cannot provision'); } },
      maxTokenLifetimeSeconds: 60,
      legacyAuthorityFor: async tenant => ({
        reference: { tenant, id: 'imported-authority' },
        subjects: [{ subjectId, tokenPrefix: 'same_name' }]
      })
    });
    assert.deepEqual(await verifier.verifyLegacyCredential(context('tenant-a'), { apiSecret: sha1(rootSecret) }),
      { kind: 'root' });
    assert.deepEqual(await verifier.verifyLegacyCredential(context('tenant-a'),
      { apiSecret: 'same_name-' + digest.slice(0, 16) }), { kind: 'subject', subjectId });
    assert.equal(await verifier.verifyLegacyCredential(context('tenant-a'), { apiSecret: 'invalid' }), null);
    await assert.rejects(verifier.verifyLegacyCredential(context('tenant-b'), { apiSecret: sha1(rootSecret) }),
      { code: 'SECRETS_NOT_FOUND' });
    const transitHmac = await providers.get('tenant-a').sign(Buffer.from(subjectId));
    assert.notEqual(transitHmac.toString('hex'), digest, 'Transit HMAC is not the legacy SHA1 construction');
    assert.equal(events.at(-1).operation, 'decrypt');
    assert.equal(JSON.stringify([...records.values(), ...events]).includes(rootSecret), false);
  });

  it('refuses revoked provider credentials without plaintext or local-signer fallback', async function () {
    await api('auth/token/revoke', { token: tokens.get('tenant-b') });
    await assert.rejects(component.signJWT(context('tenant-b'), 'synthetic-subject', 30),
      { code: 'SECRETS_PROVIDER_REFUSED' });
    await assert.rejects(component.encrypt(context('tenant-b'), 'revoked', Buffer.from('synthetic-secret')),
      { code: 'SECRETS_PROVIDER_REFUSED' });
    assert.equal(records.has(JSON.stringify(['tenant-b', 'revoked'])), false);
  });
});
