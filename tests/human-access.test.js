'use strict';
const assert = require('node:assert/strict');
const { createHumanAccess } = require('../lib/human-session/access');
const token = require('../lib/tenant-authorization/access-token');
const fixture = require('./fixtures/human-access-issuer');

describe('asymmetric human access and closed verification profiles', function () {
  const tenant = '11111111-1111-4111-8111-111111111111';
  let clock, source;
  beforeEach(() => { clock = 1000; source = fixture({ tenant, now: () => clock }); });
  const input = (binding = tenant, overrides = {}) => ({ tenant: binding, subject: 'local_subject', session: 'human_session',
    purpose: 'management', credentialVersion: 1, issuedAt: 1000, expiresAt: 1600, ...overrides });

  it('issues actual Ed25519 ns-access JWTs with only the existing pinned local claims', async function () {
    const issued = await source.access.issue(input());
    const claims = source.access.verify({ tenant, token: issued });
    assert.equal(claims.sub, 'local_subject'); assert.equal(claims.sid, 'human_session');
    assert.equal(claims.kid, 'human-management-v1'); assert.equal(claims.exp, 1600);
    assert.equal(claims.iss, source.issuer); assert.equal(claims.aud, source.audiences.management);
    assert.equal(issued.split('.').length, 3); assert.equal(Buffer.from(issued.split('.')[2], 'base64url').length, 64);
  });

  it('routes by namespace only, then refuses wrong signatures without accepting machine/provider identities', async function () {
    const issued = await source.access.issue(input());
    assert.equal(source.access.accepts(issued), true);
    const other = fixture({ tenant, now: () => clock });
    assert.equal(other.access.accepts(issued), true);
    assert.throws(() => other.access.verify({ tenant, token: issued }), { code: 'HUMAN_SESSION_REFUSED' });
    const parts = issued.split('.');
    for (const changed of [{ iss: 'synthetic-machine-issuer' }, { aud: 'synthetic-machine-audience' }]) {
      const body = { ...JSON.parse(Buffer.from(parts[1], 'base64url')), ...changed };
      const altered = parts[0] + '.' + Buffer.from(JSON.stringify(body)).toString('base64url') + '.' + parts[2];
      assert.equal(source.access.accepts(altered), false);
      assert.throws(() => source.access.verify({ tenant, token: altered }), { code: 'HUMAN_SESSION_REFUSED' });
    }
    const providerHeader = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'human-management-v1' })).toString('base64url');
    assert.equal(source.access.accepts(providerHeader + '.' + parts[1] + '.' + parts[2]), false);
  });

  it('keeps multitenant/default verification UUID strict and the private single profile constant', async function () {
    const single = fixture({ tenant: 'single', now: () => clock });
    const issued = await single.access.issue(input('single'));
    assert.equal(single.access.verify({ tenant: 'single', token: issued }).tid, 'single');
    assert.throws(() => single.access.verify({ tenant, token: issued }), { code: 'HUMAN_SESSION_REFUSED' });
    const key = single.keys.find(value => value.purpose === 'management');
    const ordinary = token.createVerifier({ issuer: single.issuer, audience: single.audiences.management,
      purpose: 'management', maxLifetimeSeconds: 600, now: () => clock,
      resolveKey: () => ({ ...key, issuer: single.issuer }) });
    assert.throws(() => ordinary(issued, 'single'), { code: 'TOKEN_FORMAT' });
    assert.throws(() => source.access.verify({ tenant: 'single', token: issued }), { code: 'HUMAN_SESSION_REFUSED' });
    assert.throws(() => fixture({ tenant: 'arbitrary-auth-scope' }), TypeError);
  });

  it('allows expired signed lookup only through the closed lookup profile, never access authentication', async function () {
    const issued = await source.access.issue(input()); clock = 1600;
    assert.throws(() => source.access.verify({ tenant, token: issued }), { code: 'HUMAN_SESSION_REFUSED' });
    const claims = source.access.verify({ tenant, token: issued, allowExpiredLookup: true });
    assert.equal(claims.lookupOnly, true); assert.equal(claims.exp, 1600);
    let snapshots = 0;
    const auth = token.createAuthentication({ verifyToken: () => claims, snapshot: async () => { snapshots++; return {}; } });
    await assert.rejects(auth({ tenant, token: issued }), { code: 'TOKEN_CLAIMS' });
    assert.equal(snapshots, 0);
  });

  it('verifies existing access without calling the private signing provider during its outage', async function () {
    let unavailable = false, calls = 0;
    const access = createHumanAccess({ issuer: source.issuer, audiences: source.audiences, now: () => clock,
      keys: source.keys.map(key => ({ ...key, sign: async bytes => { calls++; if (unavailable) throw new Error(); return key.sign(bytes); } })) });
    const issued = await access.issue(input()); unavailable = true;
    access.verify({ tenant, token: issued }); assert.equal(calls, 1);
    await assert.rejects(access.issue(input()), { code: 'HUMAN_SESSION_UNAVAILABLE' });
  });

  it('refuses ambiguous public/signing profiles and a mismatched signing capability', async function () {
    assert.throws(() => createHumanAccess({ issuer: source.issuer, audiences: source.audiences,
      keys: [source.keys[0], source.keys[0]] }), TypeError);
    assert.throws(() => createHumanAccess({ issuer: source.issuer,
      audiences: { data: 'same', management: 'same' }, keys: source.keys }), TypeError);
    assert.throws(() => createHumanAccess({ issuer: source.issuer, audiences: source.audiences,
      keys: source.keys.map(key => ({ ...key, privateKey: 'forbidden' })) }), TypeError);
    const other = fixture({ tenant, now: () => clock });
    const access = createHumanAccess({ issuer: source.issuer, audiences: source.audiences, now: () => clock,
      keys: source.keys.map((key, index) => ({ ...key, sign: other.keys[index].sign })) });
    await assert.rejects(access.issue(input()), { code: 'HUMAN_SESSION_UNAVAILABLE' });
  });
});
