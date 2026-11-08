'use strict';

// Reserved-runtime instrument against an actual MongoDB driver and one uniquely
// named owned collection. No server is created and no default datastore is used.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { MongoClient } = require('mongodb');
// Explicit local scratch modules are selected only for this native instrument's
// physical negative controls; production loading is always static.
// eslint-disable-next-line security/detect-non-literal-require
const { createEngine } = require(process.env.HUMAN_SESSION_NATIVE_ENGINE || '../lib/human-session/engine');
// eslint-disable-next-line security/detect-non-literal-require
const { createMongoStore, authorityId, principalId } = require(process.env.HUMAN_SESSION_NATIVE_STORE || '../lib/human-session/mongo');
const humanAccessFixture = require('./fixtures/human-access-issuer');
const tenant = 'single';
const issuer = 'https://synthetic-provider.invalid';

async function run () {
  if (process.env.HUMAN_SESSION_NATIVE_RESERVED !== '1' || !process.env.HUMAN_SESSION_MONGO_URL) {
    throw new Error('Reserved HUMAN_SESSION_NATIVE_RESERVED=1 and explicit HUMAN_SESSION_MONGO_URL required; no default datastore');
  }
  const clientOptions = {
    serverSelectionTimeoutMS: 1000, connectTimeoutMS: 1000, socketTimeoutMS: 2000,
    readPreference: 'primary', retryWrites: false, writeConcern: { w: 'majority', j: true, wtimeoutMS: 2000 }
  };
  const client = new MongoClient(process.env.HUMAN_SESSION_MONGO_URL, clientOptions);
  const name = 'human_session_native_' + randomBytes(8).toString('hex');
  const checks = [], cleanupErrors = [];
  let collection, workerClient, created = false, beforeReplace = null, clock = 1000, primary;
  const crypto = humanAccessFixture({ tenant, now: () => clock });
  const proof = () => ({ issuer, subject: 'provider-a', authenticatedAt: clock, providerSession: 'provider-session-a' });
  async function check (label, fn) { await fn(); checks.push({ name: label, pass: true }); }
  try {
    await client.connect();
    const db = process.env.HUMAN_SESSION_MONGO_DB ? client.db(process.env.HUMAN_SESSION_MONGO_DB) : client.db();
    collection = await db.createCollection(name);
    created = true;
    const id = authorityId(tenant);
    await collection.insertOne({ _id: id, tenant, revision: 1, keys: crypto.acceptedKeys,
      principals: [{ id: principalId(tenant, issuer, 'provider-a'), issuer, providerSubject: 'provider-a',
        subject: 'local_a', consumer: 'oidc', enabled: true, generation: 1, credentialGeneration: 1,
        purposes: ['data', 'management'], permissionGroups: [['api:status:read']] }], sessions: [], logoutEvents: [] });
    // The barrier changes scheduling only; every operation goes to the actual
    // driver collection. Both engines remain in this one Node process, while
    // the second engine uses an independent MongoClient and real driver pool.
    const barrierCollection = {
      findOne: (...args) => collection.findOne(...args),
      find: (...args) => collection.find(...args),
      async findOneAndReplace (...args) {
        if (beforeReplace) { const pending = beforeReplace; beforeReplace = null; await pending(); }
        return collection.findOneAndReplace(...args);
      }
    };
    workerClient = new MongoClient(process.env.HUMAN_SESSION_MONGO_URL, clientOptions);
    await workerClient.connect();
    const workerDB = process.env.HUMAN_SESSION_MONGO_DB ? workerClient.db(process.env.HUMAN_SESSION_MONGO_DB) : workerClient.db();
    const workerCollection = workerDB.collection(name);
    const engine = createEngine({ store: createMongoStore({ collection: barrierCollection, tenant, consumer: 'oidc' }), access: crypto.access, now: () => clock });
    const worker = createEngine({ store: createMongoStore({ collection: workerCollection, tenant, consumer: 'oidc' }), access: crypto.access, now: () => clock });
    const login = (purpose = 'management') => engine.login({ tenant, identity: proof(), purpose });
    const authenticate = (token, extra = {}) => worker.authenticate({ tenant, token, purpose: 'management', ...extra });
    let issued;
    await check('actual Mongo explicit local mapping and current grants', async () => {
      issued = await login();
      assert.equal((await authenticate(issued.token)).actor.allows('api:status:read'), true);
      await assert.rejects(engine.login({ tenant, identity: { ...proof(), subject: 'unmapped' }, purpose: 'management' }), { code: 'HUMAN_AUTHORITY_REFUSED' });
      const stored = await collection.findOne({ _id: id });
      assert.equal(JSON.stringify(stored).includes(issued.token), false);
    });
    await check('actual Mongo same-second signed concurrent renewal is idempotent', async () => {
      const renewed = await Promise.all(Array.from({ length: 4 }, () => worker.renew({ tenant, token: issued.token, identity: proof() })));
      assert.equal(new Set(renewed.map(result => result.token)).size, 1);
      assert.equal((await collection.findOne({ _id: id })).sessions[0].tokens.length, 1);
      for (const result of renewed) await authenticate(result.token);
    });
    await check('current grant removal and explicit management entitlement are effective next operation', async () => {
      await collection.updateOne({ _id: id }, { $set: { 'principals.0.permissionGroups': [] }, $inc: { revision: 1 } });
      assert.equal((await authenticate(issued.token)).actor.allows('api:status:read'), false);
      await collection.updateOne({ _id: id }, { $set: { 'principals.0.purposes': ['data'] }, $inc: { revision: 1 } });
      await assert.rejects(authenticate(issued.token), { code: 'HUMAN_AUTHORITY_REFUSED' });
      await collection.updateOne({ _id: id }, { $set: { 'principals.0.purposes': ['data', 'management'], 'principals.0.permissionGroups': [['api:status:read']] }, $inc: { revision: 1 } });
    });
    await check('durable local logout refuses copied access through another worker and preserves other session', async () => {
      const other = await login();
      await engine.logout({ tenant, token: issued.token });
      await assert.rejects(authenticate(issued.token), { code: 'HUMAN_SESSION_REFUSED' });
      await authenticate(other.token);
      issued = other;
    });
    await check('access expiry refuses at exact boundary while provider-backed renewal retains idle clock', async () => {
      clock = 1600;
      await assert.rejects(authenticate(issued.token), { code: 'HUMAN_SESSION_REFUSED' });
      const renewed = await worker.renew({ tenant, token: issued.token, identity: proof() });
      assert.equal(renewed.session.id, issued.session.id);
      assert.equal(renewed.session.authenticatedAt, 1000);
      assert.equal(renewed.session.idleExpiresAt, 2800);
      await authenticate(renewed.token);
      issued = renewed;
    });
    await check('renewal and polling never move idle and exact idle boundary refuses', async () => {
      clock = 2799;
      issued = await worker.renew({ tenant, token: issued.token, identity: proof() });
      await authenticate(issued.token);
      assert.equal((await collection.findOne({ _id: id })).sessions.find(session => session.id === issued.session.id).idleExpiresAt, 2800);
      clock = 2800;
      await assert.rejects(authenticate(issued.token), { code: 'HUMAN_SESSION_REFUSED' });
      await assert.rejects(worker.renew({ tenant, token: issued.token, identity: proof() }), { code: 'HUMAN_SESSION_REFUSED' });
    });
    await check('qualified management activity never refreshes absolute or sensitive authentication clocks', async () => {
      clock = 10000;
      issued = await login();
      clock = 10299;
      await authenticate(issued.token, { activity: true, sensitive: true });
      const stored = (await collection.findOne({ _id: id })).sessions.find(session => session.id === issued.session.id);
      assert.equal(stored.idleExpiresAt, 12099);
      assert.equal(stored.authenticatedAt, 10000);
      assert.equal(stored.absoluteExpiresAt, 53200);
      clock = 10300;
      await assert.rejects(authenticate(issued.token, { sensitive: true }), { code: 'HUMAN_REAUTH_REQUIRED' });
    });
    await check('absolute deadline refuses despite repeated valid activity', async () => {
      clock = 20000;
      issued = await login();
      for (let at = 21700; at < 63200; at += 1700) {
        clock = at;
        issued = await worker.renew({ tenant, token: issued.token, identity: proof() });
        await authenticate(issued.token, { activity: true });
      }
      clock = 63199;
      issued = await worker.renew({ tenant, token: issued.token, identity: proof() });
      clock = 63200;
      await assert.rejects(authenticate(issued.token), { code: 'HUMAN_SESSION_REFUSED' });
      await assert.rejects(worker.renew({ tenant, token: issued.token, identity: proof() }), { code: 'HUMAN_SESSION_REFUSED' });
    });
    await check('actual Mongo session fence prevents committed logout being overwritten by renewal', async () => {
      clock = 70000;
      issued = await login();
      beforeReplace = () => worker.logout({ tenant, token: issued.token });
      let renewed;
      try { renewed = await engine.renew({ tenant, token: issued.token, identity: proof() }); }
      catch (error) { assert.equal(error.code, 'HUMAN_SESSION_REFUSED'); return; }
      const accepted = await authenticate(renewed.token);
      assert.equal(Boolean(accepted), false, 'revocation-racing renewal returned an actually accepted token');
    });
    await check('actual Mongo grant CAS rereads an authority change racing protected access', async () => {
      issued = await login();
      beforeReplace = () => collection.updateOne({ _id: id }, { $set: { 'principals.0.enabled': false }, $inc: { revision: 1 } });
      await assert.rejects(engine.authenticate({ tenant, token: issued.token, purpose: 'management' }), { code: 'HUMAN_AUTHORITY_REFUSED' });
      await collection.updateOne({ _id: id }, { $set: { 'principals.0.enabled': true }, $inc: { revision: 1 } });
    });
    await check('actual Mongo global key retirement refuses access and renewal while known logout remains available', async () => {
      await collection.updateOne({ _id: id }, { $set: { 'keys.$[key].active': false }, $inc: { revision: 1 } },
        { arrayFilters: [{ 'key.purpose': 'management' }] });
      await assert.rejects(authenticate(issued.token), { code: 'HUMAN_AUTHORITY_REFUSED' });
      await assert.rejects(worker.renew({ tenant, token: issued.token, identity: proof() }), { code: 'HUMAN_AUTHORITY_REFUSED' });
      await engine.logout({ tenant, token: issued.token });
      await collection.updateOne({ _id: id }, { $set: { 'keys.$[key].active': true }, $inc: { revision: 1 } },
        { arrayFilters: [{ 'key.purpose': 'management' }] });
    });
    await check('data sessions remain free of management idle and absolute policy', async () => {
      issued = await login('data');
      clock = 200000;
      const renewed = await worker.renew({ tenant, token: issued.token, identity: proof() });
      const actual = await worker.authenticate({ tenant, token: renewed.token, purpose: 'data' });
      assert.equal(actual.session.idleExpiresAt, null);
      assert.equal(actual.session.absoluteExpiresAt, null);
      issued = renewed;
    });
    await check('provider session logout persists replay identity and refuses copied data access', async () => {
      const event = { issuer, eventId: 'native-event-a', issuedAt: clock, subject: 'provider-a', providerSession: 'provider-session-a' };
      await engine.logoutProvider({ tenant, event });
      await assert.rejects(worker.authenticate({ tenant, token: issued.token, purpose: 'data' }), { code: 'HUMAN_SESSION_REFUSED' });
      await assert.rejects(worker.renew({ tenant, token: issued.token, identity: proof() }), { code: 'HUMAN_SESSION_REFUSED' });
      assert.deepEqual(await worker.logoutProvider({ tenant, event }), { revoked: 0, replayed: true });
      assert.equal((await collection.findOne({ _id: id })).logoutEvents.filter(stored => stored.eventId === event.eventId).length, 1);
    });
  } catch (error) { primary = error; }
  finally {
    if (created) { try { await collection.drop(); } catch (error) { cleanupErrors.push(error); } }
    if (workerClient) { try { await workerClient.close(); } catch (error) { cleanupErrors.push(error); } }
    try { await client.close(); } catch (error) { cleanupErrors.push(error); }
  }
  if (primary && cleanupErrors.length) throw new globalThis.AggregateError([primary, ...cleanupErrors], 'Native Mongo check and owned cleanup failed');
  if (primary) throw primary;
  if (cleanupErrors.length) throw new globalThis.AggregateError(cleanupErrors, 'Native Mongo owned cleanup failed');
  process.stdout.write(JSON.stringify({ instrument: 'human-session-mongo-native', execution: { nodeProcesses: 1, engineClientPools: 2 },
    checks, passed: checks.length, cleanup: 'closed' }) + '\n');
}

if (require.main === module) run().catch(error => {
  process.stderr.write(JSON.stringify({ instrument: 'human-session-mongo-native', error: error.code || error.name, message: error.message }) + '\n');
  process.exitCode = 1;
});

module.exports = { run };
