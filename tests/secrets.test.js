'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { createSecrets } = require('../lib/secrets/component');
const { createVaultTransit } = require('../lib/secrets/vault-transit');

// Test-only provider: never a production built-in backend or persisted key store.
function memoryProvider () {
  const encryption = crypto.randomBytes(32);
  const keys = [null, crypto.randomBytes(32), crypto.randomBytes(32)];
  return {
    signingVersion: 1,
    async encrypt (input) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', encryption, iv);
      return Buffer.concat([iv, cipher.update(input), cipher.final(), cipher.getAuthTag()]).toString('base64');
    },
    async decrypt (ciphertext) {
      const bytes = Buffer.from(ciphertext, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', encryption, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
    },
    async sign (input) { return crypto.createHmac('sha256', keys[this.signingVersion]).update(input).digest(); },
    async verify (version, input, signature) {
      return !!keys[version] && crypto.timingSafeEqual(
        crypto.createHmac('sha256', keys[version]).update(input).digest(), signature);
    }
  };
}

describe('provider-neutral secrets boundary', function () {
  let providers, records, events, grants, time, component, options;
  const a = { tenant: 'tenant-a', principal: 'root-a', consumer: 'issuer' };
  const b = { tenant: 'tenant-b', principal: 'root-b', consumer: 'issuer' };
  const key = (tenant, id) => JSON.stringify([tenant, id]);

  beforeEach(function () {
    providers = new Map([['tenant-a', memoryProvider()], ['tenant-b', memoryProvider()]]);
    records = new Map();
    events = [];
    grants = new Set(['tenant-a:issuer', 'tenant-b:issuer']);
    time = 1700000000000;
    options = {
      providerFor: async tenant => {
        assert.ok(providers.has(tenant), 'unknown tenant must never default');
        return providers.get(tenant);
      },
      store: {
        async insert (record) {
          assert.ok(!records.has(key(record.tenant, record.id)), 'duplicate secret reference');
          records.set(key(record.tenant, record.id), record);
        },
        async get (tenant, id) { return records.get(key(tenant, id)); }
      },
      authorize: async context => grants.has(context.tenant + ':' + context.consumer),
      audit: async event => { events.push(event); },
      maxTokenLifetimeSeconds: 60,
      now: () => time
    };
    component = createSecrets(options);
  });

  it('stores ciphertext only, preserves binary values, and refuses duplicate references', async function () {
    const secret = Buffer.from([0, 255, 12, 34]);
    const ref = await component.encrypt(a, 'connector', secret);
    assert.deepEqual(await component.decrypt(a, ref), secret);
    assert.equal(JSON.stringify([...records.values()]).includes(secret.toString('base64')), false);
    await assert.rejects(component.encrypt(a, 'connector', Buffer.from('new')), /duplicate/);
    await assert.rejects(component.decrypt(a, { tenant: a.tenant, id: 'missing' }), { code: 'SECRETS_NOT_FOUND' });
  });

  it('rejects foreign references, wrong-tenant rows and ciphertext copied to another reference', async function () {
    const ref = await component.encrypt(a, 'connector', Buffer.from('synthetic-secret'));
    await assert.rejects(component.decrypt(b, ref), { code: 'SECRETS_REFERENCE_MISMATCH' });
    const record = records.get(key(a.tenant, ref.id));
    records.set(key(b.tenant, ref.id), record);
    await assert.rejects(component.decrypt(b, { tenant: b.tenant, id: ref.id }), { code: 'SECRETS_RECORD_INVALID' });
    records.set(key(a.tenant, 'copy'), { ...record, id: 'copy' });
    await assert.rejects(component.decrypt(a, { tenant: a.tenant, id: 'copy' }), { code: 'SECRETS_RECORD_INVALID' });
  });

  it('checks current named-consumer authority on every operation across instances', async function () {
    const ref = await component.encrypt(a, 'connector', Buffer.from('secret'));
    const secondWorker = createSecrets(options);
    grants.delete('tenant-a:issuer');
    await assert.rejects(secondWorker.decrypt(a, ref), { code: 'SECRETS_FORBIDDEN' });
    await assert.rejects(component.signJWT(a, 'subject-token', 30), { code: 'SECRETS_FORBIDDEN' });
    assert.equal(events.length, 1);
    await assert.rejects(component.decrypt({ ...a, consumer: 'other' }, ref), { code: 'SECRETS_FORBIDDEN' });
  });

  it('separates reveal permission and awaits a redacted audit receipt before decryption', async function () {
    const ref = await component.encrypt(a, 'connector', Buffer.from('secret-to-reveal'));
    const protectedComponent = createSecrets({
      ...options,
      authorize: async (context, action) => action.operation !== 'reveal'
    });
    await assert.rejects(protectedComponent.reveal(a, ref), { code: 'SECRETS_FORBIDDEN' });
    assert.equal((await protectedComponent.decrypt(a, ref)).toString(), 'secret-to-reveal');
    let decrypted = false;
    const original = providers.get(a.tenant).decrypt;
    providers.get(a.tenant).decrypt = async value => { decrypted = true; return original(value); };
    const brokenAudit = createSecrets({ ...options, audit: async () => { throw new Error('audit unavailable'); } });
    await assert.rejects(brokenAudit.reveal(a, ref), /audit unavailable/);
    assert.equal(decrypted, false);
    assert.equal((await component.reveal(a, ref)).toString(), 'secret-to-reveal');
    assert.equal(events.at(-1).operation, 'reveal');
    assert.doesNotMatch(JSON.stringify(events), /secret-to-reveal|ciphertext|plaintext/);
  });

  it('fails closed on authorization and provider outages without a fallback', async function () {
    const ref = await component.encrypt(a, 'connector', Buffer.from('secret'));
    const outage = createSecrets({
      ...options, authorize: async () => { throw new Error('authorization unavailable'); }
    });
    await assert.rejects(outage.decrypt(a, ref), /authorization unavailable/);
    providers.get(a.tenant).decrypt = async () => { throw new Error('provider unavailable'); };
    await assert.rejects(component.decrypt(a, ref), /provider unavailable/);
  });

  it('mints bounded tenant-bound HS256 JWTs and preserves the legacy accessToken claim', async function () {
    const token = await component.signJWT(a, 'subject-token', 30);
    const payload = await component.verifyJWT(a, token);
    assert.equal(payload.accessToken, 'subject-token');
    assert.equal(payload.exp - payload.iat, 30);
    await assert.rejects(component.verifyJWT(b, token), { code: 'SECRETS_TOKEN_INVALID' });
    await assert.rejects(component.signJWT(a, 'subject-token', 61), { code: 'SECRETS_TOKEN_LIFETIME' });
    await assert.rejects(component.signJWT(a, 'subject-token', 0), { code: 'SECRETS_TOKEN_LIFETIME' });
    time += 30000;
    await assert.rejects(component.verifyJWT(a, token), { code: 'SECRETS_TOKEN_INVALID' });
    assert.doesNotMatch(JSON.stringify(events), /subject-token/);
  });

  it('verifies earlier key versions after rotation and refuses tampering or unsupported algorithms', async function () {
    const first = await component.signJWT(a, 'subject-token', 30);
    providers.get(a.tenant).signingVersion = 2;
    const second = await component.signJWT(a, 'subject-token', 30);
    assert.equal((await component.verifyJWT(a, first)).accessToken, 'subject-token');
    assert.equal((await component.verifyJWT(a, second)).accessToken, 'subject-token');
    assert.equal(JSON.parse(Buffer.from(second.split('.')[0], 'base64url')).kid, '2');
    for (const token of ['bad', 'null.e30.Zm9v', first.replace(/.$/, '!'),
      Buffer.from('{"alg":"none","typ":"JWT","kid":"1"}').toString('base64url') + '.' + first.split('.').slice(1).join('.')]) {
      await assert.rejects(component.verifyJWT(a, token), { code: 'SECRETS_TOKEN_INVALID' });
    }
  });

  it('enforces tenant audience even if an operator accidentally binds two tenants to one signing key', async function () {
    providers.set(b.tenant, providers.get(a.tenant));
    const token = await component.signJWT(a, 'subject-token', 30);
    await assert.rejects(component.verifyJWT(b, token), { code: 'SECRETS_TOKEN_INVALID' });
  });

  it('does not turn a verified JWT into authorization after grant removal', async function () {
    const token = await component.signJWT(a, 'subject-token', 30);
    await component.verifyJWT(a, token);
    grants.delete('tenant-a:issuer');
    await assert.rejects(component.verifyJWT(a, token), { code: 'SECRETS_FORBIDDEN' });
  });
});

