'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const { Client } = require('pg');
const { MongoClient, ObjectId } = require('mongodb');
const express = require('express');
const request = require('supertest');
const shiro = require('shiro-trie');
const { mock } = require('node:test');
const { parse: parseCSV } = require('csv-parse/sync');
const { parseStringPromise: parseXML } = require('xml2js');
const { run } = require('../lib/migrations/postgres');
const connect = require('../lib/storage/postgres-connection');
const scope = require('../lib/storage/tenant-scope');
const { encodeDocument } = require('../lib/storage/postgres-identity');
const authentication = require('../lib/api3/tenant-authentication');
const Collection = require('../lib/api3/generic/collection');
const createDataAccess = require('../lib/server/tenant-app/data-access');
const { createTenantApp } = require('../lib/server/tenant-app');
const createResolver = require('../lib/tenant-resolution');
const createAuthority = require('../lib/tenant-authorization/postgres');
const createLegacyAuthority = require('../lib/secrets/legacy-postgres');
const { createPostgresSecrets } = require('../lib/secrets/postgres');
const { createSecrets } = require('../lib/secrets/component');
const { createVaultTransit } = require('../lib/secrets/vault-transit');
const legacyAuthorization = require('../lib/server/tenant-app/legacy-authorization');
const purifier = require('../lib/server/purifier');
const defaults = require('../lib/api3/const.json');
const factories = {
  profile: require('../lib/server/tenant-app/profile'),
  food: require('../lib/server/tenant-app/food')
};
const catalogues = {
  profile: require('../migrations/candidates/postgres-profile-v1.json'),
  food: require('../migrations/candidates/postgres-food-v1.json'),
  auth: require('../lib/tenant-authorization/postgres-candidate.json'),
  secrets: require('../lib/secrets/postgres-candidate.json'),
  identity: require('../lib/secrets/legacy-credentials-candidate.json')
};
const { optInSuite } = require('./support/opt-in');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SUBJECT = '000000000000000000000001';
const BASE = 1793664000123;
const ID = '65a1b2c3d4e5f60718293a4b';
const GRANTS = Object.keys(factories).flatMap(logical =>
  ['read', 'create', 'update', 'delete'].map(action => `api:${logical}:${action}`));
const hash = value => crypto.createHash('sha1').update(value).digest('hex');
const random = () => crypto.randomBytes(12).toString('hex');
const committedEvents = ['storage-intent-committed', 'storage-socket-create',
  'storage-socket-update', 'storage-socket-delete', 'data-received'];
const withoutClocks = value => {
  if (Array.isArray(value)) return value.map(withoutClocks);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !['srvCreated', 'srvModified', 'lastModified'].includes(key))
    .map(([key, item]) => [key, withoutClocks(item)]));
};

