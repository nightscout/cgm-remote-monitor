'use strict';

// Native-only fixture capability. Import and admission never acquire resources.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { createHook } = require('node:async_hooks');
const path = require('node:path');
const ENVREF = /^[A-Z][A-Z0-9_]{0,127}$/;
const fail = code => { throw new Error(code || 'SINGLE_COMPATIBILITY_ADMISSION_REFUSED'); };

function requirements () {
  return { classification: 'native-Mongo-single-production-legacy-HTTP-default-off',
    configuration: 'singleCompatibility:{apiSecretEnv,jwtKeyEnv}; explicit HUMAN_SESSION_MONGO_URL and HUMAN_SESSION_MONGO_DB',
    pool: { maxPoolSize: 4, minPoolSize: 0, maxConnecting: 1 },
    collections: 'three fresh sc_<nonce>_{entries,roles,subjects}; cleanup requires exact native collection UUID',
    listeners: 2, ownedUnrefProductionSweepTimers: 2,
    policy: 'shipping single AUTH_DEFAULT_ROLES=readable; root retains shipping wildcard authority',
    dependencies: ['lib/authorization/index.js', 'lib/authorization/storage.js', 'lib/authorization/endpoints.js',
      'lib/server/enclave.js', 'lib/server/entries.js', 'lib/api/entries/index.js', 'lib/server/storage-reads.js',
      'lib/api3/storage/mongoCollection/index.js', 'lib/human-session/runtime.js', 'lib/settings.js'],
    nativeExecution: 'run by tests/native/oidc-matrix/run.sh (disposable harness)' };
}

function admit ({ config, env = process.env } = {}) {
  const c = config?.singleCompatibility;
  if (env.HUMAN_SESSION_NATIVE_RESERVED !== '1' ||
      env.HUMAN_HTTPS_RESERVED !== '1' || !env.HUMAN_HTTP_SIGNER_CONFIG ||
      !/^[a-f0-9]{16,32}$/.test(config?.nonce || '') || !path.isAbsolute(config?.sourceRoot || '') || !c ||
      Object.keys(c).some(name => !['apiSecretEnv', 'jwtKeyEnv'].includes(name)) ||
      !ENVREF.test(c.apiSecretEnv || '') || !ENVREF.test(c.jwtKeyEnv || '') || c.apiSecretEnv === c.jwtKeyEnv ||
      [c.apiSecretEnv, c.jwtKeyEnv].some(ref => typeof env[ref] !== 'string' || env[ref].length < 32 || env[ref].length > 4096) ||
      env[c.apiSecretEnv] === env[c.jwtKeyEnv] || !/^[a-z][a-z0-9_]{0,62}$/.test(env.HUMAN_SESSION_MONGO_DB || '') ||
      ['admin', 'local', 'config', 'test'].includes(env.HUMAN_SESSION_MONGO_DB)) fail();
  let url;
  try { url = new URL(env.HUMAN_SESSION_MONGO_URL); } catch { fail(); }
  if (url.protocol !== 'mongodb:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.port || url.port === '27017' || url.hash ||
      !['', '/', '/' + env.HUMAN_SESSION_MONGO_DB].includes(url.pathname) ||
      [...url.searchParams].some(([key]) => !['replicaSet', 'directConnection', 'authSource'].includes(key))) fail();
  return true;
}

function assertRead (reply, id) {
  assert.equal(reply.status, 200, 'actual single legacy DATA read must succeed');
  assert.ok(Array.isArray(reply.body) && reply.body.some(row => row._id === id && row.sgv === 190),
    'actual legacy route must return the independently seeded native Mongo record');
}
function assertRefusal (reply, label) {
  assert.ok([401, 403].includes(reply.status), label + ': actual known route must refuse');
  assert.ok(!Array.isArray(reply.body) || reply.body.length === 0, label + ': refused route cannot return clinical rows');
}
function assertExchange (reply) {
  assert.equal(reply.status, 200, 'actual legacy subject exchange must succeed');
  assert.equal(reply.body.exp - reply.body.iat, 28800, 'shipping single subject JWT lifetime is eight hours');
  assert.ok(typeof reply.body.token === 'string' && reply.body.token.split('.').length === 3);
}
function assertUnchanged (before, after) {
  assert.ok(before.length > 0, 'single native clinical sentinel must be nonempty');
  assert.deepEqual(after, before, 'compatibility/refused writes never change native clinical records');
}

