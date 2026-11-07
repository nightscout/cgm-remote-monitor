'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const { MongoClient, ObjectId } = require('mongodb');
const express = require('express');
const request = require('supertest');
const { run } = require('../lib/migrations/postgres');
const connect = require('../lib/storage/postgres-connection');
const scope = require('../lib/storage/tenant-scope');
const { encodeDocument } = require('../lib/storage/postgres-identity');
const createAuthority = require('../lib/tenant-authorization/postgres');
const { createSecrets } = require('../lib/secrets/component');
const { createVaultTransit } = require('../lib/secrets/vault-transit');
const { createPostgresSecrets } = require('../lib/secrets/postgres');
const createDataAccess = require('../lib/server/tenant-app/data-access');
const { createTenantApp } = require('../lib/server/tenant-app');
const createResolver = require('../lib/tenant-resolution');
const legacyAuthorization = require('../lib/server/tenant-app/legacy-authorization');
const Collection = require('../lib/api3/generic/collection');
const configureApi3 = require('../lib/api3');
const purifier = require('../lib/server/purifier');
const { optInSuite } = require('./support/opt-in');
const domains = ['devicestatus', 'activity'];
const factories = {
  devicestatus: require('../lib/server/tenant-app/devicestatus'),
  activity: require('../lib/server/tenant-app/activity')
};
const constructors = {
  devicestatus: require('../lib/server/devicestatus'),
  activity: require('../lib/server/activity')
};
const catalogues = {
  devicestatus: require('../migrations/candidates/postgres-devicestatus-v1.json'),
  activity: require('../migrations/candidates/postgres-activity-v1.json')
};
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SUBJECT = '000000000000000000000001';
const ID = '65a1b2c3d4e5f60718293a4b';
const time = require('./fixtures/legacy-rest-time').capture();
const BASE = time.base;
const CREATED = new Date(BASE).toISOString();
const GRANTS = domains.flatMap(domain => ['read', 'create', 'update', 'delete'].map(action => `api:${domain}:${action}`));
const EVENTS = ['storage-intent-committed', 'storage-socket-create', 'storage-socket-update',
  'storage-socket-delete', 'data-update', 'data-received'];
const hash = value => crypto.createHash('sha1').update(value).digest('hex');
const random = () => crypto.randomBytes(16).toString('hex');
const docker = args => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000
}).trim();
const json = value => JSON.parse(JSON.stringify(value));
function comparable (value) {
  if (Array.isArray(value)) return value.map(comparable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['srvCreated', 'srvModified', 'lastModified'].includes(key))
    .map(([key, child]) => [key, comparable(child)]));
}

