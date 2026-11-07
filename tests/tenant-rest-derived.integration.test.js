'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const { mock } = require('node:test');
const express = require('express');
const request = require('supertest');
const shiro = require('shiro-trie');
const { Client } = require('pg');
const { MongoClient } = require('mongodb');
const scope = require('../lib/storage/tenant-scope');
const { run } = require('../lib/migrations/postgres');
const connect = require('../lib/storage/postgres-connection');
const catalogue = require('../lib/server/tenant-app/domain-catalogue');
const postgresDomains = require('../lib/server/serve/postgres-domains');
const environment = require('../lib/server/tenant-app/environment');
const previewDomains = require('../lib/server/serve/preview-domains');
const dataAccess = require('../lib/server/tenant-app/data-access');
const { createTenantApp } = require('../lib/server/tenant-app');
const authorityFor = require('../lib/tenant-authorization/postgres');
const { createSecrets } = require('../lib/secrets/component');
const provider = require('./fixtures/tenant-credential-provider');
const { encodeDocument } = require('../lib/storage/postgres-identity');
const { optInSuite } = require('./support/opt-in');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SUBJECT = '000000000000000000000001';
const NOW = 1793664000123;
const hash = x => crypto.createHash('sha1').update(x).digest('hex');
const random = () => crypto.randomBytes(10).toString('hex');
const settings = { enable: ['bgnow', 'direction', 'upbat', 'iob', 'cob', 'bwp', 'basal', 'cage', 'sage'] };
const language = require('../lib/language')();

function comparable (value) {
  if (Array.isArray(value)) return value.map(comparable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'dbstats')
    .map(([key, item]) => [key, comparable(item)]));
}

