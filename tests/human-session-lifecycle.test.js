'use strict';

// Source-double acceptance of the actual engine and Mongo aggregate adapter.
// No result in this file is actual Mongo/PostgreSQL/provider/browser evidence.
const assert = require('node:assert/strict');
const { createEngine } = require(process.env.HUMAN_SESSION_TEST_SOURCE || '../lib/human-session/engine');
const { createMongoStore, principalId } = require(process.env.HUMAN_SESSION_TEST_STORE || '../lib/human-session/mongo');
const clone = value => JSON.parse(JSON.stringify(value));
const tenant = '00000000-0000-0000-0000-000000000001';
const issuer = 'https://synthetic-provider.invalid';

function fixture () {
  let clock = 1000;
  const collection = {
    document: { _id: principalId(tenant, issuer, 'human-a'), tenant, issuer, providerSubject: 'human-a',
      subject: 'local_a', consumer: 'oidc', enabled: true, generation: 1, revision: 1,
      purposes: ['data', 'management'], permissionGroups: [['api:status:read']], sessions: [], logoutEvents: [] },
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
  const engine = createEngine({ store, now: () => clock });
  const workerB = createEngine({ store: createMongoStore({ collection, tenant, consumer: 'oidc' }), now: () => clock });
  const proof = (subject = 'human-a') => ({ issuer, subject, authenticatedAt: clock, providerSession: 'provider-session-a' });
  const login = (purpose = 'management') => engine.login({ tenant, identity: proof(), purpose });
  const auth = (token, extra = {}) => engine.authenticate({ tenant, token, purpose: 'management', ...extra });
  return { engine, workerB, collection, proof, login, auth, setTime: time => { clock = time; } };
}

describe('human-session lifecycle (source doubles, actual engine and aggregate CAS)', function () {
  it('maps explicit local authority and keeps access credentials one-way', async function () {
    const f = fixture(), issued = await f.login();
    assert.match(issued.token, /^nsh_[A-Za-z0-9_-]{43}$/);
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
    f.collection.document.purposes = ['data'];
    await assert.rejects(f.login(), { code: 'HUMAN_AUTHORITY_REFUSED' });
    assert.equal((await f.login('data')).session.purpose, 'data');
  });

  it('reads current grants and refuses disabled or generation-changed authority', async function () {
    const f = fixture(), issued = await f.login();
    f.collection.document.permissionGroups = [['api:entries:read']];
    let current = await f.auth(issued.token);
    assert.equal(current.actor.allows('api:status:read'), false);
    assert.equal(current.actor.allows('api:entries:read'), true);
    f.collection.document.enabled = false;
    await assert.rejects(f.auth(issued.token), { code: 'HUMAN_AUTHORITY_REFUSED' });
    f.collection.document.enabled = true;
    f.collection.document.generation++;
    await assert.rejects(f.auth(issued.token), { code: 'HUMAN_AUTHORITY_REFUSED' });
  });

  it('refuses foreign-tenant replay before local human authority is used', async function () {
    const f = fixture(), issued = await f.login();
    await assert.rejects(f.engine.authenticate({ tenant: '00000000-0000-0000-0000-000000000002', token: issued.token, purpose: 'management' }), { code: 'HUMAN_SESSION_REFUSED' });
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
    f.collection.beforeReplace = async () => { f.collection.document.permissionGroups = []; };
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
});