optInSuite(process.env.NS_REST_DEVICE_ACTIVITY_TEST === '1' &&
  !!process.env.NS_TEST_POSTGRES_ADMIN_URI && !!process.env.CUSTOMCONNSTR_mongo,
'NS_REST_DEVICE_ACTIVITY_TEST=1 with disposable PostgreSQL/MongoDB and Docker Vault')(
  'tenant device/activity actual shipping HTTP differential', function () {
    this.timeout(60000);
    const name = 'device_' + random();
    const auth = name + '_auth';
    const secretNamespace = name + '_secrets';
    const role = name + '_app';
    const schemas = Object.fromEntries(domains.map(domain => [domain, name + '_' + domain]));
    const tables = Object.fromEntries(domains.map(domain => [domain, schemas[domain] + '.' + domain]));
    const roots = [random(), random()];
    const credentials = roots.map(root => 'synthetic-' + hash(hash(root) + SUBJECT).slice(0, 16));
    const providers = [];
    const contexts = new Map();
    const mongoEvents = [], pgEvents = [];
    const vaultName = 'ns-rest-device-vault-' + random();
    const vaultRoot = random();
    let vaultOwned = false, vaultAddress, admin, mongo, connection, authority, server, oracle, mode, appURI, secrets, persistence;
    let mongoContext, mongoCollections;

    async function vault (resource, body) {
      const response = await fetch(vaultAddress + '/v1/' + resource, {
        method: 'POST', headers: { 'X-Vault-Token': vaultRoot, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(3000)
      });
      assert.equal(response.ok, true, 'operator Vault preparation HTTP ' + response.status);
      return response.status === 204 ? undefined : response.json();
    }

    function bus (events, tenant) {
      const value = new EventEmitter();
      for (const event of EVENTS) value.on(event, body => events.push({ tenant, event, body }));
      return value;
    }

    function legacy (ctx, env) {
      if (!env.enclave) {
        env.enclave = require('../lib/server/enclave')();
        env.enclave.setApiKey(random());
      }
      env.settings.enable = ['api', 'careportal'];
      ctx.wares = require('../lib/middleware')(env);
      return require('../lib/api')(env, ctx, { domains });
    }

    function context (events, tenant) {
      return {
        bus: bus(events, tenant), purifier: purifier({}, {}), ddata: require('../lib/data/ddata')(),
        cache: { devicestatus: [] },
        authorization: legacyAuthorization()
      };
    }

    async function start ({ max = 1 } = {}) {
      connection = await connect({ connectionString: appURI, max });
      authority = await createAuthority({ connectionString: appURI, namespace: auth });
      const data = express.Router();
      const legacyRouter = express.Router();
      data.use((req, res, next) => scope.withTenant(req.tenantContext.tenant, next));
      const access = createDataAccess({ secrets, authority, collections: ['devicestatus'], legacyCollections: domains,
        verifierContext: async tenant => ({ tenant, principal: 'verifier', consumer: 'api' }) });
      for (const tenant of [A, B]) {
        const ctx = context(pgEvents, tenant);
        contexts.set(tenant, ctx);
        const env = { settings: { deNormalizeDates: false }, predictionsMaxSize: 2 };
        ctx.deviceEnv = env;
        const ports = new Map();
        for (const logical of domains) {
          ports.set(logical, factories[logical]({ connection, table: tables[logical], env, bus: ctx.bus, source: 'v1/internal' }));
        }
        ctx.storagePorts = { resolve: ({ logical, source }) => source === 'v1/internal' ? ports.get(logical) : undefined };
        for (const domain of domains) ctx[domain] = constructors[domain](env, ctx);
        const legacyApp = legacy(ctx, env);
        legacyRouter.use((req, res, next) => scope.requireTenant('domain HTTP fixture') === tenant
          ? legacyApp(req, res, next) : next());
        const v3 = express();
        require('../lib/middleware/configure-request')(v3);
        v3.use(require('../lib/api3/shared/renderer').extension2accept);
        v3.setENVTruthy = () => undefined;
        const defaults = require('../lib/api3/const.json');
        for (const key of ['API3_SECURITY_ENABLE', 'API3_DEDUP_FALLBACK_ENABLED', 'API3_CREATED_AT_FALLBACK_ENABLED', 'API3_MAX_LIMIT']) {
          v3.set(key, defaults[key]);
        }
        const options = factories.devicestatus({ connection, table: tables.devicestatus, env, bus: ctx.bus });
        const col = new Collection({ ctx, env, app: v3, colName: 'devicestatus',
          fallbackGetDate: doc => new Date(doc.created_at), fallbackDateField: 'created_at',
          dedupFallbackFields: ['created_at', 'device'], ...options });
        col.mapRoutes();
        ctx.deviceCol = col;
        data.use((req, res, next) => req.tenantContext.tenant === tenant ? v3(req, res, next) : next());
      }
      const unused = async () => { throw new Error('Owner capability outside domain fixture'); };
      const app = createTenantApp({
        resolver: createResolver({ aliases: [
          { host: 'one.example.test', tenant: A }, { host: 'two.example.test', tenant: B }
        ] }),
        dataAccess: access, dataRouter: data, legacyRouter,
        verifyCredential: unused, authorizeRequest: unused,
        tenantSettings: { read: unused, replace: unused, rollback: unused },
        subjectPolicy: { read: unused, replace: unused }
      });
      server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      assert.equal(server.address().address, '127.0.0.1');
    }

    async function stop () {
      if (server) { await new Promise(resolve => server.close(resolve)); server = undefined; }
      if (authority) { await authority.close(); authority = undefined; }
      if (connection) { await connection.end(); connection = undefined; }
    }

    function http (method, path, { tenant = A, credential = credentials[0] } = {}) {
      let call = request(server)[method](path).set('Host', tenant === A ? 'one.example.test' : 'two.example.test')
        .set('Accept', 'application/json').timeout({ response: 5000, deadline: 15000 });
      if (credential !== null) call = call.set('api-secret', credential);
      return call;
    }
    function reference (method, path) {
      const call = request(oracle)[method](path).set('Accept', 'application/json');
      return path.startsWith('/api/v3/')
        ? call.set('Authorization', 'Bearer ' + mongoContext.deviceEnv.enclave.signJWT({ accessToken: credentials[0] }))
        : call.set('api-secret', credentials[0]);
    }
    async function rows (domain, tenant = A) {
      return (await admin.query(`SELECT doc FROM "${schemas[domain]}".${domain}
        WHERE tenant_id=$1 ORDER BY "_id", id_kind`, [tenant])).rows.map(row => row.doc);
    }
    async function grants (permissions) {
      await admin.query(`UPDATE "${auth}".tenant_authorization_roles SET permissions=$1 WHERE tenant_id=$2`, [permissions, A]);
      if (mongo) await mongo.db().collection(name + '_oracle_roles').updateOne({ name: 'writer' }, { $set: { permissions } });
    }
    async function seed (domain, docs) {
      await admin.query(`DELETE FROM "${schemas[domain]}".${domain}`);
      await mongoCollections[domain].deleteMany({});
      for (const tenant of [A, B]) for (const doc of docs) {
        const row = encodeDocument({ ...doc, ...(tenant === B ? { tenantMarker: 'two' } : {}) });
        await admin.query(`INSERT INTO "${schemas[domain]}".${domain} (tenant_id,id_kind,doc) VALUES ($1,$2,$3)`,
          [tenant, row.id_kind, row.doc]);
      }
      if (docs.length) await mongoCollections[domain].insertMany(docs.map(doc => ({ ...doc })));
    }
    async function same (method, path, body, status = 200, headers = {}) {
      let expected = reference(method, path).set(headers), actual = http(method, path).set(headers);
      if (body !== undefined) { expected = expected.send(json(body)); actual = actual.send(json(body)); }
      const mongoReply = await expected.expect(status);
      const pgReply = await actual;
      assert.equal(pgReply.status, status, JSON.stringify(pgReply.body));
      assert.deepEqual(comparable(pgReply.body), comparable(mongoReply.body));
      for (const header of ['location', 'content-type', 'deprecation', 'warning', 'allow']) {
        assert.equal(pgReply.headers[header], mongoReply.headers[header], header);
      }
      if (['post', 'put', 'patch', 'delete'].includes(method) && status < 400) {
        const domain = path.includes('/devicestatus') ? 'devicestatus' : 'activity';
        const expectedRows = await mongoCollections[domain].find({}).sort({ _id: 1 }).toArray();
        assert.deepEqual(comparable(await rows(domain)), comparable(json(expectedRows)));
      }
      return pgReply;
    }

    before(async function () {
      mode = scope.getTenancyMode();
      scope.setTenancyMode('multi');
      admin = new Client({ connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI });
      await admin.connect();
      for (const domain of domains) {
        await run('up', { direct: true, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI,
          namespace: schemas[domain], catalogue: catalogues[domain] });
      }
      await run('up', { direct: true, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI,
        namespace: auth, catalogue: require('../lib/tenant-authorization/postgres-candidate.json') });
      await run('up', { direct: true, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI,
        namespace: secretNamespace, catalogue: require('../lib/secrets/postgres-candidate.json') });
      const password = random();
      await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      for (const domain of domains) {
        await admin.query(`GRANT USAGE ON SCHEMA "${schemas[domain]}" TO "${role}"`);
        await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${schemas[domain]}".${domain} TO "${role}"`);
      }
      await admin.query(`GRANT USAGE ON SCHEMA "${auth}" TO "${role}"`);
      await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${auth}" TO "${role}"`);
      await admin.query(`GRANT USAGE ON SCHEMA "${secretNamespace}" TO "${role}"`);
      await admin.query(`GRANT SELECT, INSERT ON "${secretNamespace}".secret_records TO "${role}"`);
      await admin.query(`GRANT INSERT ON "${secretNamespace}".secret_audit TO "${role}"`);
      const uri = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI);
      uri.username = role; uri.password = password; appURI = uri.toString();
      for (const tenant of [A, B]) {
        await admin.query(`INSERT INTO "${auth}".tenant_authorization_config VALUES ($1, ARRAY['denied'])`, [tenant]);
        await admin.query(`INSERT INTO "${auth}".tenant_authorization_subjects
          (tenant_id,subject_id,display_name) VALUES ($1,$2,'Current Exact Name')`, [tenant, SUBJECT]);
        await admin.query(`INSERT INTO "${auth}".tenant_authorization_roles VALUES ($1,'writer',$2)`, [tenant, GRANTS]);
        await admin.query(`INSERT INTO "${auth}".tenant_authorization_subject_roles VALUES ($1,$2,'writer')`, [tenant, SUBJECT]);
      }
      execFileSync('docker', ['run', '--name', vaultName, '-d', '-p', '127.0.0.1::8200',
        '-e', 'VAULT_DEV_ROOT_TOKEN_ID', 'hashicorp/vault:latest', 'server', '-dev', '-dev-listen-address=0.0.0.0:8200'],
      { env: { ...process.env, VAULT_DEV_ROOT_TOKEN_ID: vaultRoot }, stdio: 'pipe', timeout: 30000 });
      vaultOwned = true;
      vaultAddress = 'http://127.0.0.1:' + docker(['port', vaultName, '8200/tcp']).split(':').pop();
      const deadline = Date.now() + 20000;
      for (;;) {
        try {
          const response = await fetch(vaultAddress + '/v1/sys/health', { signal: AbortSignal.timeout(1000) });
          await response.body.cancel();
          if (response.ok) break;
        } catch { /* Wait for this owned provider only. */ }
        if (Date.now() > deadline) throw new Error('Owned Vault did not become ready');
        await delay(100);
      }
      await vault('sys/mounts/transit', { type: 'transit' });
      for (let i = 0; i < 2; i++) {
        for (const kind of ['data', 'signing']) await vault(`transit/keys/tenant-${i}-${kind}`, { type: 'aes256-gcm96' });
        const policy = ['encrypt', 'decrypt'].map(operation =>
          `path "transit/${operation}/tenant-${i}-data" { capabilities = ["update"] }`).concat(
          ['hmac', 'verify'].map(operation =>
            `path "transit/${operation}/tenant-${i}-signing" { capabilities = ["update"] }`)).join('\n');
        await vault(`sys/policies/acl/tenant-${i}`, { policy });
        const token = (await vault('auth/token/create', {
          policies: [`tenant-${i}`], no_default_policy: true, ttl: '15m', renewable: false
        })).auth.client_token;
        providers.push(createVaultTransit({ address: vaultAddress, mount: 'transit',
          encryptionKey: `tenant-${i}-data`, signingKey: `tenant-${i}-signing`, signingVersion: 1,
          getToken: async () => token, allowInsecureLoopback: true }));
      }
      persistence = await createPostgresSecrets({ connectionString: appURI, namespace: secretNamespace });
      secrets = createSecrets({ providerFor: async tenant => providers[tenant === A ? 0 : 1],
        store: persistence.store,
        authorize: async identity => identity.consumer === 'api', audit: persistence.audit, maxTokenLifetimeSeconds: 28800,
        legacyAuthorityFor: async tenant => ({ reference: { tenant, id: 'synthetic-import' },
          subjects: [{ subjectId: SUBJECT, tokenPrefix: 'synthetic' }] }) });
      for (const [i, tenant] of [A, B].entries()) await secrets.encrypt(
        { tenant, principal: 'issuer', consumer: 'api' }, 'synthetic-import', Buffer.from(roots[i]));
      mongo = new MongoClient(process.env.CUSTOMCONNSTR_mongo);
      await mongo.connect();
      mongoCollections = Object.fromEntries(domains.map(domain => [domain, mongo.db().collection(name + '_' + domain)]));
      const indexes = await require('../lib/storage/identifier-index').ensure(
        domains.map(domain => ({ name: domain, collection: mongoCollections[domain] })), 'require');
      assert.equal(indexes.ready, true);
      const env = { settings: { deNormalizeDates: false, authDefaultRoles: 'denied', authFailDelay: 0 }, predictionsMaxSize: 2,
        authentication_collections_prefix: name + '_oracle_', enclave: require('../lib/server/enclave')() };
      env.enclave.setApiKey(roots[0]);
      env.enclave.setJWTKey(random());
      for (const domain of domains) env[domain + '_collection'] = name + '_' + domain;
      mongoContext = context(mongoEvents, A);
      mongoContext.deviceEnv = env;
      mongoContext.store = { db: mongo.db(), collection: n => mongo.db().collection(n), ensureIndexes () {} };
      mongoContext.language = { translate: value => value };
      mongoContext.moment = require('moment');
      mongoContext.settings = env.settings;
      await mongo.db().collection(name + '_oracle_roles').insertOne({ name: 'writer', permissions: GRANTS });
      await mongo.db().collection(name + '_oracle_subjects').insertOne({
        _id: new ObjectId(SUBJECT), name: 'Current Exact Name', roles: ['writer']
      });
      mongoContext.authorization = require('../lib/authorization')(env, mongoContext);
      for (const domain of domains) mongoContext[domain] = constructors[domain](env, mongoContext);
      oracle = express();
      oracle.use((req, res, next) => scope.withTenant(A, () => {
        mongoContext.authorization.storage.reload(error => {
          if (error) return next(error);
          next();
        });
      }));
      const mongoLegacy = legacy(mongoContext, env);
      oracle.use('/api/v1', mongoLegacy);
      oracle.use('/api/v2', require('../lib/api2')(env, mongoContext, mongoLegacy, { compatibilityOnly: true }));
      oracle.use('/api/v3', configureApi3({ ...env,
        api3: { API3_SECURITY_ENABLE: true, API3_DEDUP_FALLBACK_ENABLED: true } }, mongoContext));
      await start();
      await http('get', '/api/v3/devicestatus/not-present').expect(404);
    });

    beforeEach(async function () {
      for (const domain of domains) await seed(domain, []);
      await grants(GRANTS);
      await admin.query(`UPDATE "${auth}".tenant_authorization_subjects SET display_name='Current Exact Name'`);
      await mongo.db().collection(name + '_oracle_subjects').updateOne({ _id: new ObjectId(SUBJECT) },
        { $set: { name: 'Current Exact Name' } });
      for (const ctx of contexts.values()) {
        ctx.cache.devicestatus = [];
        ctx.deviceEnv.settings.deNormalizeDates = false;
      }
      mongoContext.cache.devicestatus = [];
      mongoContext.deviceEnv.settings.deNormalizeDates = false;
      mongoEvents.length = 0; pgEvents.length = 0;
    });

    after(async function () {
      try {
        await stop();
        if (persistence) await persistence.close();
        if (mongo) {
          for (const collection of Object.values(mongoCollections || {})) await collection.drop();
          for (const kind of ['roles', 'subjects']) await mongo.db().collection(name + '_oracle_' + kind).drop();
          await mongo.close();
        }
        if (admin) {
          for (const namespace of [...Object.values(schemas), auth, secretNamespace]) await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
          await admin.query(`DROP ROLE IF EXISTS "${role}"`);
          await admin.end();
        }
      } finally {
        if (vaultOwned) docker(['rm', '-f', '-v', vaultName]);
        if (mode !== undefined) scope.setTenancyMode(mode);
      }
    });

    it('preserves legacy device normalization, predictions, extensions, numeric filtering, order and v2 inheritance', async function () {
      for (const version of [1, 2]) {
        await seed('devicestatus', []);
        await same('post', `/api/v${version}/devicestatus`, [
          { _id: ID, identifier: 'device-retry', created_at: time.day() + 'T02:00:00+02:00', device: '12345',
            date: BASE, sgv: 123, extension: { future: [null, true] },
            openaps: { suggested: { predBGs: { IOB: [1, 2, 3], FUTURE: [4, 5, 6] } } } },
          { _id: '75a1b2c3d4e5f60718293a4b', created_at: time.day(1) + 'T00:00:00Z', device: 'newer', date: BASE + 1, sgv: 150 }
        ]);
        const stored = await rows('devicestatus');
        assert.equal(stored.length, 2);
        assert.equal(stored[0].created_at, time.day() + 'T00:00:00.000Z');
        assert.equal(stored[0].utcOffset, 120);
        assert.deepEqual(stored[0].openaps.suggested.predBGs, { IOB: [1, 2], FUTURE: [4, 5, 6] });
        assert.deepEqual(stored[0].extension, { future: [null, true] });
        for (const suffix of ['', '.json', '?count=0', '?count=1', '?count=1?deprecated',
          '?count=0&find[created_at][$gte]=' + time.day(-1) + '&find[created_at][$lte]=' + time.day(2), '?count=100&find[sgv][$gte]=130',
          '?find[device]=12345', '?find[date][$gte]=' + BASE]) {
          await same('get', `/api/v${version}/devicestatus${suffix}`);
        }
        await same('delete', `/api/v${version}/devicestatus/${ID}`);
        assert.equal((await rows('devicestatus')).length, 1);
        await same('post', `/api/v${version}/devicestatus?results=items`, [
          { _id: 'invalid', device: 'refused' },
          { _id: '85a1b2c3d4e5f60718293a4b', created_at: CREATED, device: 'accepted' }
        ]);
        await same('post', `/api/v${version}/devicestatus`, ['invalid'], 400);
        for (const method of ['put', 'patch']) {
          await reference(method, `/api/v${version}/devicestatus/${ID}`).send({}).expect(404);
          await http(method, `/api/v${version}/devicestatus/${ID}`).send({}).expect(405);
        }
      }
    });

    it('uses tenant-local actual runtime cache ordering and date denormalization without sharing arrays', async function () {
      const docs = [
        { _id: new ObjectId(ID), created_at: time.day() + 'T00:00:00.000Z', utcOffset: 120, device: 'earlier' },
        { _id: new ObjectId('75a1b2c3d4e5f60718293a4b'), created_at: CREATED, utcOffset: 0, device: 'later' }
      ];
      for (const ctx of [contexts.get(A), mongoContext]) ctx.cache.devicestatus = ctx.ddata.processRawDataForRuntime(docs);
      const foreign = contexts.get(B).ddata.processRawDataForRuntime([{ ...docs[0], device: 'foreign' }]);
      contexts.get(B).cache.devicestatus = foreign;
      const reply = await same('get', '/api/v1/devicestatus?count=1');
      assert.equal(reply.body[0].device, 'later');
      for (const ctx of [contexts.get(A), mongoContext]) ctx.deviceEnv.settings.deNormalizeDates = true;
      const denormalized = await same('get', '/api/v2/devicestatus?count=2');
      assert.equal(denormalized.body[1].created_at, time.day() + 'T02:00:00.000+02:00');
      assert.equal(denormalized.body[1].utcOffset, undefined);
      assert.equal((await http('get', '/api/v2/devicestatus?count=1', { tenant: B, credential: credentials[1] }).expect(200)).body[0].device, 'foreign');
      assert.equal(foreign.length, 1);
    });

    it('retains distinct default counts, bounded-window compatibility, literal filters, HEAD and OPTIONS', async function () {
      const docs = Array.from({ length: 12 }, (_, i) => ({
        _id: new ObjectId((BigInt('0x' + ID) + BigInt(i)).toString(16)),
        created_at: new Date(BASE + i * 3600000).toISOString(), date: BASE + i, device: 'rig-' + i
      }));
      for (const domain of domains) {
        await seed(domain, docs);
        for (const version of [1, 2]) {
          const path = `/api/v${version}/${domain}`;
          assert.equal((await same('get', path)).body.length, domain === 'devicestatus' ? 10 : 12);
          await same('get', path + '?count=0');
          assert.equal((await same('get', path + '?count=3')).body.length, 3);
          const all = await same('get', path +
            '?count=0&find[created_at][$gte]=' + time.day(-1) + '&find[created_at][$lte]=' + time.day(2));
          assert.equal(all.body.length, 12);
          assert.equal((await same('get', path + '?find[device][$regex]=%5Erig-&count=3')).body.length, 3);
          await same('head', path);
          await same('options', path);
        }
      }
    });

    it('uses shipping creation-time defaults and invalid-date handling rather than imposing entries normalization', async function () {
      for (const domain of domains) for (const version of [1, 2]) for (const invalid of [false, true]) {
        await seed(domain, []);
        const doc = { _id: ID, device: 'rig', extension: { future: true } };
        if (invalid) doc.created_at = 'synthetic-invalid-date';
        const before = Date.now();
        const expected = await reference('post', `/api/v${version}/${domain}`).send(doc).expect(200);
        const actual = await http('post', `/api/v${version}/${domain}`).send(doc).expect(200);
        const expectedDoc = expected.body[0], actualDoc = actual.body[0];
        if (domain === 'activity' && invalid) {
          assert.equal(actualDoc.created_at, doc.created_at);
          assert.equal(expectedDoc.created_at, doc.created_at);
        } else {
          for (const result of [actualDoc, expectedDoc]) {
            assert.ok(Date.parse(result.created_at) >= before && Date.parse(result.created_at) <= Date.now());
          }
        }
        assert.deepEqual(comparable({ ...actualDoc, created_at: undefined }),
          comparable({ ...expectedDoc, created_at: undefined }));
        const stored = (await rows(domain))[0];
        assert.equal(stored.created_at, actualDoc.created_at);
        assert.deepEqual(stored.extension, { future: true });
      }
    });

    it('preserves activity CRUD, source-specific dates, Last-Modified, numeric coercion and item batch outcomes', async function () {
      for (const version of [1, 2]) {
        await seed('activity', []);
        await same('post', `/api/v${version}/activity`, { _id: ID, identifier: 'activity-retry',
          created_at: CREATED, date: BASE, sgv: 123, steps: 10, future: { retained: [null, 1] } });
        assert.equal((await rows('activity'))[0].srvModified, undefined);
        await same('get', `/api/v${version}/activity?find[date][$gte]=${BASE}&find[sgv][$gte]=120`);
        const conditional = await same('get', `/api/v${version}/activity`, undefined, 200);
        assert.equal(conditional.headers['last-modified'], new Date(CREATED).toUTCString());
        await same('get', `/api/v${version}/activity`, undefined, 304, { 'If-Modified-Since': new Date(BASE + 1000).toUTCString() });
        await same('put', `/api/v${version}/activity`, { _id: ID, created_at: CREATED, steps: 30, future: ['replaced'] });
        const stored = (await rows('activity'))[0];
        assert.equal(stored.steps, 30);
        assert.equal(stored.srvCreated, undefined);
        assert.deepEqual(stored.future, ['replaced']);
        await same('post', `/api/v${version}/activity?results=items`, [
          { _id: 'invalid', steps: 1 }, { _id: '85a1b2c3d4e5f60718293a4b', created_at: CREATED, steps: 20 }
        ]);
        await same('delete', `/api/v${version}/activity/${ID}`);
        assert.equal((await rows('activity')).length, 1);
      }
      await reference('get', '/api/v3/activity').expect(404);
      await http('get', '/api/v3/activity').expect(405);
    });

    it('resends by device identifier and API3 fallback use shipping replacement rather than inferred merge rules', async function () {
      const original = { _id: new ObjectId(ID), identifier: 'device-retry', device: 'rig', created_at: CREATED,
        date: BASE, utcOffset: 0, srvCreated: BASE, srvModified: BASE, extension: { retained: 1, removed: 2 } };
      await seed('devicestatus', [original]);
      await same('post', '/api/v1/devicestatus', { identifier: 'device-retry', device: 'rig',
        created_at: CREATED, extension: { removed: null, added: 3 } });
      let stored = (await rows('devicestatus'))[0];
      assert.deepEqual(stored.extension, { removed: null, added: 3 });
      await same('post', '/api/v3/devicestatus', { identifier: 'device-retry', device: 'rig',
        date: BASE, app: 'synthetic', extension: { another: true } });
      assert.equal((await rows('devicestatus')).length, 1);
      await seed('devicestatus', [{ _id: new ObjectId(ID), device: 'rig', created_at: CREATED, date: BASE }]);
      await same('post', '/api/v3/devicestatus', { device: 'rig', created_at: CREATED, app: 'synthetic', utcOffset: 0 }, 400);
      assert.equal((await rows('devicestatus'))[0].identifier, undefined);
      await seed('devicestatus', [{ _id: new ObjectId(ID), device: 'rig', created_at: CREATED, date: BASE, utcOffset: 0 }]);
      await same('post', '/api/v3/devicestatus', { device: 'rig', created_at: CREATED, app: 'synthetic', utcOffset: 0 });
      stored = (await rows('devicestatus'))[0];
      assert.equal((await rows('devicestatus')).length, 1);
      assert.equal(stored._id, ID);
    });

    it('matches typed identity twins and permanently removes both forms through the legacy paths', async function () {
      for (const domain of domains) {
        await seed(domain, [{ _id: new ObjectId(ID), created_at: CREATED, steps: 10, device: 'object-id' },
          { _id: ID, created_at: time.day(1) + 'T00:00:00.000Z', steps: 20, device: 'string-id' }]);
        const reply = await same('get', `/api/v1/${domain}?find[_id]=${ID}&count=100`);
        assert.equal(reply.body.length, 2);
        const foreign = await rows(domain, B);
        await same('delete', `/api/v2/${domain}/${ID}`);
        assert.deepEqual(await rows(domain), []);
        assert.deepEqual(await rows(domain, B), foreign);
      }
    });

    it('preserves device resend collision outcomes under concurrent uploads and tenant-prefixed uniqueness', async function () {
      await stop(); await start({ max: 2 });
      try {
        for (const version of [1, 3]) {
          const path = `/api/v${version}/devicestatus`;
          const body = version === 1 ? { identifier: 'concurrent-device', created_at: CREATED, device: 'rig' }
            : { identifier: 'concurrent-device', date: BASE, utcOffset: 0, app: 'synthetic', device: 'rig' };
          const expected = await Promise.all([0, 1].map(() => reference('post', path).send(body)));
          assert.ok(expected.every(reply => [200, 201].includes(reply.status)));
          const expectedRows = await mongoCollections.devicestatus.find({}).toArray();
          assert.equal(expectedRows.length, 1);
          for (const tenant of [A, B]) {
            const replies = await Promise.all([0, 1].map(() => http('post', path,
              { tenant, credential: credentials[tenant === A ? 0 : 1] }).send(body)));
            assert.deepEqual(replies.map(reply => reply.status).sort(), expected.map(reply => reply.status).sort());
            const stored = await rows('devicestatus', tenant);
            assert.equal(stored.length, 1);
            assert.deepEqual(comparable({ ...stored[0], _id: undefined }),
              comparable({ ...json(expectedRows[0]), _id: undefined }));
          }
          await seed('devicestatus', []);
        }
      } finally { await stop(); await start(); }
    });

    it('API3 device addressed writes, search, tombstone history and permanent delete retain their own responses', async function () {
      await seed('devicestatus', [{ _id: new ObjectId(ID), identifier: 'device-record', device: 'rig',
        created_at: CREATED, date: BASE, utcOffset: 0, app: 'synthetic', srvCreated: BASE, srvModified: BASE }]);
      await same('get', '/api/v3/devicestatus/device-record');
      await same('get', '/api/v3/devicestatus?device$eq=rig&sort$desc=created_at&fields=identifier,device,created_at');
      await same('put', '/api/v3/devicestatus/device-record', { device: 'rig', date: BASE,
        utcOffset: 0, app: 'synthetic', future: { replaced: true } });
      await same('patch', '/api/v3/devicestatus/device-record', { future: { nested: [null, false] } });
      assert.deepEqual((await rows('devicestatus'))[0].future, { replaced: true, nested: [null, false] });
      await same('delete', '/api/v3/devicestatus/device-record');
      assert.equal((await rows('devicestatus'))[0].isValid, false);
      await same('get', '/api/v3/devicestatus/device-record', undefined, 410);
      const history = await same('get', '/api/v3/devicestatus/history/' + BASE);
      assert.equal(history.body.result.length, 1);
      await same('delete', '/api/v3/devicestatus/device-record?permanent=true');
      assert.deepEqual(await rows('devicestatus'), []);
      await same('get', '/api/v3/devicestatus/history/' + BASE);
    });

    it('maps only submitted nonrepresentability and recognized storage outages, retaining internal failures as 500', async function () {
      for (const version of [1, 2]) for (const domain of domains) {
        const doc = { _id: ID, created_at: CREATED, device: 'rig', extension: 'synthetic\u0000extension' };
        await reference('post', `/api/v${version}/${domain}`).send(doc).expect(200);
        await http('post', `/api/v${version}/${domain}`).send(doc).expect(400);
        assert.deepEqual(await rows(domain), []);
      }
      assert.deepEqual(pgEvents, []);
      const original = connection.query;
      try {
        for (const [failure, status] of [
          [Object.assign(new Error('synthetic outage'), { code: 'ECONNRESET' }), 503],
          [Object.assign(new TypeError('synthetic internal unsupported value'), { unsupported: true }), 500]
        ]) {
          connection.query = async () => { throw failure; };
          for (const version of [1, 2]) for (const domain of domains) {
            await http('get', `/api/v${version}/${domain}`).expect(status);
            await http('post', `/api/v${version}/${domain}`)
              .send({ _id: ID, created_at: CREATED, device: 'rig' }).expect(status);
            await http('delete', `/api/v${version}/${domain}/${ID}`).expect(status);
            if (domain === 'activity') await http('put', `/api/v${version}/activity`)
              .send({ _id: ID, created_at: CREATED, steps: 1 }).expect(status);
          }
          await http('get', '/api/v3/devicestatus').expect(status);
          await http('post', '/api/v3/devicestatus')
            .send({ created_at: CREATED, device: 'rig', app: 'synthetic' }).expect(status);
          await http('get', '/api/v3/devicestatus?device$eq=rig').expect(status);
          await http('get', '/api/v3/devicestatus/history/' + BASE).expect(status);
          for (const method of ['put', 'patch', 'delete']) {
            const call = http(method, '/api/v3/devicestatus/device-record');
            if (method !== 'delete') call.send({ created_at: CREATED, device: 'rig', app: 'synthetic' });
            await call.expect(status);
          }
        }
      } finally { connection.query = original; }
      for (const domain of domains) assert.deepEqual(await rows(domain), []);
      assert.deepEqual(pgEvents, []);
    });

    it('rolls legacy writes back before emitting events for either domain and isolates successful tenant events', async function () {
      for (const domain of domains) await seed(domain, [{ _id: new ObjectId(ID), created_at: CREATED,
        device: 'rig', identifier: domain + '-record' }]);
      const before = Object.fromEntries(await Promise.all(domains.map(async domain => [domain, await rows(domain)])));
      const foreign = Object.fromEntries(await Promise.all(domains.map(async domain => [domain, await rows(domain, B)])));
      const original = connection.transaction;
      connection.transaction = fn => original(async () => { await fn(); throw new Error('synthetic legacy rollback'); });
      try {
        for (const version of [1, 2]) for (const domain of domains) {
          await http('post', `/api/v${version}/${domain}`).send({
            _id: ID, identifier: domain + '-record', created_at: CREATED, extension: 'must-rollback'
          }).expect(500);
          await http('delete', `/api/v${version}/${domain}/${ID}`).expect(500);
          if (domain === 'activity') await http('put', `/api/v${version}/activity`)
            .send({ _id: ID, created_at: CREATED, steps: 99 }).expect(500);
          assert.deepEqual(await rows(domain), before[domain]);
          assert.deepEqual(await rows(domain, B), foreign[domain]);
        }
      } finally { connection.transaction = original; }
      assert.deepEqual(pgEvents, []);
      for (const domain of domains) {
        await http('delete', `/api/v2/${domain}/${ID}`).expect(200);
        assert.deepEqual(await rows(domain), []);
        assert.deepEqual(await rows(domain, B), foreign[domain]);
      }
      assert.ok(pgEvents.some(event => event.event === 'storage-intent-committed'));
      assert.ok(pgEvents.every(event => event.tenant === A));
    });

    it('consults persisted current grants and exact current name, rejects foreign/invalid credentials and never writes anonymously', async function () {
      await seed('devicestatus', [{ _id: new ObjectId(ID), identifier: 'device-record', created_at: CREATED,
        date: BASE, app: 'synthetic', utcOffset: 0, device: 'rig' }]);
      const foreign = await rows('devicestatus', B);
      await http('patch', '/api/v3/devicestatus/device-record', { tenant: B }).send({ extension: true }).expect(401);
      await http('post', '/api/v1/devicestatus', { credential: 'invalid' }).send({ device: 'rig' }).expect(401);
      await http('post', '/api/v2/activity', { credential: null }).send({ steps: 1 }).expect(401);
      await grants(['api:devicestatus:read']);
      await http('patch', '/api/v3/devicestatus/device-record').send({ extension: true }).expect(403);
      for (const version of [1, 2]) {
        await http('post', `/api/v${version}/devicestatus`).send({ device: 'rig' }).expect(401);
      }
      await grants(GRANTS);
      await admin.query(`UPDATE "${auth}".tenant_authorization_subjects SET display_name='Renamed Exact Name' WHERE tenant_id=$1`, [A]);
      await http('patch', '/api/v3/devicestatus/device-record').send({ extension: true }).expect(200);
      assert.equal((await rows('devicestatus'))[0].modifiedBy, 'Renamed Exact Name');
      await admin.query(`UPDATE "${auth}".tenant_authorization_subjects SET display_name=NULL WHERE tenant_id=$1`, [A]);
      await http('patch', '/api/v3/devicestatus/device-record').send({ extension: false }).expect(401);
      for (const version of [1, 2]) for (const domain of domains) {
        await http('post', `/api/v${version}/${domain}`).send({ device: 'rig' }).expect(401);
      }
      await http('patch', '/api/v3/devicestatus/device-record', { credential: hash(roots[0]) })
        .send({ rootOnly: true }).expect(200);
      assert.equal((await rows('devicestatus'))[0].rootOnly, true);
      assert.deepEqual(await rows('devicestatus', B), foreign);
      assert.ok(pgEvents.every(event => event.tenant === A));
    });

    it('keeps overlapping tenant IDs across pool/listener restart, enforces FORCE RLS and preserves rollback/event isolation', async function () {
      await seed('devicestatus', [{ _id: new ObjectId(ID), identifier: 'device-record', created_at: CREATED,
        date: BASE, app: 'synthetic', utcOffset: 0, device: 'rig' }]);
      await seed('activity', [{ _id: new ObjectId(ID), created_at: CREATED, steps: 10 }]);
      const before = await rows('devicestatus'), foreign = await rows('devicestatus', B);
      const activityBefore = await rows('activity'), activityForeign = await rows('activity', B);
      const unbound = new Client({ connectionString: appURI });
      await unbound.connect();
      try {
        for (const domain of domains) {
          const state = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid=$1::regclass`, [tables[domain]]);
          assert.deepEqual(state.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
          assert.equal((await unbound.query(`SELECT count(*)::int AS n FROM "${schemas[domain]}".${domain}`)).rows[0].n, 0);
          await connection.withTenant(A, async () => {
            assert.equal((await connection.query(`SELECT count(*)::int AS n FROM "${schemas[domain]}".${domain}`)).rows[0].n, 1);
          });
          await assert.rejects(connection.withTenant(A, () =>
            connection.query(`INSERT INTO "${schemas[domain]}".${domain} (tenant_id,id_kind,doc) VALUES ($1,'string',$2)`,
              [B, { _id: 'forbidden-tenant-write', created_at: CREATED }])), { code: '42501' });
        }
      } finally { await unbound.end(); }
      const original = connection.transaction;
      connection.transaction = fn => original(async () => { await fn(); throw new Error('synthetic post-write rollback'); });
      try { await http('patch', '/api/v3/devicestatus/device-record').send({ extension: 'must-rollback' }).expect(500); }
      finally { connection.transaction = original; }
      assert.deepEqual(await rows('devicestatus'), before);
      assert.deepEqual(pgEvents, []);
      await stop(); await start();
      await http('get', '/api/v3/devicestatus/device-record').expect(200);
      assert.equal((await http('get', '/api/v3/devicestatus/device-record',
        { tenant: B, credential: credentials[1] }).expect(200)).body.result.tenantMarker, 'two');
      assert.deepEqual(await rows('devicestatus', B), foreign);
      const foreignActivity = await http('get', '/api/v2/activity',
        { tenant: B, credential: credentials[1] }).expect(200);
      assert.equal(foreignActivity.body.length, 1, 'foreign activity default count after restart');
      assert.equal(foreignActivity.body[0].tenantMarker, 'two');
      assert.deepEqual(await rows('activity'), activityBefore);
      assert.deepEqual(await rows('activity', B), activityForeign);
      for (const domain of domains) assert.throws(() => contexts.get(A)[domain](), /no driver accessor/);
    });
  });
