'use strict';

// Source-double acceptance of the actual engine and Mongo aggregate adapter.
// No result in this file is actual Mongo/PostgreSQL/provider/browser evidence.
const assert = require('node:assert/strict');
const { createEngine, tokenHash } = require(process.env.HUMAN_SESSION_TEST_SOURCE || '../lib/human-session/engine');
const { createMongoStore, authorityId, principalId } = require(process.env.HUMAN_SESSION_TEST_STORE || '../lib/human-session/mongo');
const humanAccessFixture = require('./fixtures/human-access-issuer');
const { createHumanAccess } = require('../lib/human-session/access');
const clone = value => JSON.parse(JSON.stringify(value));
const tenant = 'single';
const issuer = 'https://synthetic-provider.invalid';

function fixture () {
  let clock = 1000;
  const crypto = humanAccessFixture({ tenant, now: () => clock });
  const collection = {
    document: { _id: authorityId(tenant), tenant, revision: 1, keys: crypto.acceptedKeys,
      principals: [{ id: principalId(tenant, issuer, 'human-a'), issuer, providerSubject: 'human-a',
        subject: 'local_a', consumer: 'oidc', enabled: true, generation: 1, credentialGeneration: 1,
        purposes: ['data', 'management'], permissionGroups: [['api:status:read']] }], sessions: [], logoutEvents: [] },
    beforeReplace: null,
    async findOne (query) {
      if (this.unavailable) throw new Error('synthetic store disconnected');
      const doc = this.document;
      if (query.tenant !== doc.tenant || query._id && query._id !== doc._id ||
          query['sessions.tokens.hash'] && !doc.sessions.some(session => session.tokens.some(token => token.hash === query['sessions.tokens.hash']))) return null;
      return clone(doc);
    },
    async findOneAndReplace (filter, next) {
      if (this.unavailable) throw new Error('synthetic store disconnected');
      if (this.beforeReplace) { const hook = this.beforeReplace; this.beforeReplace = null; await hook(); }
      if (Object.keys(filter).some(key => JSON.stringify(filter[key]) !== JSON.stringify(this.document[key]))) return null;
      this.document = clone(next);
      return clone(next);
    },
    find (query) {
      const document = this.document;
      const matched = query.tenant === document.tenant && query.issuer === document.issuer &&
        document.sessions.some(session => session.providerSession === query['sessions.providerSession']);
      return { limit: () => ({ toArray: async () => matched ? [clone(document)] : [] }) };
    }
  };
  const store = createMongoStore({ collection, tenant, consumer: 'oidc' });
  const engine = createEngine({ store, access: crypto.access, now: () => clock });
  const workerB = createEngine({ store: createMongoStore({ collection, tenant, consumer: 'oidc' }), access: crypto.access, now: () => clock });
  const proof = (subject = 'human-a') => ({ issuer, subject, authenticatedAt: clock, providerSession: 'provider-session-a' });
  const login = (purpose = 'management') => engine.login({ tenant, identity: proof(), purpose });
  const auth = (token, extra = {}) => engine.authenticate({ tenant, token, purpose: 'management', ...extra });
  return { engine, workerB, collection, crypto, now: () => clock, proof, login, auth, setTime: time => { clock = time; } };
}

