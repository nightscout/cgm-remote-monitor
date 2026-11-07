'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { parse } = require('../lib/server/serve/owner-preview-config');
const authentication = require('../lib/server/serve/owner-preview-authentication');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const key = crypto.generateKeyPairSync('ed25519');
const publicKey = Buffer.from(key.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
const environment = { OWNER_WRITE_PG: 'postgres://writer:synthetic@localhost:5432/test', OWNER_READ_PG: 'postgres://reader:synthetic@localhost:5432/test' };
const config = () => ({ version: 1, postgres: { writerConnectionEnv: 'OWNER_WRITE_PG', accessConnectionEnv: 'OWNER_READ_PG',
  namespaces: { authorization: 'owner_auth', credentials: 'owner_credentials', access: 'owner_access' } },
  ownerPolicy: { catalogue: ['api:entries:read'] }, resolution: { mode: 'direct-alias' }, tenants: [{ id: A, aliases: ['one.example.test'] }],
  management: { issuer: 'synthetic-operator', audience: 'synthetic-headless', purpose: 'management', consumer: 'owner-preview',
    keys: [{ tenant: A, kid: 'management-key', publicKey }] } });
function token (override = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = encode({ alg: 'EdDSA', typ: 'ns-access+jwt', kid: 'management-key', ...header }) + '.' +
    encode({ iss: 'synthetic-operator', aud: 'synthetic-headless', tid: A, sub: 'manager', sid: 'session', cv: 1,
      purpose: 'management', iat: now, nbf: now, exp: now + 600, ...override });
  return input + '.' + crypto.sign(null, Buffer.from(input), key.privateKey).toString('base64url');
}
const state = () => ({ active: true, sessionActive: true, keyActive: true, credentialVersion: 1,
  sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
describe('explicit headless owner preview trust boundary', function () {
  it('pins management purpose, ten-minute maximum, issuer/audience/public keys and trusted consumer', async function () {
    const parsed = parse(config(), environment);
    assert.equal(parsed.verification.maxLifetimeSeconds, 600);
    const auth = authentication({ verification: parsed.verification, snapshot: async () => state(), consumer: parsed.consumer });
    assert.deepEqual(await auth({ tenant: A, credential: token() }), { tenant: A, principal: 'manager', consumer: 'owner-preview' });
  });
  it('permits narrower lifetimes but refuses wider/implicit trust, identities and policy', function () {
    const narrower = config(); narrower.management.maxLifetimeSeconds = 60;
    assert.equal(parse(narrower, environment).verification.maxLifetimeSeconds, 60);
    for (const mutate of [c => { c.management.maxLifetimeSeconds = 601; }, c => { c.management.purpose = 'data'; },
      c => { delete c.management.consumer; }, c => { c.management.keys[0].tenant = B; },
      c => { c.management.keys.push(c.management.keys[0]); }, c => { c.postgres.namespaces.access = c.postgres.namespaces.authorization; },
      c => { c.ownerPolicy.catalogue = ['*']; }, c => { c.resolution.trustedPeers = ['127.0.0.1']; }]) {
      const value = config(); mutate(value); assert.throws(() => parse(value, environment));
    }
    assert.throws(() => parse(config(), { ...environment, OWNER_READ_PG: environment.OWNER_WRITE_PG }));
  });
  it('returns null for root/legacy/data/foreign/unknown-key/invalid signatures without reading current state', async function () {
    let reads = 0;
    const parsed = parse(config(), environment);
    const auth = authentication({ verification: parsed.verification, consumer: parsed.consumer, snapshot: async () => { reads++; return state(); } });
    for (const credential of ['synthetic-root', 'synthetic-subject-token', token({ purpose: 'data' }), token({ tid: B }),
      token({}, { kid: 'unknown' }), token({ consumer: 'payload-selected' }), token({ exp: Math.floor(Date.now() / 1000) + 601 }), token() + 'broken']) {
      assert.equal(await auth({ tenant: A, credential }), null);
    }
    assert.equal(reads, 0);
  });
  it('reads the current snapshot on every operation and refuses each revoked state without an identity cache', async function () {
    const parsed = parse(config(), environment); let current = state(), reads = 0;
    const auth = authentication({ verification: parsed.verification, consumer: parsed.consumer, snapshot: async () => { reads++; return current; } });
    const credential = token(); assert(await auth({ tenant: A, credential }));
    for (const change of [null, { active: false }, { sessionActive: false }, { keyActive: false }, { credentialVersion: 2 }, { sessionExpiresAt: 1 }]) {
      current = change === null ? null : { ...state(), ...change };
      assert.equal(await auth({ tenant: A, credential }), null);
    }
    assert.equal(reads, 7);
  });
  it('preserves current authority failures for the management factory sanitized 503 contract', async function () {
    const parsed = parse(config(), environment);
    const error = Object.assign(new Error('synthetic private unavailable'), { code: 'ACCESS_AUTHORITY_UNAVAILABLE' });
    const auth = authentication({ verification: parsed.verification, consumer: parsed.consumer, snapshot: async () => { throw error; } });
    await assert.rejects(auth({ tenant: A, credential: token() }), value => value === error);
  });
  it('keeps owner handlers off the data listener in an explicitly composed process', async function () {
    const Module = require('node:module');
    const listeners = require('../lib/server/serve/listeners');
    const serve = require('../lib/server/serve');
    const open = listeners.open, close = listeners.close, load = Module._load;
    const owner = { routes: ['/api/v2/authorization/subjects'] }, data = { routes: ['/api/v3/entries'] };
    try {
      Module._load = function (name, ...args) {
        if (name === './owner-preview') return { boot: async () => ({ app: owner, close: async () => {} }) };
        if (name === './preview-api') return { boot: async () => ({ app: data, close: async () => {} }) };
        return load.call(this, name, ...args);
      };
      listeners.open = async (spec, app) => ({ app, role: spec.role, address: () => ({ address: '127.0.0.1', port: 0 }) });
      listeners.close = async () => {};
      const result = await serve.start(['tenant-admin', 'api'], { HOSTNAME: '127.0.0.1', PORT: 0 }, null,
        { TENANT_ADMIN_HOSTNAME: '127.0.0.1', TENANT_ADMIN_PORT: '0', API_HOSTNAME: '127.0.0.1', API_PORT: '0' },
        { preview: {}, ownerPreview: {} });
      try {
        assert.equal(result.servers.find(server => server.role === 'api').app.routes.includes('/api/v2/authorization/subjects'), false,
          'data listener must not expose management route');
        assert.equal(result.servers.find(server => server.role === 'tenant-admin').app, owner);
      } finally { await result.stop(); }
    } finally { Module._load = load; listeners.open = open; listeners.close = close; }
  });
});