describe('Vault adapter transport refusal', function () {
  let server, address, handler;
  const config = () => ({
    address, mount: 'transit', encryptionKey: 'tenant-a-data', signingKey: 'tenant-a-signing',
    signingVersion: 1, getToken: async () => 'synthetic-provider-credential', allowInsecureLoopback: true
  });

  before(async function () {
    server = http.createServer((req, res) => handler(req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    address = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () { await new Promise(resolve => server.close(resolve)); });

  it('rejects insecure non-loopback origins, embedded credentials and caller-controlled key paths', function () {
    for (const overrides of [
      { address: 'http://example.test' }, { address: 'https://user:password@example.test' },
      { address: 'https://example.test/path' }, { encryptionKey: '../tenant-b' }, { timeoutMs: 0 },
      { encryptionKey: 'same', signingKey: 'same' }
    ]) assert.throws(() => createVaultTransit({ ...config(), ...overrides }), TypeError);
  });

  it('does not follow redirects or disclose provider error bodies or credentials', async function () {
    let calls = 0;
    handler = (req, res) => {
      calls++;
      res.writeHead(307, { Location: address + '/stolen' });
      res.end('secret-provider-body');
    };
    await assert.rejects(createVaultTransit(config()).encrypt(Buffer.from('secret')), error => {
      assert.equal(error.code, 'SECRETS_PROVIDER_REFUSED');
      assert.doesNotMatch(String(error), /secret-provider-body|synthetic-provider-credential/);
      return true;
    });
    assert.equal(calls, 1);
  });

  it('redacts malformed responses and rejects wrong-version or short HMACs', async function () {
    for (const body of ['plaintext-sensitive-not-json', '{"data":{"hmac":"vault:v2:YWJj"}}',
      '{"data":{"hmac":"vault:v1:YWJj"}}']) {
      handler = (req, res) => { res.end(body); };
      await assert.rejects(createVaultTransit(config()).sign(Buffer.from('input')), error => {
        assert.match(error.code, /^SECRETS_PROVIDER_/);
        assert.doesNotMatch(String(error), /plaintext-sensitive/);
        return true;
      });
    }
  });

  it('bounds outages and redacts credential acquisition errors', async function () {
    handler = () => {};
    await assert.rejects(createVaultTransit({ ...config(), timeoutMs: 10 }).encrypt(Buffer.from('secret')),
      { code: 'SECRETS_PROVIDER_UNAVAILABLE' });
    await assert.rejects(createVaultTransit({
      ...config(), getToken: async () => { throw new Error('sensitive-token'); }
    }).encrypt(Buffer.from('secret')), error => {
      assert.equal(error.code, 'SECRETS_PROVIDER_UNAVAILABLE');
      assert.doesNotMatch(String(error), /sensitive-token/);
      return true;
    });
  });
});