describe('human-session lifecycle (source doubles, actual engine and aggregate CAS)', function () {
  it('serving Mongo authority refuses UUID bindings rather than simulating multitenant storage', function () {
    const f = fixture();
    assert.throws(() => createMongoStore({ collection: f.collection, tenant: '00000000-0000-0000-0000-000000000001', consumer: 'oidc' }),
      /fixed private single binding/);
  });
  it('maps explicit local authority and keeps access credentials one-way', async function () {
    const f = fixture(), issued = await f.login();
    assert.match(issued.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const claims = f.crypto.access.verify({ tenant, token: issued.token });
    assert.equal(claims.cv, 1);
    assert.equal(claims.sid, issued.session.id);
    assert.equal(JSON.parse(Buffer.from(issued.token.split('.')[0], 'base64url')).typ, 'ns-access+jwt');
    assert.equal(issued.expiresAt, 1600);
    assert.equal(issued.session.subject, 'local_a');
    assert.equal(issued.session.absoluteExpiresAt, 44200);
    assert.equal(issued.session.idleExpiresAt, 2800);
    assert.equal(JSON.stringify(f.collection.document).includes(issued.token), false);
    const current = await f.auth(issued.token);
    assert.equal(current.actor.allows('api:status:read'), true);
    assert.equal(current.actor.allows('admin:root:write'), false);
  });

  it('provider identity alone grants neither local data nor management access', async function () {
    const f = fixture();
    await assert.rejects(f.engine.login({ tenant, identity: f.proof('unmapped'), purpose: 'management' }), { code: 'HUMAN_AUTHORITY_REFUSED' });
    f.collection.document.principals[0].purposes = ['data'];
    await assert.rejects(f.login(), { code: 'HUMAN_AUTHORITY_REFUSED' });
    assert.equal((await f.login('data')).session.purpose, 'data');
  });

  it('reads current grants and refuses disabled or generation-changed authority', async function () {
    const f = fixture(), issued = await f.login();
    f.collection.document.principals[0].permissionGroups = [['api:entries:read']];
    let current = await f.auth(issued.token);
    assert.equal(current.actor.allows('api:status:read'), false);
    assert.equal(current.actor.allows('api:entries:read'), true);
    f.collection.document.principals[0].enabled = false;
    await assert.rejects(f.auth(issued.token), { code: 'HUMAN_AUTHORITY_REFUSED' });
    f.collection.document.principals[0].enabled = true;
    f.collection.document.principals[0].generation++;
    await assert.rejects(f.auth(issued.token), { code: 'HUMAN_AUTHORITY_REFUSED' });
  });

  it('single-site access cannot be replayed against another configured issuer and public keys', async function () {
    const f = fixture(), issued = await f.login();
    const foreign = humanAccessFixture({ tenant, issuer: 'other-synthetic-site', now: f.now });
    const otherSite = createEngine({ store: createMongoStore({ collection: f.collection, tenant, consumer: 'oidc' }), access: foreign.access, now: f.now });
    await assert.rejects(otherSite.authenticate({ tenant, token: issued.token, purpose: 'management' }), { code: 'HUMAN_SESSION_REFUSED' });
  });

  it('durable logout refuses replay and renewal through a second worker', async function () {
    const f = fixture(), issued = await f.login();
    await f.engine.logout({ tenant, token: issued.token });
    await assert.rejects(f.workerB.authenticate({ tenant, token: issued.token, purpose: 'management' }), { code: 'HUMAN_SESSION_REFUSED' });
    assert.equal(f.collection.document.sessions[0].active, false);
    await assert.rejects(f.workerB.renew({ tenant, token: issued.token, identity: f.proof() }), { code: 'HUMAN_SESSION_REFUSED' });
    assert.deepEqual(await f.engine.logout({ tenant, token: issued.token }), { revoked: true });
  });

  it('logout only invalidates its own human session', async function () {
    const f = fixture(), first = await f.login(), second = await f.login();
    await f.engine.logout({ tenant, token: first.token });
    assert.equal((await f.auth(second.token)).session.id, second.session.id);
  });

  it('access expiry refuses exactly, while provider proof may renew within live idle', async function () {
    const f = fixture(), issued = await f.login();
    f.setTime(1599);
    await f.auth(issued.token);
    f.setTime(1600);
    await assert.rejects(f.auth(issued.token), { code: 'HUMAN_SESSION_REFUSED' });
    const renewed = await f.engine.renew({ tenant, token: issued.token, identity: f.proof() });
    assert.equal(renewed.session.id, issued.session.id);
    assert.equal(renewed.session.authenticatedAt, 1000);
    assert.equal(renewed.session.idleExpiresAt, 2800);
    assert.equal(renewed.session.absoluteExpiresAt, 44200);
    await f.auth(renewed.token);
  });

  it('renewal and unattended traffic never move idle; exact idle deadline refuses', async function () {
    const f = fixture(), issued = await f.login();
    f.setTime(2799);
    const renewed = await f.engine.renew({ tenant, token: issued.token, identity: f.proof() });
    await f.auth(renewed.token);
    assert.equal(f.collection.document.sessions[0].idleExpiresAt, 2800);
    f.setTime(2800);
    await assert.rejects(f.auth(renewed.token), { code: 'HUMAN_SESSION_REFUSED' });
    await assert.rejects(f.engine.renew({ tenant, token: renewed.token, identity: f.proof() }), { code: 'HUMAN_SESSION_REFUSED' });
  });

  it('qualified management activity moves idle but never freshness or absolute lifetime', async function () {
    const f = fixture(), issued = await f.login();
    f.setTime(1299);
    const touched = await f.auth(issued.token, { activity: true, sensitive: true });
    assert.equal(touched.session.idleExpiresAt, 3099);
    assert.equal(f.collection.document.sessions[0].authenticatedAt, 1000);
    assert.equal(f.collection.document.sessions[0].absoluteExpiresAt, 44200);
    f.setTime(1300);
    await assert.rejects(f.auth(issued.token, { sensitive: true }), { code: 'HUMAN_REAUTH_REQUIRED' });
  });

  it('absolute lifetime refuses at its boundary after valid periodic management activity', async function () {
    const f = fixture();
    let issued = await f.login();
    for (let at = 2700; at < 44200; at += 1700) {
      f.setTime(at);
      issued = await f.engine.renew({ tenant, token: issued.token, identity: f.proof() });
      await f.auth(issued.token, { activity: true });
    }
    f.setTime(44199);
    issued = await f.engine.renew({ tenant, token: issued.token, identity: f.proof() });
    assert.equal(issued.expiresAt, 44200);
    f.setTime(44200);
    await assert.rejects(f.auth(issued.token), { code: 'HUMAN_SESSION_REFUSED' });
    await assert.rejects(f.engine.renew({ tenant, token: issued.token, identity: f.proof() }), { code: 'HUMAN_SESSION_REFUSED' });
  });

  it('data sessions have no management idle or absolute limit', async function () {
    const f = fixture(), issued = await f.login('data');
    f.setTime(100000);
    const renewed = await f.engine.renew({ tenant, token: issued.token, identity: f.proof() });
    const current = await f.engine.authenticate({ tenant, token: renewed.token, purpose: 'data', activity: true });
    assert.equal(current.session.idleExpiresAt, null);
    assert.equal(current.session.absoluteExpiresAt, null);
  });

  it('renewal binds verified provider identity and preserves concurrent token validity', async function () {
    const f = fixture(), issued = await f.login();
    await assert.rejects(f.engine.renew({ tenant, token: issued.token, identity: f.proof('foreign') }), { code: 'HUMAN_SESSION_REFUSED' });
    await assert.rejects(f.engine.renew({ tenant, token: issued.token, identity: { ...f.proof(), issuer: 'https://other.invalid' } }), { code: 'HUMAN_SESSION_REFUSED' });
    await assert.rejects(f.engine.renew({ tenant, token: issued.token, identity: { ...f.proof(), providerSession: 'different-provider-session' } }), { code: 'HUMAN_SESSION_REFUSED' });
    const renewed = await Promise.all(Array.from({ length: 4 }, () => f.engine.renew({ tenant, token: issued.token, identity: f.proof() })));
    assert.equal(new Set(renewed.map(value => value.session.id)).size, 1);
    for (const value of renewed) await f.auth(value.token);
    assert.equal(f.collection.document.sessions.length, 1);
  });

  it('a renewal CAS racing committed logout cannot resurrect the session', async function () {
    const f = fixture(), issued = await f.login();
    f.collection.beforeReplace = () => f.workerB.logout({ tenant, token: issued.token });
    let renewed;
    try { renewed = await f.engine.renew({ tenant, token: issued.token, identity: f.proof() }); }
    catch (error) {
      assert.equal(error.code, 'HUMAN_SESSION_REFUSED');
      assert.equal(f.collection.document.sessions[0].active, false);
      assert.equal(f.collection.document.sessions[0].tokens.length, 1);
      return;
    }
    const accepted = await f.auth(renewed.token);
    assert.equal(Boolean(accepted), false, 'revocation-racing renewal returned a token accepted by the next protected operation');
  });

  it('a grant edit racing authorization retries against the committed current grant', async function () {
    const f = fixture(), issued = await f.login();
    f.collection.beforeReplace = async () => { f.collection.document.principals[0].permissionGroups = []; };
    const current = await f.auth(issued.token);
    assert.equal(current.actor.allows('api:status:read'), false);
  });

  it('current-store outage refuses access, renewal and unconfirmed local logout', async function () {
    const f = fixture(), issued = await f.login();
    f.collection.unavailable = true;
    for (const operation of [() => f.auth(issued.token),
      () => f.engine.renew({ tenant, token: issued.token, identity: f.proof() }),
      () => f.engine.logout({ tenant, token: issued.token })]) {
      await assert.rejects(operation(), { code: 'HUMAN_SESSION_UNAVAILABLE' });
    }
  });

  it('verified provider logout is issuer/session bound, durable and replay idempotent', async function () {
    const f = fixture(), issued = await f.login();
    f.setTime(1001);
    const event = { issuer, eventId: 'synthetic-event-a', issuedAt: 1001, providerSession: 'provider-session-a' };
    assert.deepEqual(await f.engine.logoutProvider({ tenant, event: { ...event, issuer: 'https://foreign.invalid' } }), { revoked: 0, replayed: false });
    await f.auth(issued.token);
    assert.deepEqual(await f.engine.logoutProvider({ tenant, event }), { revoked: 1, replayed: false });
    await assert.rejects(f.workerB.authenticate({ tenant, token: issued.token, purpose: 'management' }), { code: 'HUMAN_SESSION_REFUSED' });
    const fresh = await f.login();
    assert.deepEqual(await f.engine.logoutProvider({ tenant, event }), { revoked: 0, replayed: true });
    await f.auth(fresh.token);
  });

  it('delayed subject logout does not invalidate a later explicitly authenticated session', async function () {
    const f = fixture();
    f.setTime(1002);
    const issued = await f.login();
    assert.deepEqual(await f.engine.logoutProvider({ tenant, event: { issuer, eventId: 'earlier-event', issuedAt: 1001, subject: 'human-a' } }), { revoked: 0, replayed: false });
    await f.auth(issued.token);
    await assert.rejects(f.engine.logoutProvider({ tenant, event: { issuer, eventId: 'future-event', issuedAt: 1003, subject: 'human-a' } }), { code: 'HUMAN_SESSION_REFUSED' });
  });

  it('corrupt stored lifetime values refuse rather than exploiting NaN comparisons', async function () {
    const f = fixture(), issued = await f.login();
    delete f.collection.document.sessions[0].idleExpiresAt;
    await assert.rejects(f.auth(issued.token), { code: 'HUMAN_SESSION_REFUSED' });
  });

  it('rejects a bad signature and any persisted kid, expiry or issuance-time mismatch', async function () {
    const f = fixture(), issued = await f.login();
    const parts = issued.token.split('.');
    const signature = Buffer.from(parts[2], 'base64url'); signature[0] ^= 1;
    await assert.rejects(f.auth(parts[0] + '.' + parts[1] + '.' + signature.toString('base64url')), { code: 'HUMAN_SESSION_REFUSED' });
    const stored = f.collection.document.sessions[0].tokens[0];
    const original = { ...stored };
    for (const [name, value] of [['kid', 'different-key'], ['expiresAt', 1601], ['issuedAt', 999]]) {
      stored[name] = value;
      await assert.rejects(f.auth(issued.token), { code: 'HUMAN_SESSION_REFUSED' });
      Object.assign(stored, original);
    }
  });

  it('current key retirement refuses access and renewal but permits known-session logout', async function () {
    const f = fixture(), issued = await f.login();
    f.collection.document.keys.find(key => key.purpose === 'management').active = false;
    await assert.rejects(f.auth(issued.token), { code: 'HUMAN_AUTHORITY_REFUSED' });
    await assert.rejects(f.engine.renew({ tenant, token: issued.token, identity: f.proof() }), { code: 'HUMAN_AUTHORITY_REFUSED' });
    await f.engine.logout({ tenant, token: issued.token });
    assert.equal(f.collection.document.sessions[0].active, false);
  });

  it('renewal requires both the old accepted key and newly selected issuer key', async function () {
    const f = fixture(), issued = await f.login();
    const next = humanAccessFixture({ tenant, now: f.now }).keys.find(key => key.purpose === 'management');
    next.kid = 'human-management-v2';
    const keys = f.crypto.keys.map(key => ({ ...key, current: key.purpose !== 'management' })).concat(next);
    const rotated = createHumanAccess({ issuer: f.crypto.issuer, audiences: f.crypto.audiences, keys, mode: 'single', now: f.now });
    const engine = createEngine({ store: createMongoStore({ collection: f.collection, tenant, consumer: 'oidc' }), access: rotated, now: f.now });
    f.collection.document.keys.push({ kid: next.kid, purpose: 'management', active: false });
    await assert.rejects(engine.renew({ tenant, token: issued.token, identity: f.proof() }), { code: 'HUMAN_AUTHORITY_REFUSED' });
    f.collection.document.keys.find(key => key.kid === next.kid).active = true;
    const renewed = await engine.renew({ tenant, token: issued.token, identity: f.proof() });
    assert.equal(rotated.verify({ tenant, token: renewed.token }).kid, next.kid);
    f.collection.document.keys.find(key => key.kid !== next.kid && key.purpose === 'management').active = false;
    await assert.rejects(engine.renew({ tenant, token: issued.token, identity: f.proof() }), { code: 'HUMAN_AUTHORITY_REFUSED' });
    await engine.authenticate({ tenant, token: renewed.token, purpose: 'management' });
  });

  it('a global key retirement during issuance is retried and cannot return usable access', async function () {
    const f = fixture(), issued = await f.login();
    f.collection.beforeReplace = async () => { f.collection.document.keys.find(key => key.purpose === 'management').active = false; };
    await assert.rejects(f.engine.renew({ tenant, token: issued.token, identity: f.proof() }), { code: 'HUMAN_AUTHORITY_REFUSED' });
    await assert.rejects(f.auth(issued.token), { code: 'HUMAN_AUTHORITY_REFUSED' });
  });

  it('same-second signed renewal is idempotent in persisted issuance binding', async function () {
    const f = fixture(), issued = await f.login();
    const renewed = await Promise.all(Array.from({ length: 4 }, () => f.engine.renew({ tenant, token: issued.token, identity: f.proof() })));
    assert.equal(new Set(renewed.map(result => result.token)).size, 1);
    assert.equal(f.collection.document.sessions[0].tokens.length, 1);
    for (const result of renewed) await f.auth(result.token);
  });

  it('signature validation refuses even if a stored secondary hash binding is corrupted', async function () {
    const f = fixture(), issued = await f.login();
    const parts = issued.token.split('.');
    const signature = Buffer.from(parts[2], 'base64url'); signature[0] ^= 1;
    const corrupt = parts[0] + '.' + parts[1] + '.' + signature.toString('base64url');
    // This synthetic corruption deliberately neutralizes the independent
    // issuance-hash guard so this assertion measures the signature guard itself.
    f.collection.document.sessions[0].tokens[0].hash = tokenHash(corrupt);
    await assert.rejects(f.auth(corrupt), { code: 'HUMAN_SESSION_REFUSED' });
  });

  it('a valid signer result discarded after failed CAS cannot authorize and is never returned', async function () {
    const f = fixture(), issued = await f.login(), signed = [];
    const access = { ...f.crypto.access, async issue (request) {
      const token = await f.crypto.access.issue(request);
      signed.push(token);
      return token;
    } };
    const engine = createEngine({ store: createMongoStore({ collection: f.collection, tenant, consumer: 'oidc' }), access, now: f.now });
    f.setTime(1001);
    f.collection.beforeReplace = async () => { f.collection.document.revision++; f.setTime(1002); };
    const renewed = await engine.renew({ tenant, token: issued.token, identity: f.proof() });
    assert.equal(signed.length, 2);
    assert.notEqual(signed[0], signed[1]);
    assert.equal(f.crypto.access.verify({ tenant, token: signed[0] }).iat, 1001);
    assert.equal(renewed.token, signed[1]);
    assert.equal(f.collection.document.sessions[0].tokens.some(token => token.hash === tokenHash(signed[0])), false);
    await assert.rejects(f.auth(signed[0]), { code: 'HUMAN_SESSION_REFUSED' });
    await f.auth(renewed.token);
  });
});
