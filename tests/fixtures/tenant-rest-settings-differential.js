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
const { run } = require('../../lib/migrations/postgres');
const connect = require('../../lib/storage/postgres-connection');
const scope = require('../../lib/storage/tenant-scope');
const { encodeDocument } = require('../../lib/storage/postgres-identity');
const authentication = require('../../lib/api3/tenant-authentication');
const Collection = require('../../lib/api3/generic/collection');
const createDataAccess = require('../../lib/server/tenant-app/data-access');
const { createTenantApp } = require('../../lib/server/tenant-app');
const createResolver = require('../../lib/tenant-resolution');
const createAuthority = require('../../lib/tenant-authorization/postgres');
const createLegacyAuthority = require('../../lib/secrets/legacy-postgres');
const { createPostgresSecrets } = require('../../lib/secrets/postgres');
const { createSecrets } = require('../../lib/secrets/component');
const { createVaultTransit } = require('../../lib/secrets/vault-transit');
const legacyAuthorization = require('../../lib/server/tenant-app/legacy-authorization');
const purifier = require('../../lib/server/purifier');
const defaults = require('../../lib/api3/const.json');
const factories = { settings: require('../../lib/server/tenant-app/settings') };
const catalogues = { settings: require('../../migrations/candidates/postgres-settings-v1.json'),
  auth: require('../../lib/tenant-authorization/postgres-candidate.json'),
  secrets: require('../../lib/secrets/postgres-candidate.json'),
  identity: require('../../lib/secrets/legacy-credentials-candidate.json') };

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SUBJECT = '000000000000000000000001';
const BASE = 1793664000123;
const ID = '65a1b2c3d4e5f60718293a4b';
const GRANTS = Object.keys(factories).flatMap(logical =>
  ['read', 'create', 'update', 'delete', 'admin'].map(action => `api:${logical}:${action}`));
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

module.exports = function settingsFixture () {
    const name = 'settings_test_' + random();
    const schemas = Object.fromEntries(Object.keys(catalogues).map(key => [key, name + '_' + key]));
    const role = name + '_app';
    const roots = [random(), random()];
    const credentials = roots.map(root => 'synthetic-' + hash(hash(root) + SUBJECT).slice(0, 16));
    const workers = [], providers = [];
    const mongoCollections = {};
    let mode, admin, mongo, uri, referenceApp, mongoGrants = GRANTS, mongoName = 'Exact Synthetic Name';
    let writeFault = false;
    let storageFault;

    async function vault (resource, body) {
      const response = await fetch(process.env.NS_SETTINGS_VAULT_ADDRESS + '/v1/' + resource, {
        method: 'POST',
        headers: { 'X-Vault-Token': process.env.NS_SETTINGS_VAULT_TOKEN, 'Content-Type': 'application/json' },
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
      const env = { settings_collection: name + '_mongo_settings', settings: { enable: ['api'] } };
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
        for (const event of committedEvents) ctx.bus.on(event, value => {
          worker.events.push({ tenant, event, value });
          if (event === 'storage-intent-committed') {
            worker.visible.push(Promise.all(Object.keys(factories).map(logical => rows(logical, tenant))));
          }
        });
      }
      const routes = express.Router();
      routes.use(require('../../lib/api3/shared/renderer').extension2accept);
      const app = {
        get: (path, handler) => handler === undefined ? defaults[path] : routes.get(path, handler),
        setENVTruthy: () => undefined
      };
      for (const method of ['post', 'put', 'patch', 'delete']) app[method] = routes[method].bind(routes);
      for (const logical of Object.keys(factories)) {
        const options = reference ? {} : factories[logical]({
          connection: worker.connection, table: schemas[logical] + '.' + logical, bus: ctx.bus, env
        });
        const col = new Collection({
          ctx, env, app, colName: logical, storageColName: env[logical + '_collection'], ...options
        });
        if (!reference) {
          const findMany = col.storage.findMany.bind(col.storage);
          col.storage.findMany = args => {
            worker.sorts.push({ ...args.sort });
            return findMany(args);
          };
        }
        ports[logical] = col.storage;
        col.mapRoutes();
      }
      return { routes, ctx, ports };
    }

    async function makeWorker () {
      const worker = { events: [], visible: [], sorts: [], graphs: new Map() };
      workers.push(worker);
      worker.connection = await connect({ connectionString: uri, max: 1 });
      const query = worker.connection.query.bind(worker.connection);
      worker.connection.query = (text, values) => storageFault
        ? Promise.reject(typeof storageFault === 'string'
          ? Object.assign(new Error('synthetic storage failure'), { code: storageFault }) : storageFault)
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
      const data = express.Router();
      data.use((req, res, next) => scope.withTenant(req.tenantContext.tenant, next));
      for (const tenant of [A, B]) {
        const graph = mount(worker, tenant);
        worker.graphs.set(tenant, graph);
        data.use((req, res, next) => req.tenantContext.tenant === tenant ? graph.routes(req, res, next) : next());

      }
      const unavailable = async () => { throw new Error('unused owner capability'); };
      worker.server = createTenantApp({
        resolver: createResolver({ aliases: [{ host: 'one.example.test', tenant: A }, { host: 'two.example.test', tenant: B }] }),
        dataAccess: createDataAccess({
          secrets: worker.secrets, authority: worker.authority,
          verifierContext: async tenant => ({ tenant, principal: 'verifier', consumer: 'api' }),
          collections: ['settings']
        }),
        verifyCredential: async () => null, authorizeRequest: async () => false,
        tenantSettings: { read: unavailable, replace: unavailable, rollback: unavailable },
        subjectPolicy: { read: unavailable, replace: unavailable }, dataRouter: data
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
      // normally. Server timestamps are excluded explicitly by withoutClocks.
      mock.timers.enable({ apis: ['Date'], now: Date.now() });
      try {
        let expected = reference(method, path), actual = http(method, path);
        if (body !== undefined) { expected = expected.send(referenceBody); actual = actual.send(body); }
        expected = await expected;
        actual = await actual;
        assert.equal(expected.status, status, "Mongo " + method + " " + path + " " + JSON.stringify(expected.body));
        assert.equal(actual.status, status, "PG " + method + " " + path + " " + JSON.stringify(actual.body));
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
      for (const logical of ['settings']) {
        await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${schemas[logical]}".${logical} TO "${role}"`);
      }
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
          address: process.env.NS_SETTINGS_VAULT_ADDRESS, mount: 'transit',
          encryptionKey: `${name}-${i}-data`, signingKey: `${name}-${i}-signing`, signingVersion: 1,
          getToken: async () => process.env.NS_SETTINGS_VAULT_TOKEN, allowInsecureLoopback: true
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
      referenceApp.use('/api/v3', ...require('../../lib/api3/shared/jsonParser')(), graph.routes);
      await http('get', '/api/v3/settings/not-present').expect(404);
    });

    beforeEach(async function () {
      writeFault = false;
      storageFault = undefined;
      await seed('settings', []);
      await grants(GRANTS);
      await displayName('Exact Synthetic Name');
      for (const worker of workers) { worker.events.length = 0; worker.visible.length = 0; worker.sorts.length = 0; }
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


    return { A, B, ID, BASE, ObjectId, same, http, reference, seed, rows, grants, displayName,
      workers, makeWorker, closeWorker,
      mongoRows: () => mongoCollections.settings.find({}).sort({ _id: 1 }).toArray(),
      storage: () => workers[0].graphs.get(A).ports.settings,
      rawGrants: GRANTS,
      setWriteFault: value => { writeFault = value; },
      setStorageFault: value => { storageFault = value; } };
};
