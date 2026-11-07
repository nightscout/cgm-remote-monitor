'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const { Client } = require('pg');
const { MongoClient } = require('mongodb');
const express = require('express');
const request = require('supertest');
const shiro = require('shiro-trie');
const { run } = require('../../lib/migrations/postgres');
const connect = require('../../lib/storage/postgres-connection');
const scope = require('../../lib/storage/tenant-scope');
const { encodeDocument } = require('../../lib/storage/postgres-identity');
const createAuthority = require('../../lib/tenant-authorization/postgres');
const { createSecrets } = require('../../lib/secrets/component');
const createDataAccess = require('../../lib/server/tenant-app/data-access');
const { createTenantApp } = require('../../lib/server/tenant-app');
const createResolver = require('../../lib/tenant-resolution');
const Collection = require('../../lib/api3/generic/collection');
const configureApi3 = require('../../lib/api3');
const authentication = require('../../lib/api3/tenant-authentication');
const entriesOptions = require('../../lib/server/tenant-app/entries');
const purifier = require('../../lib/server/purifier');
const provider = require('./tenant-credential-provider');
const apiDefaults = require('../../lib/api3/const.json');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SUBJECT = '000000000000000000000001';
const hash = value => crypto.createHash('sha1').update(value).digest('hex');
const EVENTS = ['storage-intent-committed', 'storage-socket-create', 'storage-socket-update',
  'storage-socket-delete', 'data-received'];
const GRANTS = ['read', 'create', 'update', 'delete'].map(action => 'api:entries:' + action);

