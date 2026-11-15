'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const scope = require('../lib/storage/tenant-scope');
const material = require('../lib/secrets/legacy-verifiers');
const createAuthority = require('../lib/tenant-authorization/postgres');
const tokens = require('../lib/tenant-authorization/legacy-data-token');
const createSocket = require('../lib/server/realtime/authority').create;
const createExchange = require('../lib/server/tenant-app/local-exchange');
const createAdmin = require('../lib/server/tenant-app/root-admin').createRootAuthentication;
const createDataAccess = require('../lib/server/tenant-app/data-access');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const hash = value => crypto.createHash('sha1').update(value).digest('hex');
const root = 'synthetic-local-authority-root';
const credential = 'named-' + hash(hash(root) + 'subject').slice(0, 16);
async function fixture () {
  const key = tokens.generateKey(), codec = tokens.create({ issuer: 'synthetic', audience: 'synthetic', now: () => 1700000000 });
  const prepared = material.prepare(Buffer.from(root), [{ subjectId: 'subject', tokenPrefix: 'named' }]);
  const states = new Map([A, B].map(tenant => [tenant, { ...prepared, rootVersion: 1, keys: [{ ...key, active: true }],
    subjects: prepared.subjects.map(subject => ({ ...subject, credentialVersion: 1 })) }]));
  const grants = new Map([[A, ['api:entries:read', 'api:entries:create']], [B, []]]), queries = [];
  const connection = {
    withTenant: (tenant, fn) => scope.withTenant(tenant, fn),
    async query ({ text, values }) {
      if (text.includes('FROM pg_class')) return { rows: Array.from({ length: 4 }, () =>
        ({ secured: true, owns: false, reads: true, writes: false, column_reads: true })) };
      queries.push({ tenant: scope.requireTenant(), subject: values[1] });
      assert.equal(scope.requireTenant(), values[0]);
      return { rows: [{ anonymous_roles: ['denied'], subject_id: 'subject', display_name: 'Synthetic subject',
        found_subject: 'subject', role_name: 'custom', found_role: 'custom', permissions: grants.get(values[0]) }] };
    }
  };
  const authority = await createAuthority({ namespace: 'test_auth', connection });
  const credentials = material.create({ read: async tenant => states.get(tenant), verifyToken: codec.verify });
  const access = createDataAccess({ secrets: credentials, authority,
    verifierContext: async tenant => ({ tenant, consumer: 'api' }), legacyCollections: ['entries'] });
  const verifierContext = async tenant => ({ tenant, principal: 'api', consumer: 'api' });
  const socket = createSocket({ secrets: credentials, authority, verifierContext, admission: { allows: async () => true } });
  const exchange = createExchange({ credentials, secrets: credentials, authority, verifierContext,
    store: { signingKey: async () => key }, codec, audit: async () => {}, now: () => 1700000000000 });
  const admin = createAdmin({ secrets: { ...credentials, rootLegacyTokens: async () => [], adminLegacyTokens: async () => [] },
    authority, verifierContext, tenants: [A, B] });
  const request = (tenant = A, secret = credential, method = 'POST') => access({ tenant, version: 1,
    request: { method, path: '/entries', query: {}, rawHeaders: ['api-secret', secret] } });
  return { access, authority, credentials, request, grants, queries, states, socket, exchange, admin, codec };
}
describe('local verified credentials and strict PostgreSQL authority contract', function () {
  let old;
  before(() => { old = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  after(() => scope.setTenancyMode(old));
  it('authorizes a local named subject write using current strict authority', async function () {
    const f = await fixture();
    assert.equal((await f.request()).principal, 'subject');
    assert.equal(f.queries.length, 1);
    assert.deepEqual(f.queries[0], { tenant: A, subject: 'subject' });
  });
  it('retains root behavior, separates tenants and observes next-request revocation', async function () {
    const f = await fixture();
    assert.equal((await f.request(A, hash(root))).principal, 'root');
    await assert.rejects(f.request(B), { code: 'TENANT_LEGACY_FORBIDDEN' });
    assert.equal((await f.request()).principal, 'subject');
    f.grants.set(A, []);
    await assert.rejects(f.request(), { code: 'TENANT_LEGACY_FORBIDDEN' });
  });


  it('projects legacy token callbacks while preserving mixed root precedence', async function () {
    const f = await fixture();
    const call = secret => f.access({ tenant: A, version: 1, request: { method: 'POST', path: '/entries',
      query: { token: credential }, rawHeaders: secret ? ['api-secret', secret] : [] } });
    assert.equal((await call()).principal, 'subject');
    f.grants.set(A, []);
    assert.equal((await call(hash(root))).principal, 'root', 'a current named token does not restrict separately verified root');
    f.states.get(A).subjects = [];
    assert.equal(await call(hash(root)), null, 'mixed credentials still require a current named token subject');
  });
  it('retains signed credential generations through exchange and rejects stale or foreign tokens', async function () {
    const f = await fixture();
    const issued = await f.exchange({ tenant: A, credential });
    const claims = JSON.parse(Buffer.from(issued.token.split('.')[1], 'base64url'));
    assert.equal(claims.cv, 1); assert.equal(claims.rv, 1);
    const jwtRequest = tenant => createDataAccess({ secrets: f.credentials, authority: f.authority,
      verifierContext: async selected => ({ tenant: selected, consumer: 'api' }), legacyCollections: ['entries'] })({
      tenant, version: 1, request: { method: 'POST', path: '/entries', query: {}, rawHeaders: ['Authorization', 'Bearer ' + issued.token] } });
    assert.equal((await jwtRequest(A)).principal, 'subject');
    assert.equal(await jwtRequest(B), null, 'foreign token refused before authority');
    f.states.get(A).subjects[0] = { ...f.states.get(A).subjects[0], credentialVersion: 2 };
    assert.equal(await jwtRequest(A), null, 'stale credential generation refused before authority');
    f.states.get(A).subjects[0] = { ...f.states.get(A).subjects[0], credentialVersion: 1 };
    f.states.get(A).rootVersion = 2;
    assert.equal(await jwtRequest(A), null, 'stale root generation refused before authority');
  });
  it('uses strict identity for realtime and named administrator authorization', async function () {
    const f = await fixture();
    const verify = tenant => f.socket.verify({ tenant, namespace: '/storage', credential: { accessToken: credential } });
    assert.equal((await verify(A)).principal.subjectId, 'subject');
    assert.equal((await verify(B)).permissions.read, false);
    const admin = tenant => f.admin({ tenant, permission: 'admin:api:subjects:read',
      request: { query: {}, rawHeaders: ['api-secret', credential] } });
    assert.equal(await admin(A), null, 'entry permission does not grant administration');
    f.grants.set(A, ['admin:api:subjects:read']);
    assert.equal((await admin(A)).actor.principal, 'subject');
    assert.equal(await admin(B), null);
    f.grants.set(A, []);
    assert.equal(await admin(A), null, 'next administrator request sees revocation');
    assert.equal((await verify(A)).permissions.read, false, 'next realtime request sees revocation');
  });
  it('does not remove unexpected principal fields at the authority boundary', async function () {
    const f = await fixture();
    const projection = require('../lib/tenant-authorization/authority-principal');
    const principal = projection({ kind: 'subject', subjectId: 'subject', credentialVersion: 1, rootVersion: 1, unexpected: true });
    await assert.rejects(f.authority.subjectAuthorizationSnapshot({ tenant: A, principal }),
      { code: 'TENANT_AUTHORITY_PRINCIPAL_INVALID' });
  });
  it('control: authority still rejects verifier metadata in its principal contract', async function () {
    const f = await fixture();
    const principal = await f.credentials.verifyLegacyCredential({ tenant: A }, { apiSecret: credential });
    assert.equal(principal.credentialVersion, 1); assert.equal(principal.rootVersion, 1);
    await assert.rejects(f.authority.subjectAuthorizationSnapshot({ tenant: A, principal }),
      { code: 'TENANT_AUTHORITY_PRINCIPAL_INVALID' });
    assert.equal(f.queries.length, 0, 'malformed authority principal reaches no authority SQL');
  });
});