function makeFactory ({ config, env = process.env } = {}) {
  async function create (context) {
    admit({ config, env });
    const req = createRequire(path.join(config.sourceRoot, 'package.json'));
    const { nativeStore, human } = context || {};
    if (nativeStore?.kind !== 'mongo' || nativeStore.tenant !== 'single' ||
        context.binding?.persistence !== 'mongo' || context.binding?.signing !== 'configured-transit' ||
        context.tenant !== 'single' || !/^human_http_native_[a-f0-9]{16}$/.test(nativeStore.resources?.collection || '') ||
        typeof human?.authenticate !== 'function' || typeof context.listenOwned !== 'function' ||
        typeof context.remainingActiveMs !== 'function' || context.stage?.id !== 'mongo-http' ||
        !Number.isSafeInteger(context.remainingActiveMs()) || context.remainingActiveMs() < 1) fail('SINGLE_NATIVE_CONTEXT_REQUIRED');
    const c = config.singleCompatibility;
    const names = Object.fromEntries(['entries', 'roles', 'subjects'].map(kind => [kind, 'sc_' + config.nonce + '_' + kind]));
    const owned = [];
    let client, db, closing;
    const buses = [], sweepTimers = new Set();
    async function uuid (name) {
      const metadata = await db.listCollections({ name }, { nameOnly: false }).next();
      const value = metadata?.info?.uuid;
      if (metadata?.type !== 'collection' || !value || value.sub_type !== 4 || value.length() !== 16) fail('SINGLE_NATIVE_COLLECTION_UUID_REQUIRED');
      return value.toString('hex');
    }
    async function close () {
      if (!closing) closing = (async () => {
        const errors = [];
        for (const timer of sweepTimers) clearInterval(timer);
        for (const bus of buses) bus.removeAllListeners();
        for (const item of owned.slice().reverse()) {
          try {
            if (!item.uuid || await uuid(item.name) !== item.uuid) fail('SINGLE_COLLECTION_IDENTITY_CHANGED');
            await db.collection(item.name).drop();
          } catch (error) { errors.push(error); }
        }
        if (client) { try { await client.close(); } catch (error) { errors.push(error); } }
        if (errors.length) throw new globalThis.AggregateError(errors, 'SINGLE_COMPATIBILITY_CLOSE_FAILED');
      })();
      return closing;
    }
    try {
      const scope = req('./lib/storage/tenant-scope');
      if (scope.getTenancyMode() !== 'single') fail('SINGLE_NATIVE_MODE_REQUIRED');
      const MongoClient = req('mongodb').MongoClient;
      client = new MongoClient(env.HUMAN_SESSION_MONGO_URL, { maxPoolSize: 4, minPoolSize: 0, maxConnecting: 1,
        maxIdleTimeMS: 1000, serverSelectionTimeoutMS: 1000, connectTimeoutMS: 1000, socketTimeoutMS: 2000,
        readPreference: 'primary', retryWrites: false, writeConcern: { w: 'majority', j: true, wtimeoutMS: 2000 } });
      await client.connect(); db = client.db(env.HUMAN_SESSION_MONGO_DB);
      await uuid(nativeStore.resources.collection); // confirm the actual stage's existing native authority resource
      for (const name of Object.values(names)) {
        assert.equal(await db.listCollections({ name }, { nameOnly: true }).hasNext(), false,
          'single setup never reuses a physical collection');
        await db.createCollection(name); const item = { name, uuid: null }; owned.push(item); item.uuid = await uuid(name);
      }
      const id = new (req('mongodb').ObjectId)();
      await db.collection(names.entries).insertOne({ _id: id, type: 'sgv', sgv: 190, direction: 'Flat',
        date: Date.now() - 60000, dateString: new Date(Date.now() - 60000).toISOString(), synthetic: true });
      const storage = Object.freeze({
        collection (name) {
          if (!Object.values(names).includes(name)) fail('SINGLE_COLLECTION_OUTSIDE_OWNED_SET');
          return db.collection(name); // actual Mongo driver, no source-double storage
        },
        ensureIndexes: (collection, fields) => Promise.all(fields.map(field => collection.createIndex(field)))
      });
      const express = req('express'), { EventEmitter } = require('node:events');
      const apps = new Map(), authorities = new Map(), endpoints = new Map();
      for (const enabled of [true, false]) {
        const settings = req('./lib/settings')();
        assert.equal(settings.authDefaultRoles, 'readable', 'keep the actual shipped single anonymous default');
        settings.enable = [...settings.DEFAULT_FEATURES, ...(enabled ? ['oidc'] : [])];
        const appEnv = { settings, extendedSettings: {}, trustProxy: false,
          authentication_collections_prefix: 'sc_' + config.nonce + '_', entries_collection: names.entries };
        appEnv.enclave = req('./lib/server/enclave')();
        appEnv.enclave.setApiKey(env[c.apiSecretEnv]); appEnv.enclave.setJWTKey(env[c.jwtKeyEnv]);
        const bus = new EventEmitter(); buses.push(bus);
        const ctx = { bus, store: storage, settings, language: req('./lib/language')(),
          moment: req('moment-timezone'), ddata: req('./lib/data/ddata')(),
          purifier: req('./lib/server/purifier')({}, {}), ...(enabled ? { humanSessions: human } : {}) };
        ctx.language.set(settings.language); ctx.cache = req('./lib/server/cache')(appEnv, ctx);
        // The production delay-list has no close API. Capture only the actual
        // synchronous constructor's unref sweep resource, without replacing any
        // timer function or changing the production authorization logic.
        const createAuthorization = req('./lib/authorization'), captured = [];
        const hook = createHook({ init (asyncId, type, triggerAsyncId, resource) {
          if (type === 'Timeout') { captured.push(resource); sweepTimers.add(resource); }
        } });
        hook.enable();
        try { ctx.authorization = createAuthorization(appEnv, ctx); } finally { hook.disable(); }
        assert.equal(captured.length, 1, 'exactly the known production authorization sweep timer is owned');
        assert.equal(captured[0].hasRef(), false, 'production sweep stays unreferenced');
        await new Promise((resolve, reject) => ctx.authorization.storage.reload(error => error ? reject(error) : resolve()));
        ctx.entries = req('./lib/server/entries')(appEnv, ctx);
        if (!enabled) {
          const unavailable = new Proxy({}, { get () { fail('SINGLE_OFF_REQUESTED_OIDC_DEPENDENCY'); } });
          const off = await req('./lib/human-session/runtime').single({ env: appEnv, storage: unavailable, source: unavailable });
          assert.equal(off, null, 'actual single runtime defaults off before any provider/access/storage config');
        }
        const app = express(); app.disable('x-powered-by'); app.set('query parser', 'extended'); app.enable('api');
        app.use('/api/v2/authorization', ctx.authorization.endpoints);
        app.use('/api/v1', req('./lib/api/entries')(app, req('./lib/middleware')(appEnv), ctx, appEnv));
        app.use((request, response) => response.status(404).json({ error: 'NOT_FOUND' }));
        apps.set(enabled, app); authorities.set(enabled, ctx.authorization);
        const origin = await context.listenOwned(app, { plane: 'single', tenant: 'single', host: 'localhost', oidcEnabled: enabled });
        if (typeof origin !== 'string' || new URL(origin).hostname !== 'localhost') fail('SINGLE_NATIVE_DATA_ORIGIN_REQUIRED');
        endpoints.set(enabled, origin);
      }
      const snapshot = () => db.collection(names.entries).find({}, { readPreference: 'primary', readConcern: { level: 'majority' } }).sort({ _id: 1 }).toArray();
      async function reload () {
        for (const authorization of authorities.values()) await new Promise((resolve, reject) =>
          authorization.storage.reload(error => error ? reject(error) : resolve()));
      }
      async function exercise ({ transport, login }) {
        if (typeof transport !== 'function' || typeof login !== 'function' || context.remainingActiveMs() < 1) fail('SINGLE_HTTP_EXERCISE_REQUIRED');
        const request = async (enabled, method, route, { headers = {}, body } = {}) => {
          const response = await transport(endpoints.get(enabled) + route, { method,
            headers: { accept: 'application/json', ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
          return { status: response.status, body: await response.json() };
        };
        const route = '/api/v1/entries.json?count=1';
        const root = createHash('sha1').update(env[c.apiSecretEnv]).digest('hex');
        const rootHeaders = { 'api-secret': root };
        const before = await snapshot();
        for (const enabled of [true, false]) {
          assertRead(await request(enabled, 'GET', route, { headers: rootHeaders }), id.toHexString());
          assertRead(await request(enabled, 'GET', route), id.toHexString());
          const anonymous = authorities.get(enabled).resolveAnonymous();
          assert.equal(authorities.get(enabled).checkMultiple('api:entries:read', anonymous.shiros), true);
          assert.equal(authorities.get(enabled).checkMultiple('api:entries:create', anonymous.shiros), false);
          assertRefusal(await request(enabled, 'POST', '/api/v1/entries', { body: [{ type: 'sgv', date: Date.now(), sgv: 191 }] }), 'single shipped anonymous readable role');
        }
        assertUnchanged(before, await snapshot());
        const made = await request(true, 'POST', '/api/v2/authorization/subjects', { headers: rootHeaders,
          body: { name: 'Synthetic single compatibility', roles: ['readable'] } });
        assert.equal(made.status, 200); assert.ok(made.body._id);
        const subjects = await request(true, 'GET', '/api/v2/authorization/subjects', { headers: rootHeaders });
        assert.equal(subjects.status, 200);
        const subject = subjects.body.find(row => row._id === made.body._id);
        assert.ok(subject && typeof subject.accessToken === 'string');
        await reload();
        const exchange = await request(true, 'GET', '/api/v2/authorization/request/' + encodeURIComponent(subject.accessToken));
        assertExchange(exchange);
        for (const enabled of [true, false]) {
          assertRead(await request(enabled, 'GET', route + '&token=' + encodeURIComponent(subject.accessToken)), id.toHexString());
          assertRead(await request(enabled, 'GET', route, { headers: { 'api-secret': subject.accessToken } }), id.toHexString());
          assertRead(await request(enabled, 'GET', route, { headers: { authorization: 'Bearer ' + exchange.body.token } }), id.toHexString());
          const ownExchange = await request(enabled, 'GET', '/api/v2/authorization/request/' + encodeURIComponent(subject.accessToken));
          assertExchange(ownExchange);
        }
        const data = await login('bearer', 'data'), management = await login('bearer', 'management');
        assert.equal(data.status, 200); assert.equal(management.status, 200);
        const dataToken = (await data.json()).token, managementToken = (await management.json()).token;
        assert.ok(typeof dataToken === 'string' && typeof managementToken === 'string');
        const validManagement = await transport(context.origin + req('./lib/human-session/http').PREFIX + '/session?purpose=management',
          { headers: { authorization: 'Bearer ' + managementToken } });
        assert.equal(validManagement.status, 200, 'management token is valid at its actual native purpose before DATA refusal');
        assertRead(await request(true, 'GET', route, { headers: { authorization: 'Bearer ' + dataToken } }), id.toHexString());
        assertRefusal(await request(true, 'GET', route, { headers: { authorization: 'Bearer ' + managementToken } }), 'single human management token at DATA');
        assertRefusal(await request(true, 'GET', '/api/v2/authorization/subjects', { headers: { authorization: 'Bearer ' + dataToken } }), 'single human DATA token at management');
        assert.equal((await request(true, 'DELETE', '/api/v2/authorization/subjects/' + made.body._id, { headers: rootHeaders })).status, 200);
        await reload();
        // Shipping single query-token extraction falls back to anonymous when
        // a raw subject no longer exchanges. Its readable default remains read
        // capable; this fixture does not impose the multitenant DATA policy.
        assertRead(await request(false, 'GET', route + '&token=' + encodeURIComponent(subject.accessToken)), id.toHexString());
        // One failed credential per authority avoids adding a second throttled
        // request to the same production delay bucket during this bounded case.
        assertRefusal(await request(true, 'GET', route, { headers: { 'api-secret': subject.accessToken } }), 'single removed raw subject header');
        assertRefusal(await request(false, 'GET', route, { headers: { authorization: 'Bearer ' + exchange.body.token } }), 'single removed subject JWT');
        assertUnchanged(before, await snapshot());
        return { classification: requirements().classification,
          families: { defaultOffSingle: true, singleLegacyCompatibility: true },
          observations: { rawRoot: true, subjectRaw: true, subjectEightHourExchange: true, subjectJWT: true,
            separateHumanPurposes: true, anonymousShippingReadable: true, removedSubjectHeaderAndJWTRefused: true,
            removedRawQueryUsesAnonymousDefault: true, nativeClinicalUnchanged: true, actualRuntimeSingleOff: true } };
      }
      return { router: apps.get(true), exercise, close, manifest: { ...requirements(),
        collections: owned.map(item => ({ ...item })), existingAuthorityCollection: nativeStore.resources.collection } };
    } catch (error) {
      try { await close(); } catch (cleanup) { throw new globalThis.AggregateError([error, cleanup], 'SINGLE_SETUP_AND_CLOSE_FAILED'); }
      throw error;
    }
  }
  create.admit = () => admit({ config, env });
  create.requirements = requirements;
  return create;
}

module.exports = { makeFactory, admit, requirements, assertRead, assertRefusal, assertExchange, assertUnchanged };