// Only service I/O and deployment composition are fixtures. Every CRUD route,
// parser, purifier, permission check and intent is the shipping implementation.
module.exports = function crudHTTP ({ legacy = false } = {}) {
  const name = 'crud_' + crypto.randomBytes(8).toString('hex');
  const auth = name + '_auth';
  const role = name + '_app';
  const roots = [A, B].map(() => crypto.randomBytes(24).toString('hex'));
  const providers = [provider(), provider()];
  const records = new Map();
  const workers = [];
  const lab = { A, B, SUBJECT, GRANTS, workers, name, table: name + '.entries',
    mongoEvents: [], mongoGrants: GRANTS, mongoName: 'Current Exact Name' };
  let mode, mongo, admin;

  lab.open = async function () {
    mode = scope.getTenancyMode();
    scope.setTenancyMode('multi');
    admin = lab.admin = new Client({ connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI });
    await admin.connect();
    for (const [namespace, catalogue] of [
      [name, require('../../migrations/candidates/postgres-entries-v1.json')],
      [auth, require('../../lib/tenant-authorization/postgres-candidate.json')]
    ]) await run('up', { direct: true, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI, namespace, catalogue });
    const password = crypto.randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${name}", "${auth}" TO "${role}"`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${name}".entries TO "${role}"`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${auth}" TO "${role}"`);
    const uri = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI);
    uri.username = role;
    uri.password = password;
    for (const tenant of [A, B]) {
      await admin.query(`INSERT INTO "${auth}".tenant_authorization_config VALUES ($1, ARRAY['denied'])`, [tenant]);
      await admin.query(`INSERT INTO "${auth}".tenant_authorization_subjects
        (tenant_id, subject_id, display_name) VALUES ($1, $2, 'Current Exact Name')`, [tenant, SUBJECT]);
      await admin.query(`INSERT INTO "${auth}".tenant_authorization_roles VALUES ($1, 'writer', $2)`, [tenant, GRANTS]);
      await admin.query(`INSERT INTO "${auth}".tenant_authorization_subject_roles VALUES ($1, $2, 'writer')`, [tenant, SUBJECT]);
    }

    for (let index = 0; index < 2; index++) {
      const worker = { events: [], visible: [], collections: new Map(), environments: new Map(), legacy: new Map() };
      workers.push(worker);
      worker.connection = await connect({ connectionString: uri.toString(), max: 1 });
      worker.authority = { ...await createAuthority({ connectionString: uri.toString(), namespace: auth }) };
      worker.secrets = createSecrets({
        providerFor: async tenant => providers[tenant === A ? 0 : 1],
        store: {
          async get (tenant, id) { return records.get(tenant + ':' + id); },
          async insert (record) { records.set(record.tenant + ':' + record.id, record); }
        },
        authorize: async identity => identity.consumer === 'api',
        audit: async () => {},
        maxTokenLifetimeSeconds: 28800,
        legacyAuthorityFor: async tenant => ({
          reference: { tenant, id: 'synthetic-import' },
          subjects: [{ subjectId: SUBJECT, tokenPrefix: 'synthetic' }]
        })
      });
      const data = express.Router();
      data.use((req, res, next) => scope.withTenant(req.tenantContext.tenant, next));
      for (const tenant of [A, B]) {
        const routes = express.Router();
        const bus = new EventEmitter();
        for (const event of EVENTS) bus.on(event, value => {
          worker.events.push({ tenant, event, value });
          // Use an independent connection, not an already-owned transaction.
          worker.visible.push(lab.rows(tenant));
        });
        const app = {
          get: (path, handler) => handler === undefined ? apiDefaults[path] : routes.get(path, handler),
          setENVTruthy: () => undefined
        };
        for (const method of ['post', 'put', 'patch', 'delete']) app[method] = routes[method].bind(routes);
        const env = legacy ? { entries_collection: name, settings: { enable: [], deNormalizeDates: false },
          extendedSettings: {}, DISPLAY_UNITS: 'mg/dl', name: 'synthetic', version: 'test' } : {};
        const col = new Collection({
          ctx: { bus, purifier: purifier({}, {}) }, env, app, colName: 'entries', storageColName: 'entries',
          fallbackGetDate: doc => new Date(doc.srvModified), fallbackDateField: 'date',
          dedupFallbackFields: ['date', 'type'],
          ...entriesOptions({ connection: worker.connection, table: lab.table, env, bus })
        });
        col.mapRoutes();
        worker.collections.set(tenant, col);
        worker.environments.set(tenant, env);
        if (legacy) {
          const port = entriesOptions({ connection: worker.connection, table: lab.table, env, bus, source: 'v1/internal' });
          const ctx = { bus, purifier: purifier({}, {}), ddata: require('../../lib/data/ddata')(),
            storagePorts: { resolve: selection => selection.logical === 'entries' ? port : null } };
          ctx.cache = require('../../lib/server/cache')(env, ctx);
          worker.legacy.set(tenant, require('../../lib/server/tenant-app/legacy-domains')({ env, ctx, domains: ['entries'] }));
        }
        data.use((req, res, next) => req.tenantContext.tenant === tenant ? routes(req, res, next) : next());
      }
      const unavailable = async () => { throw new Error('unused owner capability'); };
      worker.server = createTenantApp({
        resolver: createResolver({ aliases: [
          { host: 'one.example.test', tenant: A }, { host: 'two.example.test', tenant: B }
        ] }),
        dataAccess: createDataAccess({ secrets: worker.secrets, authority: worker.authority,
          legacyCollections: legacy ? ['entries'] : [],
          verifierContext: async tenant => ({ tenant, principal: 'verifier', consumer: 'api' }) }),
        verifyCredential: async () => null, authorizeRequest: async () => false,
        tenantSettings: { read: unavailable, replace: unavailable, rollback: unavailable },
        subjectPolicy: { read: unavailable, replace: unavailable }, dataRouter: data,
        ...(legacy ? { legacyRouter: (req, res, next) => worker.legacy.get(scope.currentTenant())(req, res, next) } : {})
      }).listen(0, '127.0.0.1');
      await once(worker.server, 'listening');
      assert.equal(worker.server.address().address, '127.0.0.1');
    }
    for (const [index, tenant] of [A, B].entries()) {
      await workers[0].secrets.encrypt({ tenant, principal: 'issuer', consumer: 'api' },
        'synthetic-import', Buffer.from(roots[index]));
    }
    lab.credentials = roots.map(root => 'synthetic-' + hash(hash(root) + SUBJECT).slice(0, 16));
    lab.rootCredentials = roots.map(hash);
    mongo = new MongoClient(process.env.CUSTOMCONNSTR_mongo);
    await mongo.connect();
    lab.mongoCollection = mongo.db().collection(name);
    const app = express();
    app.use((req, res, next) => {
      const grants = shiro.new();
      lab.mongoGrants.forEach(grant => grants.add(grant));
      authentication.bind(req, { shiros: [grants], ...(lab.mongoName ? { subject: { name: lab.mongoName } } : {}) });
      scope.withTenant(A, next);
    });
    const bus = new EventEmitter();
    for (const event of EVENTS) bus.on(event, value => lab.mongoEvents.push({ event, value }));
    const api = configureApi3({
      entries_collection: name, api3: { API3_SECURITY_ENABLE: true, API3_DEDUP_FALLBACK_ENABLED: true }
    }, { store: { db: mongo.db(), collection: n => mongo.db().collection(n), ensureIndexes () {} },
      purifier: purifier({}, {}), bus });
    lab.mongoCol = api.get('collections').entries;
    app.use(api);
    lab.mongoApp = app;
    if (legacy) {
      const env = { entries_collection: name, settings: { enable: [], deNormalizeDates: false },
        extendedSettings: {}, DISPLAY_UNITS: 'mg/dl', name: 'synthetic', version: 'test' };
      const ctx = { store: { collection: n => mongo.db().collection(n) },
        bus, purifier: purifier({}, {}), ddata: require('../../lib/data/ddata')(),
        authorization: require('../../lib/server/tenant-app/legacy-authorization')(),
        wares: require('../../lib/middleware')(env) };
      ctx.cache = require('../../lib/server/cache')(env, ctx);
      ctx.entries = require('../../lib/server/entries')(env, ctx);
      const v1 = require('../../lib/api')(env, ctx, { domains: ['entries'], apiEnabled: true });
      const v2 = require('../../lib/api2')(env, ctx, v1, { compatibilityOnly: true });
      const reference = express();
      reference.use((req, res, next) => {
        const grants = shiro.new();
        lab.mongoGrants.forEach(grant => grants.add(grant));
        authentication.bind(req, { shiros: [grants], subject: { name: lab.mongoName } });
        req.tenantAuthenticate = async () => ({ tenant: A, principal: SUBJECT, consumer: 'api' });
        scope.withTenant(A, next);
      });
      reference.use('/api/v1', v1);
      reference.use('/api/v2', v2);
      lab.mongoLegacyApp = reference;
      lab.mongoLegacyContext = ctx;
    }
  };
  lab.rows = async (tenant = A) =>
    (await admin.query(`SELECT doc FROM "${name}".entries WHERE tenant_id = $1 ORDER BY "_id", id_kind`, [tenant])).rows.map(row => row.doc);
  lab.grants = async (permissions, tenant = A) =>
    admin.query(`UPDATE "${auth}".tenant_authorization_roles SET permissions = $1 WHERE tenant_id = $2 AND name = 'writer'`,
      [permissions, tenant]);
  lab.displayName = async value => admin.query(`UPDATE "${auth}".tenant_authorization_subjects
    SET display_name = $1 WHERE tenant_id = $2 AND subject_id = $3`, [value, A, SUBJECT]);
  lab.http = (method, path, { worker = 0, tenant = A, credential = lab.credentials[0] } = {}) => {
    let call = request(workers[worker].server)[method]('/api/v3' + path)
      .set('Host', tenant === A ? 'one.example.test' : 'two.example.test')
      .timeout({ response: 5000, deadline: 15000 });
    if (credential !== null) call = call.set('api-secret', credential);
    return call;
  };
  lab.reference = (method, path) => request(lab.mongoApp)[method](path);
  lab.legacyHttp = (method, path, { worker = 0, tenant = A, credential = lab.credentials[0] } = {}) => {
    let call = request(workers[worker].server)[method](path)
      .set('Host', tenant === A ? 'one.example.test' : 'two.example.test')
      .set('Accept', 'application/json').timeout({ response: 5000, deadline: 15000 });
    if (credential !== null) call = call.set('api-secret', credential);
    return call;
  };
  lab.legacyReference = (method, path) => request(lab.mongoLegacyApp)[method](path).set('Accept', 'application/json');
  lab.seed = async docs => {
    await admin.query(`DELETE FROM "${name}".entries`);
    await lab.mongoCollection.deleteMany({});
    for (const tenant of [A, B]) for (const doc of docs) {
      const row = encodeDocument({ ...doc, ...(tenant === B ? { sgv: 902 } : {}) });
      await admin.query(`INSERT INTO "${name}".entries (tenant_id, id_kind, doc) VALUES ($1, $2, $3)`,
        [tenant, row.id_kind, row.doc]);
    }
    if (docs.length) await lab.mongoCollection.insertMany(docs.map(doc => ({ ...doc })));
    await lab.grants(GRANTS);
    await lab.displayName('Current Exact Name');
    lab.mongoGrants = GRANTS;
    lab.mongoName = 'Current Exact Name';
    lab.mongoEvents.length = 0;
    lab.mongoCol.autoPruneDays = undefined;
    for (const worker of workers) {
      if (legacy) for (const graph of worker.legacy.values()) graph.context.cache.invalidate('entries');
      worker.events.length = 0;
      worker.visible.length = 0;
      for (const col of worker.collections.values()) {
        col.autoPruneDays = undefined;
        col.nextAutoPrune = new Date(0);
      }
      if (legacy) lab.mongoLegacyContext.cache.invalidate('entries');
    }
  };
  lab.close = async () => {
    try {
      for (const worker of workers.reverse()) {
        if (worker.server) await new Promise(resolve => worker.server.close(resolve));
        if (worker.connection) await worker.connection.end();
        if (worker.authority) await worker.authority.close();
      }
      if (mongo) {
        await mongo.db().collection(name).drop();
        await mongo.close();
      }
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
        await admin.query(`DROP SCHEMA IF EXISTS "${auth}" CASCADE`);
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
        await admin.end();
      }
    } finally { if (mode !== undefined) scope.setTenancyMode(mode); }
  };
  return lab;
};