optInSuite(process.env.NS_REST_DERIVED_HTTP_TEST === '1' &&
  !!process.env.NS_TEST_POSTGRES_ADMIN_URI && !!process.env.CUSTOMCONNSTR_mongo,
'NS_REST_DERIVED_HTTP_TEST=1 with disposable PostgreSQL and MongoDB')(
  'tenant derived reads through actual preview HTTP and shipping Mongo handlers', function () {
    this.timeout(60000);
    const name = 'derived_test_' + random();
    const namespaces = Object.fromEntries(catalogue.names.map(n => [n, name + '_' + n]));
    namespaces.authorization = name + '_auth';
    const role = name + '_app';
    const roots = [random(), random()], providers = [provider(), provider()], records = new Map();
    const credentials = roots.map(root => 'synthetic-' + hash(hash(root) + SUBJECT).slice(0, 16));
    const stores = {}, workers = [];
    let admin, mongo, mode, uri, reference, oracleGrants = ['api:*:read'];

    function documents (logical, tenant = A) {
      const n = tenant === A ? 1 : 2;
      if (logical === 'entries') return [0, 300000, 7200000].map((age, i) => ({
        _id: '00000000000000000000010' + i, type: 'sgv', date: NOW - age,
        dateString: new Date(NOW - age).toISOString(), sgv: 100 * n + i, direction: 'Flat' }));
      if (logical === 'treatments') return [{ _id: '000000000000000000000201', eventType: 'Meal Bolus',
        created_at: new Date(NOW - 600000).toISOString(), carbs: 20 * n, insulin: n },
      { _id: '000000000000000000000202', eventType: 'Sensor Start', created_at: new Date(NOW - 86400000).toISOString() }];
      if (logical === 'devicestatus') return [{ _id: '000000000000000000000301',
        created_at: new Date(NOW - 60000).toISOString(), uploader: { battery: 30 * n } }];
      if (logical === 'profile') return [{ _id: '000000000000000000000401', defaultProfile: 'Default',
        startDate: new Date(NOW - 86400000).toISOString(), created_at: new Date(NOW - 86400000).toISOString(),
        mills: NOW - 86400000, store: { Default: { dia: 3, carbratio: [{ time: '00:00', value: 10 }],
          carbs_hr: 20, delay: 20, sens: [{ time: '00:00', value: 50 }],
          basal: [{ time: '00:00', value: n }], target_low: [{ time: '00:00', value: 90 }],
          target_high: [{ time: '00:00', value: 110 }], timezone: 'UTC', units: 'mg/dl' } } }];
      if (logical === 'food') return [{ _id: '000000000000000000000501', name: 'Synthetic ' + n, type: 'food', carbs: n }];
      return [];
    }
    async function grants (permissions) {
      await admin.query(`UPDATE ${namespaces.authorization}.tenant_authorization_roles SET permissions=$1 WHERE tenant_id=$2`,
        [permissions, A]);
      oracleGrants = permissions;
    }
    const http = (path, { tenant = A, worker = workers[0], method = 'get', credential = credentials[tenant === A ? 0 : 1] } = {}) => {
      let call = request(worker.server)[method](path).set('Host', tenant === A ? 'one.example.test' : 'two.example.test');
      if (credential !== null) call = call.set('api-secret', credential);
      return call;
    };
    async function makeWorker () {
      const worker = {};
      workers.push(worker);
      worker.connection = await connect({ connectionString: uri, max: 2 });
      worker.authority = await authorityFor({ connectionString: uri, namespace: namespaces.authorization });
      worker.secrets = createSecrets({ providerFor: async tenant => providers[tenant === A ? 0 : 1],
        store: { async get (tenant, id) { return records.get(tenant + ':' + id); },
          async insert (record) { records.set(record.tenant + ':' + record.id, record); } },
        maxTokenLifetimeSeconds: 28800, audit: async () => {}, authorize: async identity => identity.consumer === 'api',
        legacyAuthorityFor: async tenant => ({ reference: { tenant, id: 'synthetic-import' },
          subjects: [{ subjectId: SUBJECT, tokenPrefix: 'synthetic' }] }) });
      const config = { domains: [...catalogue.names], legacyEnabled: true, contextEnabled: false, namespaces,
        bindings: new Map([[A, {}], [B, {}]]),
        environments: new Map([[A, environment({ settings })], [B, environment({ settings })]]) };
      const domains = await previewDomains({ config, connection: worker.connection });
      const unused = async () => { throw new Error('unused management service'); };
      worker.server = createTenantApp({
        resolver: require('../lib/tenant-resolution')({ aliases: [
          { host: 'one.example.test', tenant: A }, { host: 'two.example.test', tenant: B }] }),
        verifyCredential: unused, authorizeRequest: unused,
        tenantSettings: { read: unused, replace: unused, rollback: unused }, subjectPolicy: { read: unused, replace: unused },
        dataAccess: dataAccess({ secrets: worker.secrets, authority: worker.authority,
          verifierContext: async tenant => ({ tenant, principal: 'verifier', consumer: 'api' }),
          collections: domains.v3Names, legacyCollections: domains.legacyNames, derivedReads: true }),
        dataRouter: domains.data, legacyRouter: domains.legacyRouter
      }).listen(0, '127.0.0.1');
      await once(worker.server, 'listening');
      return worker;
    }
    async function closeWorker (worker) {
      if (worker.server) await new Promise(resolve => worker.server.close(resolve));
      worker.server = null;
      if (worker.connection) await worker.connection.end();
      if (worker.authority) await worker.authority.close();
    }
    before(async function () {
      mode = scope.getTenancyMode(); scope.setTenancyMode('multi');
      for (const logical of catalogue.names) await run('up', { direct: true,
        connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI, namespace: namespaces[logical], catalogue: postgresDomains.get(logical).catalogue });
      await run('up', { direct: true, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI,
        namespace: namespaces.authorization, catalogue: require('../lib/tenant-authorization/postgres-candidate.json') });
      admin = new Client({ connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI }); await admin.connect();
      await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${random()}'`);
      const password = random(); await admin.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
      await admin.query(`GRANT USAGE ON SCHEMA ${Object.values(namespaces).join(',')} TO ${role}`);
      for (const logical of catalogue.names) await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${namespaces[logical]}.${logical} TO ${role}`);
      await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${namespaces.authorization} TO ${role}`);
      const url = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI); url.username = role; url.password = password; uri = url.toString();
      for (const tenant of [A, B]) {
        await admin.query(`INSERT INTO ${namespaces.authorization}.tenant_authorization_config VALUES ($1,ARRAY['denied'])`, [tenant]);
        await admin.query(`INSERT INTO ${namespaces.authorization}.tenant_authorization_subjects VALUES ($1,$2,'Synthetic Viewer')`, [tenant, SUBJECT]);
        await admin.query(`INSERT INTO ${namespaces.authorization}.tenant_authorization_roles VALUES ($1,'reader',ARRAY['api:*:read'])`, [tenant]);
        await admin.query(`INSERT INTO ${namespaces.authorization}.tenant_authorization_subject_roles VALUES ($1,$2,'reader')`, [tenant, SUBJECT]);
        for (const logical of catalogue.names) for (const doc of documents(logical, tenant)) {
          const row = encodeDocument(doc);
          await admin.query(`INSERT INTO ${namespaces[logical]}.${logical} (tenant_id,id_kind,doc) VALUES ($1,$2,$3)`,
            [tenant, row.id_kind, row.doc]);
        }
      }
      mongo = new MongoClient(process.env.CUSTOMCONNSTR_mongo); await mongo.connect();
      const env = environment({ settings });
      env.settings.filteredSettings = require('../lib/settings')().filteredSettings;
      const ctx = { store: { db: mongo.db(), collection: n => mongo.db().collection(n) }, bus: new EventEmitter(),
        settings: env.settings, language, levels: require('../lib/levels'), moment: require('moment-timezone'),
        ddata: require('../lib/data/ddata')(), wares: require('../lib/middleware')(env) };
      ctx.cache = require('../lib/server/cache')(env, ctx);
      for (const logical of catalogue.legacyNames) {
        env[logical + '_collection'] = name + '_' + logical;
        stores[logical] = mongo.db().collection(env[logical + '_collection']);
        const docs = documents(logical); if (docs.length) await stores[logical].insertMany(docs);
        ctx[logical] = logical === 'profile' ? require('../lib/server/profile')(env.profile_collection, ctx, env)
          : require('../lib/server/' + logical)(env, ctx);
      }
      ctx.authorization = { isPermitted: permission => (req, res, next) => {
        const trie = shiro.new(); trie.add(oracleGrants);
        return trie.check(permission) ? next() : res.status(401).json({ error: 'denied' });
      } };
      ctx.dataloader = require('../lib/data/dataloader')(env, ctx);
      const plugins = require('../lib/plugins')({ ...ctx, webhook: {} }).registerServerDefaults();
      reference = express();
      reference.use((req, res, next) => scope.withTenant(A, next));
      reference.use(async (req, res, next) => {
        try {
          ctx.ddata = require('../lib/data/ddata')();
          await new Promise((resolve, reject) => ctx.dataloader.update(ctx.ddata, { lastUpdated: Date.now(), frame: true },
            error => error ? reject(error) : resolve()));
          ctx.sbx = require('../lib/sandbox')().serverInit(env, ctx); plugins.setProperties(ctx.sbx); next();
        } catch (error) { next(error); }
      });
      reference.use('/api/v2/properties', require('../lib/api2/properties')(env, ctx));
      reference.use('/api/v2/ddata', require('../lib/data/endpoints')(env, ctx));
      reference.use('/api/v2/summary', require('../lib/api2/summary')(env, ctx));
      await makeWorker();
      for (const [i, tenant] of [A, B].entries()) await workers[0].secrets.encrypt(
        { tenant, principal: 'issuer', consumer: 'api' }, 'synthetic-import', Buffer.from(roots[i]));
    });
    beforeEach(async () => { await grants(['api:*:read']); });
    after(async function () {
      mock.timers.reset();
      for (const worker of workers) await closeWorker(worker);
      if (mongo) { for (const store of Object.values(stores)) await store.drop(); await mongo.close(); }
      if (admin) {
        for (const ns of Object.values(namespaces)) await admin.query(`DROP SCHEMA IF EXISTS ${ns} CASCADE`);
        await admin.query(`DROP ROLE IF EXISTS ${role}`); await admin.end();
      }
      scope.setTenancyMode(mode);
    });
    async function same (path, status = 200) {
      mock.timers.enable({ apis: ['Date'], now: NOW });
      try {
        const expected = await request(reference).get(path).expect(status);
        const actual = await http(path).expect(status);
        assert.deepEqual(comparable(actual.body), comparable(expected.body));
        assert.equal(actual.headers['content-type'], expected.headers['content-type']);
        return actual;
      } finally { mock.timers.reset(); }
    }

    it('matches real Mongo current, selected and pretty computed properties', async function () {
      const result = await same('/api/v2/properties');
      assert.equal(result.body.bgnow.last, 100);
      assert.ok(result.body.iob.iob > 0); assert.ok(result.body.cob.cob > 0);
      await same('/api/v2/properties/iob,cob,bgnow?pretty=1');
      await same('/api/v2/properties/missing/nested');
    });
    it('matches current and historical ddata with actual frame queries and inherited secondary data', async function () {
      await same('/api/v2/ddata/at');
      const result = await same('/api/v2/ddata/at/' + encodeURIComponent(new Date(NOW - 3600000).toISOString()));
      assert.deepEqual(result.body.sgvs.map(x => x.mgdl), [102]);
      assert.equal(result.body.food[0].name, 'Synthetic 1');
      await same('/api/v2/ddata/at/invalid', 400);
    });
    it('matches summary default and explicit hours, computed state, profile and treatments', async function () {
      const result = await same('/api/v2/summary/');
      assert.equal(result.body.profile.basal[0].value, 1);
      assert.ok(result.body.state.iob > 0); assert.ok(result.body.state.cob > 0);
      const short = await same('/api/v2/summary/?hours=1');
      assert.equal(short.body.sgvs.length, 2);
    });
    it('isolates overlapping identifiers and calculations across interleaved tenants and restart', async function () {
      mock.timers.enable({ apis: ['Date'], now: NOW });
      try {
        const responses = await Promise.all([A, B, A, B].map(tenant => http('/api/v2/properties/bgnow,iob', { tenant }).expect(200)));
        assert.deepEqual(responses.map(r => r.body.bgnow.last), [100, 200, 100, 200]);
        assert.ok(responses[1].body.iob.iob > responses[0].body.iob.iob);
        const restarted = await makeWorker();
        assert.equal((await http('/api/v2/summary', { tenant: B, worker: restarted }).expect(200)).body.profile.basal[0].value, 2);
      } finally { mock.timers.reset(); }
    });
    it('rechecks both shipping read permissions and wildcard summary authority on every request', async function () {
      await grants(['api:entries:read']);
      await http('/api/v2/properties').expect(401); await http('/api/v2/ddata/at').expect(401);
      await grants(['api:treatments:read']);
      await http('/api/v2/properties').expect(401); await http('/api/v2/ddata/at').expect(401);
      await grants(['api:entries:read', 'api:treatments:read']);
      await http('/api/v2/properties').expect(200); await http('/api/v2/summary').expect(401);
      await grants([]); await http('/api/v2/properties').expect(401);
      await http('/api/v2/properties', { credential: credentials[1] }).expect(401);
    });
    it('keeps v1 and mutations unadmitted and retains HEAD/OPTIONS', async function () {
      await http('/api/v1/properties').expect(405);
      await http('/api/v2/properties', { method: 'post' }).expect(405);
      for (const path of ['/api/v2/properties', '/api/v2/ddata/at', '/api/v2/summary']) {
        await http(path, { method: 'head' }).expect(200);
        const options = await http(path, { method: 'options' }).expect(200);
        assert.match(options.headers.allow, /GET/);
      }
    });
  });