optInSuite(process.env.NS_PROFILE_FOOD_HTTP_TEST === '1' &&
  !!process.env.NS_TEST_POSTGRES_ADMIN_URI && !!process.env.CUSTOMCONNSTR_mongo &&
  !!process.env.NS_PROFILE_FOOD_VAULT_ADDRESS && !!process.env.NS_PROFILE_FOOD_VAULT_TOKEN,
'NS_PROFILE_FOOD_HTTP_TEST=1 with owned PostgreSQL, MongoDB and Vault')(
  'tenant profile/food actual legacy and API3 HTTP differential', function () {
    this.timeout(60000);
    const name = 'pf_' + random();
    const schemas = {
      profile: name + '_profile', food: name + '_food', auth: name + '_auth',
      secrets: name + '_secrets', identity: name + '_identity'
    };
    const role = name + '_app';
    const roots = [random(), random()];
    const credentials = roots.map(root => 'synthetic-' + hash(hash(root) + SUBJECT).slice(0, 16));
    const workers = [], providers = [];
    const mongoCollections = {};
    let mode, admin, mongo, uri, referenceApp, mongoGrants = GRANTS, mongoName = 'Exact Synthetic Name';
    let writeFault = false;
    let storageFault;

    async function vault (resource, body) {
      const response = await fetch(process.env.NS_PROFILE_FOOD_VAULT_ADDRESS + '/v1/' + resource, {
        method: 'POST',
        headers: { 'X-Vault-Token': process.env.NS_PROFILE_FOOD_VAULT_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
      });
      assert.ok(response.ok, 'operator Vault preparation HTTP ' + response.status);
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }

    const rows = async (logical, tenant = A) =>
      (await admin.query(`SELECT doc FROM "${schemas[logical]}".${logical} WHERE tenant_id = $1 ORDER BY "_id", id_kind`, [tenant]))
        .rows.map(row => row.doc);
    const grants = async (permissions, tenant = A) => {
      await admin.query(`UPDATE "${schemas.auth}".tenant_authorization_roles SET permissions = $1 WHERE tenant_id = $2`,
        [permissions, tenant]);
      if (tenant === A) mongoGrants = permissions;
    };
    const displayName = async value => {
      await admin.query(`UPDATE "${schemas.auth}".tenant_authorization_subjects SET display_name = $1 WHERE tenant_id = $2`,
        [value, A]);
      mongoName = value;
    };

    function mount (worker, tenant, reference = false) {
      const ctx = { bus: new EventEmitter(), purifier: purifier({}, {}) };
      const env = { profile_collection: name + '_mongo_profile', food_collection: name + '_mongo_food',
        settings: { enable: ['api'] } };
      const ports = {};
      if (reference) {
        ctx.store = { db: mongo.db(), collection: n => mongo.db().collection(n), ensureIndexes () {} };
        ctx.authorization = {
          isPermitted: permission => (req, res, next) => {
            if (ctx.authorization.checkMultiple(permission, authentication.get(req).shiros)) return next();
            return res.status(401).json({ status: 401, message: 'Unauthorized' });
          },
          resolveWithRequest: (req, callback) => callback(null, authentication.get(req)),
          checkMultiple: (permission, shiros) => shiros.some(trie => trie.check(permission))
        };
      } else {
        ctx.authorization = legacyAuthorization();
        for (const logical of Object.keys(factories)) {
          ports[logical] = factories[logical]({
            connection: worker.connection, table: schemas[logical] + '.' + logical, bus: ctx.bus, env,
            source: 'v1/internal'
          });
        }
        ctx.storagePorts = { resolve: ({ logical, source }) => source === 'v1/internal' ? ports[logical] : undefined };
        for (const event of committedEvents) ctx.bus.on(event, value => {
          worker.events.push({ tenant, event, value });
          if (event === 'storage-intent-committed') {
            worker.visible.push(Promise.all(Object.keys(factories).map(logical => rows(logical, tenant))));
          }
        });
      }
      ctx.profile = require('../lib/server/profile')(env.profile_collection, ctx, env);
      ctx.food = require('../lib/server/food')(env, ctx);
      ctx.wares = require('../lib/middleware')(env);
      const legacy = require('../lib/api')(env, ctx, { domains: ['profile', 'food'], apiEnabled: true });
      const v2 = require('../lib/api2')(env, ctx, legacy, { compatibilityOnly: true });
      const routes = express.Router();
      routes.use(require('../lib/api3/shared/renderer').extension2accept);
      const app = {
        get: (path, handler) => handler === undefined ? defaults[path] : routes.get(path, handler),
        setENVTruthy: () => undefined
      };
      for (const method of ['post', 'put', 'patch', 'delete']) app[method] = routes[method].bind(routes);
      for (const logical of Object.keys(factories)) {
        const options = reference ? {
          ...factories[logical]({ connection: worker.connection, table: schemas[logical] + '.' + logical }),
          storage: new (require('../lib/api3/storage/mongoCollection'))(ctx, env, env[logical + '_collection'], logical),
          intentFactory: undefined
        } : factories[logical]({ connection: worker.connection, table: schemas[logical] + '.' + logical, bus: ctx.bus, env });
        if (reference) {
          delete options.storage;
          delete options.intentFactory;
          delete options.validateCreate;
          delete options.validatePatch;
          delete options.createError;
          delete options.storageError;
        }
        const col = new Collection({
          ctx, env, app, colName: logical, storageColName: env[logical + '_collection'], ...options
        });
        col.mapRoutes();
      }
      return { legacy, v2, routes, ctx, ports };
    }

    async function makeWorker () {
      const worker = { events: [], visible: [], graphs: new Map() };
      workers.push(worker);
      worker.connection = await connect({ connectionString: uri, max: 1 });
      const query = worker.connection.query.bind(worker.connection);
      worker.connection.query = (text, values) => storageFault
        ? Promise.reject(Object.assign(new Error('synthetic storage failure'), { code: storageFault }))
        : query(text, values);
      worker.authority = await createAuthority({ connectionString: uri, namespace: schemas.auth });
      worker.legacy = await createLegacyAuthority({ connectionString: uri, namespace: schemas.identity });
      worker.persistence = await createPostgresSecrets({ connectionString: uri, namespace: schemas.secrets });
      worker.secrets = createSecrets({
        ...worker.persistence, providerFor: async tenant => providers[tenant === A ? 0 : 1],
        authorize: async identity => identity.consumer === 'api',
        maxTokenLifetimeSeconds: 28800, legacyAuthorityFor: tenant => worker.legacy.read(tenant)
      });
      const originalTransaction = worker.connection.transaction.bind(worker.connection);
      worker.connection.transaction = fn => originalTransaction(async () => {
        const result = await fn();
        if (writeFault) throw new Error('synthetic failure after persistence before commit');
        return result;
      });
      const data = express.Router(), legacy = express.Router();
      data.use((req, res, next) => scope.withTenant(req.tenantContext.tenant, next));
      for (const tenant of [A, B]) {
        const graph = mount(worker, tenant);
        worker.graphs.set(tenant, graph);
        data.use((req, res, next) => req.tenantContext.tenant === tenant ? graph.routes(req, res, next) : next());
        legacy.use((req, res, next) => {
          if (scope.currentTenant() !== tenant) return next();
          return (req.baseUrl === '/api/v2' ? graph.v2 : graph.legacy)(req, res, next);
        });
      }
      const unavailable = async () => { throw new Error('unused owner capability'); };
      worker.server = createTenantApp({
        resolver: createResolver({ aliases: [{ host: 'one.example.test', tenant: A }, { host: 'two.example.test', tenant: B }] }),
        dataAccess: createDataAccess({
          secrets: worker.secrets, authority: worker.authority,
          verifierContext: async tenant => ({ tenant, principal: 'verifier', consumer: 'api' }),
          collections: ['profile', 'food'], legacyCollections: ['profile', 'food']
        }),
        verifyCredential: async () => null, authorizeRequest: async () => false,
        tenantSettings: { read: unavailable, replace: unavailable, rollback: unavailable },
        subjectPolicy: { read: unavailable, replace: unavailable }, dataRouter: data, legacyRouter: legacy
      }).listen(0, '127.0.0.1');
      await once(worker.server, 'listening');
      return worker;
    }

    async function closeWorker (worker) {
      if (worker.server) await new Promise(resolve => worker.server.close(resolve));
      worker.server = undefined;
      if (worker.connection) await worker.connection.end();
      if (worker.authority) await worker.authority.close();
      if (worker.legacy) await worker.legacy.close();
      if (worker.persistence) await worker.persistence.close();
    }

    function http (method, path, { tenant = A, worker = workers[0], credential = credentials[tenant === A ? 0 : 1] } = {}) {
      let call = request(worker.server)[method](path)
        .set('Host', tenant === A ? 'one.example.test' : 'two.example.test')
        .timeout({ response: 5000, deadline: 15000 });
      if (credential !== null) call = call.set('api-secret', credential);
      return call;
    }
    const reference = (method, path) => request(referenceApp)[method](path);
    async function same (method, path, body, status = 200, referenceBody = body) {
      // Only wall-clock construction is frozen; socket/database deadlines run
      // normally. In particular legacy food's server-created date is compared.
      mock.timers.enable({ apis: ['Date'], now: Date.now() });
      try {
        let expected = reference(method, path), actual = http(method, path);
        if (body !== undefined) { expected = expected.send(referenceBody); actual = actual.send(body); }
        expected = await expected.expect(status);
        try { actual = await actual.expect(status); } catch (error) {
          error.message = method + ' ' + path + ': ' + error.message;
          throw error;
        }
        assert.deepEqual(withoutClocks(actual.body), withoutClocks(expected.body), path);
        assert.equal(actual.headers.location, expected.headers.location);
        return actual;
      } finally { mock.timers.reset(); }
    }
    async function seed (logical, docs) {
      await admin.query(`DELETE FROM "${schemas[logical]}".${logical}`);
      await mongoCollections[logical].deleteMany({});
      for (const tenant of [A, B]) for (const doc of docs) {
        const row = encodeDocument({ ...doc, tenantMarker: tenant });
        await admin.query(`INSERT INTO "${schemas[logical]}".${logical} (tenant_id, id_kind, doc) VALUES ($1, $2, $3)`,
          [tenant, row.id_kind, row.doc]);
      }
      if (docs.length) await mongoCollections[logical].insertMany(docs.map(doc => ({ ...doc, tenantMarker: A })));
    }

    before(async function () {
      mode = scope.getTenancyMode();
      scope.setTenancyMode('multi');
      for (const [logical, namespace] of Object.entries(schemas)) {
        const catalogue = catalogues[logical];
        const opts = { direct: true, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI, namespace, catalogue };
        await run('up', opts);
        assert.equal((await run('check', opts)).current, true);
      }
      admin = new Client({ connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI });
      await admin.connect();
      const password = random();
      await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      await admin.query(`GRANT USAGE ON SCHEMA ${Object.values(schemas).map(n => '"' + n + '"').join(',')} TO "${role}"`);
      for (const logical of ['profile', 'food']) {
        await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${schemas[logical]}".${logical} TO "${role}"`);
      }
      await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schemas.food}" TO "${role}"`);
      for (const logical of ['auth', 'identity']) {
        await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schemas[logical]}" TO "${role}"`);
      }
      await admin.query(`GRANT SELECT, INSERT ON "${schemas.secrets}".secret_records TO "${role}"`);
      await admin.query(`GRANT INSERT ON "${schemas.secrets}".secret_audit TO "${role}"`);
      const url = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI);
      url.username = role; url.password = password; uri = url.toString();
      await vault('sys/mounts/transit', { type: 'transit' });
      for (const [i, tenant] of [A, B].entries()) {
        for (const purpose of ['data', 'signing']) await vault(`transit/keys/${name}-${i}-${purpose}`, { type: 'aes256-gcm96' });
        providers.push(createVaultTransit({
          address: process.env.NS_PROFILE_FOOD_VAULT_ADDRESS, mount: 'transit',
          encryptionKey: `${name}-${i}-data`, signingKey: `${name}-${i}-signing`, signingVersion: 1,
          getToken: async () => process.env.NS_PROFILE_FOOD_VAULT_TOKEN, allowInsecureLoopback: true
        }));
        await admin.query(`INSERT INTO "${schemas.identity}".legacy_credential_config VALUES ($1, 'synthetic-import')`, [tenant]);
        await admin.query(`INSERT INTO "${schemas.identity}".legacy_credential_subjects VALUES ($1, $2, 'synthetic')`, [tenant, SUBJECT]);
        await admin.query(`INSERT INTO "${schemas.auth}".tenant_authorization_config VALUES ($1, ARRAY['denied'])`, [tenant]);
        await admin.query(`INSERT INTO "${schemas.auth}".tenant_authorization_subjects
          (tenant_id, subject_id, display_name) VALUES ($1, $2, 'Exact Synthetic Name')`, [tenant, SUBJECT]);
        await admin.query(`INSERT INTO "${schemas.auth}".tenant_authorization_roles VALUES ($1, 'writer', $2)`, [tenant, GRANTS]);
        await admin.query(`INSERT INTO "${schemas.auth}".tenant_authorization_subject_roles VALUES ($1, $2, 'writer')`, [tenant, SUBJECT]);
      }
      await makeWorker();
      for (const [i, tenant] of [A, B].entries()) {
        await workers[0].secrets.encrypt({ tenant, principal: 'issuer', consumer: 'api' }, 'synthetic-import', Buffer.from(roots[i]));
      }
      await makeWorker();
      mongo = new MongoClient(process.env.CUSTOMCONNSTR_mongo);
      await mongo.connect();
      for (const logical of Object.keys(factories)) mongoCollections[logical] = mongo.db().collection(name + '_mongo_' + logical);
      const graph = mount(workers[0], A, true);
      referenceApp = express();
      referenceApp.use((req, res, next) => {
        const trie = shiro.new(); mongoGrants.forEach(grant => trie.add(grant));
        authentication.bind(req, { shiros: [trie], subject: { name: mongoName } });
        scope.withTenant(A, next);
      });
      referenceApp.use('/api/v1', graph.legacy);
      referenceApp.use('/api/v2', graph.v2);
      referenceApp.use('/api/v3', ...require('../lib/api3/shared/jsonParser')(), graph.routes);
      await http('get', '/api/v3/profile/not-present').expect(404);
      await http('get', '/api/v1/food').expect(200);
    });

    beforeEach(async function () {
      writeFault = false;
      storageFault = undefined;
      await seed('profile', []);
      await seed('food', []);
      await grants(GRANTS);
      await displayName('Exact Synthetic Name');
      for (const worker of workers) { worker.events.length = 0; worker.visible.length = 0; }
    });
    after(async function () {
      try {
        for (const worker of workers.reverse()) if (worker.server) await closeWorker(worker);
        if (mongo) {
          for (const collection of Object.values(mongoCollections)) await collection.drop();
          await mongo.close();
        }
        if (admin) {
          for (const namespace of Object.values(schemas)) await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
          await admin.query(`DROP ROLE IF EXISTS "${role}"`);
          await admin.end();
        }
      } finally { if (mode !== undefined) scope.setTenancyMode(mode); }
    });

    it('preserves profile plural/current/list order, typed identity and keep-boundary pruning across v1/v2', async function () {
      const docs = Array.from({ length: 14 }, (_, i) => ({
        _id: new ObjectId((100 + i).toString(16).padStart(24, '0')),
        startDate: i < 2 ? null : i < 4 ? i : '2026-11-' + String(i).padStart(2, '0'),
        created_at: '2020-01-01', store: { Default: { extension: { nested: [i, null] } } }
      }));
      await seed('profile', docs);
      for (const v of [1, 2]) {
        await same('get', `/api/v${v}/profiles?count=3`);
        await same('get', `/api/v${v}/profile?count=2`);
        await same('get', `/api/v${v}/profile/current`);
        await same('get', `/api/v${v}/profiles?find[_id]=${docs[4]._id}`);
      }
      await same('delete', '/api/v2/profile?keep=10');
      assert.equal((await rows('profile')).length, 10);
      assert.equal((await rows('profile', B)).length, 14);
      await same('get', '/api/v1/profile/current');
    });

    it('uses legacy profile merge retries and whole-store semantics, retains unknown JSON, and v3 created_at fallback', async function () {
      const doc = { _id: ID, startDate: '2026-11-04', created_at: '2026-10-01T00:00:00.000Z',
        store: { 'Profile 1.5': { basal: [{ time: '00:00', value: 1 }], unknown: [null, { retained: true }] } },
        'extension-key': { 'ユニコード': [null, false], 'literal.dot': { untouched: true } },
        extension: { original: true } };
      await same('post', '/api/v1/profile', doc);
      assert.equal((await rows('profile')).length, 1, 'a successful legacy create must persist its profile');
      const first = (await rows('profile'))[0];
      await same('post', '/api/v2/profile', doc);
      assert.equal((await rows('profile'))[0].srvModified, first.srvModified);
      await same('post', '/api/v2/profile', { ...doc, store: { Alternate: { nested: { unknown: 'kept' } } } });
      const read = await same('get', '/api/v3/profile/' + ID);
      assert.deepEqual(read.body.result.store, { Alternate: { nested: { unknown: 'kept' } } });
      assert.deepEqual(read.body.result['extension-key'], doc['extension-key']);
      assert.equal(read.body.result.identifier, ID);
      await same('put', '/api/v1/profile', { _id: ID, startDate: 'future', created_at: doc.created_at, extension: ['replacement'] });
      assert.equal((await rows('profile'))[0].store, undefined);
      await same('delete', '/api/v2/profile/' + ID);
      assert.deepEqual(await rows('profile'), []);
      await seed('profile', [{ _id: ID, created_at: doc.created_at, startDate: '2099-01-01' }]);
      const fallback = await same('get', '/api/v3/profile/' + ID);
      assert.equal(fallback.body.result.srvModified, Date.parse(doc.created_at));
    });

    it('preserves food quickpick numeric order, mixed hidden flags, regular filtering and edit insertion order', async function () {
      const docs = [
        { type: 'quickpick', position: '10', hidden: 'false' },
        { type: 'quickpick', position: 2, hidden: false },
        { type: 'quickpick', position: '1' },
        { type: 'quickpick', position: 0, hidden: 'true' },
        { type: 'quickpick', position: 0, hidden: true },
        { type: 'food', name: 'regular' },
        { type: 'quickpick', position: 1, isValid: false }
      ].map((doc, i) => ({ ...doc, _id: new ObjectId((200 + i).toString(16).padStart(24, '0')), created_at: '2026-01-01' }));
      await seed('food', docs);
      for (const v of [1, 2]) for (const path of ['food', 'food/quickpicks', 'food/regular']) {
        await same('get', `/api/v${v}/${path}`);
      }
      const quick = await same('get', '/api/v2/food/quickpicks');
      assert.deepEqual(quick.body.map(doc => Number(doc.position)), [1, 2, 10]);
      await same('put', '/api/v1/food', { _id: String(docs[1]._id), type: 'quickpick', position: '3',
        created_at: '2025-01-01T00:00:00.000Z', unknown: { nested: ['retained'] } });
      await same('get', '/api/v2/food');
      await same('get', '/api/v1/food/quickpicks');
      assert.equal((await rows('food')).find(doc => doc._id === String(docs[1]._id)).created_at, '2025-01-01T00:00:00.000Z');
      await same('delete', '/api/v2/food/' + docs[1]._id);
      await same('get', '/api/v1/food');
    });

    for (const logical of ['profile', 'food']) {
      it(`${logical}: cross-version create/addressed PUT/PATCH/delete/history and restart retain source rules`, async function () {
        const doc = { _id: ID, type: 'food', name: 'synthetic', app: 'synthetic', utcOffset: 0,
          startDate: '2026-11-04', created_at: '2026-10-01T00:00:00.000Z',
          extension: { removed: true, retained: [null, false, { unknown: 'kept' }] } };
        await same('post', '/api/v2/' + logical, doc);
        const created = (await rows(logical))[0];
        if (logical === 'food') assert.notEqual(created.created_at, doc.created_at);
        else assert.equal(created.created_at, doc.created_at);
        await same('get', `/api/v3/${logical}/${ID}`);
        await displayName('Renamed Exact Subject');
        await same('patch', `/api/v3/${logical}/${ID}`, { extension: { removed: null, added: 3 } });
        assert.equal((await rows(logical))[0].modifiedBy, 'Renamed Exact Subject');
        assert.deepEqual((await rows(logical))[0].extension, { retained: doc.extension.retained, added: 3 });
        const replace = {
          identifier: ID, created_at: created.created_at, app: 'synthetic', utcOffset: 0,
          type: 'food', name: 'replacement', extra: { unknown: true }
        };
        const oracleCreated = (await mongoCollections[logical].findOne({ _id: new ObjectId(ID) })).created_at;
        await same('put', `/api/v3/${logical}/${ID}`, replace, 200, { ...replace, created_at: oracleCreated });
        await same('get', `/api/v1/${logical}`);
        await closeWorker(workers[workers.length - 1]);
        const replacement = await makeWorker();
        const reopened = await http('get', `/api/v3/${logical}/${ID}`, { worker: replacement }).expect(200);
        assert.equal(reopened.body.result.extra.unknown, true);
        await same('delete', `/api/v3/${logical}/${ID}`);
        const history = await same('get', `/api/v3/${logical}/history/${BASE}`);
        assert.equal(history.body.result[0].isValid, false);
        await same('get', `/api/v1/${logical}`);
        await same('delete', `/api/v3/${logical}/${ID}?permanent=true`);
        assert.deepEqual(await rows(logical), []);
        await same('post', `/api/v3/${logical}`, {
          identifier: 'api3-new', created_at: doc.created_at, app: 'synthetic',
          startDate: 'future', unknown: { extension: [1, null] }
        }, 201);
        const legacy = await http('get', `/api/v2/${logical}`).expect(200);
        assert.equal(legacy.body[0].identifier, 'api3-new');
        await same('get', `/api/v3/${logical}?limit=2`);
      });
    }

    it('enforces persisted grants and exact current names, root explicitly, invalid never anonymous and overlapping tenants', async function () {
      for (const logical of ['profile', 'food']) {
        await seed(logical, [{ _id: new ObjectId(ID), identifier: 'shared', created_at: '2026-01-01',
          startDate: '2026-01-01', type: 'food', name: 'synthetic', srvModified: BASE, srvCreated: BASE }]);
        await http('patch', `/api/v3/${logical}/shared`, { tenant: B }).send({ extension: 'tenant-b' }).expect(200);
        assert.equal((await rows(logical))[0].extension, undefined);
        assert.equal((await rows(logical, B))[0].extension, 'tenant-b');
        await grants(['api:' + logical + ':read']);
        await http('patch', `/api/v3/${logical}/shared`).send({ extension: 'forbidden' }).expect(403);
        await http('get', `/api/v3/${logical}/shared`, { credential: 'invalid' }).expect(401);
        await http('get', `/api/v3/${logical}/shared`, { credential: credentials[1] }).expect(401);
        await http('patch', `/api/v3/${logical}/shared`, { credential: null }).send({ extension: 'anonymous' }).expect(403);
        await http('patch', `/api/v3/${logical}/shared`, { credential: hash(roots[0]) }).send({ extension: 'root' }).expect(200);
        await grants(GRANTS);
        await displayName('Newest Exact Name');
        await http('patch', `/api/v3/${logical}/shared`).send({ extension: 'renamed' }).expect(200);
        assert.equal((await rows(logical))[0].modifiedBy, 'Newest Exact Name');
        await grants([]);
        await http('get', `/api/v2/${logical}`).expect(401);
        await grants(GRANTS);
      }
    });

    it('rolls back complete legacy batches and v3 writes and emits no event before commit', async function () {
      for (const logical of ['profile', 'food']) {
        const doc = { _id: ID, startDate: '2026-01-01', type: 'food', name: 'synthetic' };
        writeFault = true;
        await http('post', `/api/v2/${logical}`).send([doc, { ...doc, _id: '65a1b2c3d4e5f60718293a4c' }]).expect(500);
        assert.deepEqual(await rows(logical), []);
        assert.deepEqual(workers[0].events, []);
        await http('post', `/api/v3/${logical}`).send({
          identifier: 'failure', created_at: '2026-01-01', app: 'synthetic'
        }).expect(500);
        assert.deepEqual(await rows(logical), []);
        assert.deepEqual(workers[0].events, []);
        writeFault = false;
        await http('post', `/api/v1/${logical}`).send(doc).expect(200);
        assert.ok(workers[0].events.some(item => item.event === 'storage-intent-committed'));
        const visible = await Promise.all(workers[0].visible);
        assert.ok(visible.every(snapshot => snapshot.some(docs => docs.some(item => item._id === ID))));
        workers[0].events.length = 0; workers[0].visible.length = 0;
      }
    });

    it('preserves batch slots, defaults, carrier stripping, formats, HEAD/OPTIONS and v3 shipping refusals', async function () {
      for (const logical of ['profile', 'food']) {
        const doc = { _id: ID, startDate: '2026-01-01', type: 'food', name: 'synthetic' };
        await same('post', `/api/v1/${logical}?results=items`, [doc, { ...doc, _id: 'invalid' }]);
        const before = await rows(logical);
        await same('get', `/api/v2/${logical}.json`);
        await http('head', `/api/v2/${logical}`).expect(200);
        await http('options', `/api/v2/${logical}`).expect(200);
        await same('get', `/api/v3/${logical}/history`, undefined, 400);
        await same('patch', `/api/v3/${logical}/${ID}`, {}, 400);
        await same('patch', `/api/v3/${logical}/${ID}`, { _id: 'illegal' }, 400);
        for (const call of [http('patch', `/api/v3/${logical}/${ID}`), reference('patch', `/api/v3/${logical}/${ID}`)]) {
          await call.set('If-Unmodified-Since', new Date(0).toUTCString()).send({ name: 'new' }).expect(412);
        }
        assert.deepEqual(await rows(logical), before);
      }
    });

    it('keeps ObjectId and string twins distinct until legacy edit/delete deliberately collapses them', async function () {
      for (const logical of ['profile', 'food']) {
        await seed(logical, [
          { _id: ID, created_at: '2026-01-01', startDate: '2026-01-01', type: 'food', name: 'string' },
          { _id: new ObjectId(ID), created_at: '2026-01-01', startDate: '2026-01-01', type: 'food', name: 'objectid' }
        ]);
        await same('get', `/api/v3/${logical}/${ID}`);
        const kinds = await admin.query(`SELECT id_kind FROM "${schemas[logical]}".${logical} WHERE tenant_id = $1`, [A]);
        assert.deepEqual(kinds.rows.map(row => row.id_kind).sort(), ['objectid', 'string']);
        await same('put', `/api/v2/${logical}`, { _id: ID, type: 'food', name: 'replacement',
          created_at: '2026-01-01', startDate: '2026-01-01' });
        assert.equal((await rows(logical)).length, 1);
        assert.equal((await rows(logical, B)).length, 2);
        await same('delete', `/api/v1/${logical}/${ID}`);
        assert.deepEqual(await rows(logical), []);
      }
    });

    it('retains create-only profile retry access but refuses changing resends atomically and in per-item slots', async function () {
      const doc = { _id: ID, startDate: '2026-01-01', store: { Default: { nested: 'original' } } };
      await same('post', '/api/v1/profile', doc);
      await grants(['api:profile:read', 'api:profile:create']);
      await same('post', '/api/v2/profile', doc);
      const before = await rows('profile');
      const body = [{ ...doc, store: { Changed: {} } }, { ...doc, _id: '65a1b2c3d4e5f60718293a4c' }];
      await same('post', '/api/v1/profile', body, 401);
      assert.deepEqual(await rows('profile'), before);
      const partial = await same('post', '/api/v2/profile?results=items', body);
      assert.equal(partial.body.items[0].status, 403);
      assert.equal((await rows('profile')).length, 2);
      assert.deepEqual((await rows('profile')).find(item => item._id === ID).store, doc.store);
    });

    it('preserves legacy body/query credentials after parsing and never stores carrier fields', async function () {
      for (const v of [1, 2]) for (const logical of ['profile', 'food']) {
        const body = { _id: ID, type: 'food', name: 'synthetic', startDate: '2026-01-01', secret: credentials[0] };
        await http('post', `/api/v${v}/${logical}`, { credential: null }).send(body).expect(200);
        assert.equal((await rows(logical))[0].secret, undefined);
        await http('get', `/api/v${v}/${logical}?secret=${credentials[0]}`, { credential: null }).expect(200);
        await http('get', `/api/v${v}/${logical}?token=${credentials[0]}`, { credential: null }).expect(200);
        await http('delete', `/api/v${v}/${logical}/${ID}?secret=${credentials[0]}`, { credential: null }).expect(200);
        assert.deepEqual(await rows(logical), []);
      }
    });

    it('renders actual API3 JSON/CSV/XML and negotiated refusal without silently dropping extensions', async function () {
      for (const logical of ['profile', 'food']) {
        await seed(logical, [{ _id: ID, identifier: 'shared', startDate: '2026-01-01', created_at: '2026-01-01',
          type: 'food', name: 'synthetic', extra: { unknown: [null, 3] }, srvModified: BASE, srvCreated: BASE }]);
        for (const accept of ['application/json', 'text/csv', 'application/xml']) {
          const expected = await reference('get', `/api/v3/${logical}`).set('Accept', accept).expect(200);
          const actual = await http('get', `/api/v3/${logical}`).set('Accept', accept).expect(200);
          assert.equal(actual.headers['content-type'], expected.headers['content-type']);
          if (accept === 'application/json') assert.deepEqual(actual.body, expected.body);
          else if (accept === 'text/csv') assert.deepEqual(parseCSV(actual.text, { columns: true }), parseCSV(expected.text, { columns: true }));
          else assert.deepEqual(await parseXML(actual.text), await parseXML(expected.text));
          assert.ok(actual.text.includes('synthetic'));
        }
        await http('get', `/api/v3/${logical}`).set('Accept', 'image/png').expect(406);
        await http('head', `/api/v3/${logical}`).expect(200);
        await http('options', `/api/v3/${logical}`).expect(200);
        await http('get', `/api/v3/${logical}.csv`).expect(200);
        await http('get', `/api/v3/${logical}.unknown`).expect(406);
      }
    });

    it('distinguishes submitted nonrepresentable documents, known outages and internal failures without write/events', async function () {
      for (const logical of ['profile', 'food']) {
        await http('post', `/api/v3/${logical}`).send({
          identifier: 'nonrepresentable', created_at: '2026-01-01', app: 'synthetic', extra: '\ud800'
        }).expect(400);
        assert.deepEqual(await rows(logical), []);
        assert.deepEqual(workers[0].events, []);
        for (const [code, status] of [['ECONNRESET', 503], ['42P01', 500]]) {
          storageFault = code;
          await http('get', `/api/v2/${logical}`).expect(status);
          await http('get', `/api/v3/${logical}`).expect(status);
          await http('get', `/api/v3/${logical}/absent`).expect(status);
          await http('get', `/api/v3/${logical}/history/${BASE}`).expect(status);
          storageFault = undefined;
        }
      }
    });
  });
