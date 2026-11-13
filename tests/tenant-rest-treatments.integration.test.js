'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const { Client } = require('pg');
const { MongoClient, ObjectId } = require('mongodb');
const express = require('express');
const request = require('supertest');
const shiro = require('shiro-trie');
const { run } = require('../lib/migrations/postgres');
const connect = require('../lib/storage/postgres-connection');
const scope = require('../lib/storage/tenant-scope');
const { encodeDocument } = require('../lib/storage/postgres-identity');
const createAuthority = require('../lib/tenant-authorization/postgres');
const { createSecrets } = require('../lib/secrets/component');
const createDataAccess = require('../lib/server/tenant-app/data-access');
const { createTenantApp } = require('../lib/server/tenant-app');
const createResolver = require('../lib/tenant-resolution');
const Collection = require('../lib/api3/generic/collection');
const authentication = require('../lib/api3/tenant-authentication');
const treatmentsOptions = require('../lib/server/tenant-app/treatments');
const provider = require('./fixtures/tenant-credential-provider');
const defaults = require('../lib/api3/const.json');
const { optInSuite } = require('./support/opt-in');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SUBJECT = '000000000000000000000001';
const time = require('./fixtures/legacy-rest-time').capture();
const BASE = time.base;
const CREATED = time.iso();
const GRANTS = ['read', 'create', 'update', 'delete'].map(action => 'api:treatments:' + action);
const EVENTS = ['storage-intent-committed', 'storage-socket-create', 'storage-socket-update',
  'storage-socket-delete', 'data-update', 'data-received'];
const hash = value => crypto.createHash('sha1').update(value).digest('hex');
const treatment = extra => ({ _id: 'same-id', identifier: 'same-treatment', created_at: CREATED,
  eventType: 'Carb Correction', carbs: 10, utcOffset: 0, date: BASE, app: 'synthetic',
  srvCreated: BASE, srvModified: BASE, ...extra });
const submitted = extra => ({ identifier: 'same-treatment', created_at: CREATED,
  eventType: 'Carb Correction', carbs: 11, utcOffset: 0, app: 'synthetic', ...extra });
function clean (value) {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).filter(([key]) =>
    !['_id', 'srvCreated', 'srvModified', 'lastModified'].includes(key))
    .map(([key, item]) => [key, clean(item)]));
}
const normalized = docs => docs.map(doc => clean(JSON.parse(JSON.stringify(doc))))
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

// Only deployment composition and provider I/O are fixtures. The domain
// wrappers, v1/v2 inheritance, API3 operations and authority are shipping code.
optInSuite(process.env.NS_REST_TREATMENTS_HTTP_TEST === '1' &&
  !!process.env.NS_TEST_POSTGRES_ADMIN_URI && !!process.env.CUSTOMCONNSTR_mongo,
'NS_REST_TREATMENTS_HTTP_TEST=1 with disposable PostgreSQL and MongoDB')(
  'Tenant treatments actual v1/v2/v3 HTTP differential', function () {
    this.timeout(30000);
    const name = 'treat_' + crypto.randomBytes(7).toString('hex');
    const auth = name + '_auth';
    const role = name + '_app';
    const workers = [];
    const providers = [provider(), provider()];
    const records = new Map();
    const roots = [A, B].map(() => crypto.randomBytes(24).toString('hex'));
    let mode, admin, mongo, mongoCollection, referenceApp, referenceEnv, tokens, jwt;
    let mongoName = 'Current Exact Name', mongoGrants = GRANTS;
    const referenceEvents = [];
    const verifierContext = async tenant => ({ tenant, principal: 'verifier', consumer: 'api' });

    function environment () {
      const env = require('../lib/server/env')();
      env.settings.enable = ['api', 'careportal'];
      env.settings.authDefaultRoles = 'denied';
      env.enclave = { isApiKeySet: () => true };
      env.treatments_collection = name;
      return env;
    }

    function graph (env, bus, authorization, store, ports) {
      const ctx = { bus, authorization, store, ...(ports ? { storagePorts: ports } : {}),
        cache: { treatments: [] }, ddata: require('../lib/data/ddata')(),
        purifier: require('../lib/server/purifier')({}, {}), properties: express.Router() };
      ctx.wares = require('../lib/middleware')(env);
      ctx.treatments = require('../lib/server/treatments')(env, ctx);
      return ctx;
    }

    function legacy (env, ctx) {
      const v1 = require('../lib/api')(env, ctx);
      const router = express.Router();
      router.use('/v1', v1);
      router.use('/v2', require('../lib/api2')(env, ctx, v1));
      return router;
    }

    function api3 (env, ctx, options) {
      const app = express();
      require('../lib/middleware/configure-request')(app);
      app.use(...require('../lib/api3/shared/jsonParser')());
      app.use(require('../lib/api3/shared/renderer').extension2accept);
      app.setENVTruthy = key => defaults[key];
      for (const key of Object.keys(defaults)) app.set(key, defaults[key]);
      app.set('API3_DEDUP_FALLBACK_ENABLED', true);
      app.set('API3_CREATED_AT_FALLBACK_ENABLED', true);
      const col = new Collection({
        ctx, env, app, colName: 'treatments', storageColName: name,
        fallbackGetDate: doc => {
          const date = require('../lib/api3/shared/dateTools').parseToMoment(doc.created_at);
          return date && date.isValid() ? date.toDate() : null;
        },
        fallbackDateField: 'created_at', dedupFallbackFields: ['created_at', 'eventType'], ...options
      });
      col.mapRoutes();
      return { app, col };
    }

    async function rows (tenant = A) {
      return (await admin.query(`SELECT doc FROM "${name}".treatments
        WHERE tenant_id = $1 ORDER BY "_id", id_kind`, [tenant])).rows.map(row => row.doc);
    }

    async function grants (permissions, tenant = A) {
      await admin.query(`UPDATE "${auth}".tenant_authorization_roles SET permissions = $1
        WHERE tenant_id = $2 AND name = 'writer'`, [permissions, tenant]);
    }

    async function displayName (value) {
      await admin.query(`UPDATE "${auth}".tenant_authorization_subjects SET display_name = $1
        WHERE tenant_id = $2 AND subject_id = $3`, [value, A, SUBJECT]);
    }

    function http (method, path, { worker = 0, tenant = A, credential = jwt[tenant === A ? 0 : 1] } = {}) {
      let call = request(workers[worker].server)[method](path)
        .set('Host', tenant === A ? 'one.example.test' : 'two.example.test')
        .set('Accept', 'application/json').timeout({ response: 5000, deadline: 15000 });
      if (credential !== null) call = call.set('Authorization', 'Bearer ' + credential);
      return call;
    }

    async function same (method, path, body, status, headers = {}, referenceBody = body) {
      let expected = request(referenceApp)[method](path).set('Accept', 'application/json');
      let actual = http(method, path);
      for (const [key, value] of Object.entries(headers)) {
        expected = expected.set(key, value);
        actual = actual.set(key, value);
      }
      if (body !== undefined) { expected = expected.send(referenceBody); actual = actual.send(body); }
      const mongoReply = await expected.expect(status);
      const pgReply = await actual.expect(status);
      assert.deepEqual(normalized([pgReply.body]), normalized([mongoReply.body]));
      for (const header of ['warning', 'location', 'content-type', 'nightscout-write-results']) {
        assert.equal(pgReply.headers[header], mongoReply.headers[header], header);
      }
      assert.deepEqual(normalized(await rows()), normalized(await mongoCollection.find({}).toArray()));
      return pgReply;
    }

    async function seed (docs = [treatment()]) {
      await admin.query(`DELETE FROM "${name}".treatments`);
      await mongoCollection.deleteMany({});
      for (const tenant of [A, B]) for (const doc of docs) {
        const row = encodeDocument({ ...doc, ...(tenant === B ? { carbs: 902 } : {}) });
        await admin.query(`INSERT INTO "${name}".treatments (tenant_id, id_kind, doc) VALUES ($1, $2, $3)`,
          [tenant, row.id_kind, row.doc]);
      }
      if (docs.length) await mongoCollection.insertMany(docs.map(doc => ({ ...doc })));
      for (const tenant of [A, B]) await grants(GRANTS, tenant);
      await displayName('Current Exact Name');
      mongoName = 'Current Exact Name';
      mongoGrants = GRANTS;
      referenceEnv.writeValidation = 'off';
      referenceEnv.writeResend = 'update';
      referenceEvents.length = 0;
      for (const worker of workers) {
        worker.events.length = 0;
        worker.visible.length = 0;
        for (const env of worker.envs) {
          env.writeValidation = 'off';
          env.writeResend = 'update';
        }
      }
    }

    before(async function () {
      mode = scope.getTenancyMode();
      scope.setTenancyMode('multi');
      admin = new Client({ connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI });
      await admin.connect();
      for (const [namespace, catalogue] of [
        [name, require('../migrations/candidates/postgres-treatments-v1.json')],
        [auth, require('../lib/tenant-authorization/postgres-candidate.json')]
      ]) await run('up', { direct: true, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI, namespace, catalogue });
      const password = crypto.randomBytes(24).toString('hex');
      await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      await admin.query(`GRANT USAGE ON SCHEMA "${name}", "${auth}" TO "${role}"`);
      await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${name}".treatments TO "${role}"`);
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
        const worker = { envs: [], events: [], visible: [], ports: new Map(), collections: new Map() };
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
            reference: { tenant, id: 'synthetic-import' }, subjects: [{ subjectId: SUBJECT, tokenPrefix: 'synthetic' }]
          })
        });
        const data = express.Router();
        data.use((req, res, next) => scope.withTenant(req.tenantContext.tenant, next));
        const legacyRouter = express.Router();
        for (const tenant of [A, B]) {
          const env = environment();
          worker.envs.push(env);
          const bus = new EventEmitter();
          for (const event of EVENTS) bus.on(event, value => {
            worker.events.push({ tenant, event, value });
            worker.visible.push(rows(tenant));
          });
          const options = Object.fromEntries(['v3', 'v1/internal'].map(source => [
            source, treatmentsOptions({ connection: worker.connection, table: name + '.treatments', env, bus, source })
          ]));
          worker.ports.set(tenant, options);
          const ctx = graph(env, bus, require('../lib/server/tenant-app/legacy-authorization')(), undefined, {
            resolve ({ logical, source }) {
              assert.equal(logical, 'treatments');
              return options[source];
            }
          });
          const mapped = api3(env, ctx, options.v3);
          worker.collections.set(tenant, mapped.col);
          data.use((req, res, next) => req.tenantContext.tenant === tenant ? mapped.app(req, res, next) : next());
          const inherited = require('../lib/api')(env, ctx);
          legacyRouter.use((req, res, next) =>
            scope.requireTenant('treatments fixture') === tenant ? inherited(req, res, next) : next());
        }
        const unavailable = async () => { throw new Error('unused owner capability'); };
        worker.server = createTenantApp({
          resolver: createResolver({ aliases: [
            { host: 'one.example.test', tenant: A }, { host: 'two.example.test', tenant: B }
          ] }),
          dataAccess: createDataAccess({ secrets: worker.secrets, authority: worker.authority, verifierContext,
            collections: ['treatments'], legacyCollections: ['treatments'] }),
          verifyCredential: async () => null, authorizeRequest: async () => false,
          tenantSettings: { read: unavailable, replace: unavailable, rollback: unavailable },
          subjectPolicy: { read: unavailable, replace: unavailable }, dataRouter: data, legacyRouter
        }).listen(0, '127.0.0.1');
        await once(worker.server, 'listening');
        assert.equal(worker.server.address().address, '127.0.0.1');
      }
      for (const [index, tenant] of [A, B].entries()) {
        await workers[0].secrets.encrypt({ tenant, principal: 'issuer', consumer: 'api' },
          'synthetic-import', Buffer.from(roots[index]));
      }
      tokens = roots.map(root => 'synthetic-' + hash(hash(root) + SUBJECT).slice(0, 16));
      jwt = await Promise.all([A, B].map((tenant, index) =>
        workers[0].secrets.signJWT({ tenant, principal: 'issuer', consumer: 'api' }, tokens[index], 300)));
      mongo = new MongoClient(process.env.CUSTOMCONNSTR_mongo);
      await mongo.connect();
      mongoCollection = mongo.db().collection(name);
      await mongoCollection.createIndex({ identifier: 1 }, {
        name: 'identifier_unique', unique: true,
        partialFilterExpression: { identifier: { $type: 'string', $gt: '' } }
      });
      const authorization = {
        endpoints: express.Router(),
        isPermitted: permission => (req, res, next) => {
          const permissions = shiro.new();
          mongoGrants.forEach(grant => permissions.add(grant));
          if (permissions.check(permission)) return next();
          res.status(403).json({ status: 403, message: 'Forbidden' });
        }
      };
      const bus = new EventEmitter();
      for (const event of EVENTS) bus.on(event, value => referenceEvents.push({ event, value }));
      const env = environment();
      referenceEnv = env;
      const ctx = graph(env, bus, authorization, {
        db: mongo.db(), collection: n => mongo.db().collection(n), ensureIndexes () {}
      });
      referenceApp = express();
      referenceApp.use((req, res, next) => {
        const permissions = shiro.new();
        mongoGrants.forEach(grant => permissions.add(grant));
        authentication.bind(req, { shiros: [permissions], ...(mongoName ? { subject: { name: mongoName } } : {}) });
        scope.withTenant(A, next);
      });
      referenceApp.use('/api', legacy(env, ctx));
      referenceApp.use('/api/v3', api3(env, ctx).app);
      await seed();
      await http('get', '/api/v3/treatments/same-treatment').expect(200);
      await http('get', '/api/v1/treatments').expect(200);
    });

    beforeEach(() => seed());
    after(async function () {
      try {
        for (const worker of workers.reverse()) {
          if (worker.server) await new Promise(resolve => worker.server.close(resolve));
          if (worker.connection) await worker.connection.end();
          if (worker.authority) await worker.authority.close();
        }
        if (mongo) { await mongo.db().collection(name).drop(); await mongo.close(); }
        if (admin) {
          await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
          await admin.query(`DROP SCHEMA IF EXISTS "${auth}" CASCADE`);
          await admin.query(`DROP ROLE IF EXISTS "${role}"`);
          await admin.end();
        }
      } finally { if (mode !== undefined) scope.setTenancyMode(mode); }
    });

    it('serves legacy inheritance, query defaults, created_at order, suffixes and conditional responses', async function () {
      await seed([treatment(), treatment({ _id: 'older', identifier: 'older', created_at: time.day(-1) + 'T00:00:00.000Z' })]);
      for (const version of [1, 2]) {
        for (const suffix of ['', '.json', '.csv', '.txt', '.xml']) {
          // Legacy treatments always answers JSON for recognized suffixes.
          const path = `/api/v${version}/treatments${suffix}`;
          if (suffix === '.xml') continue;
          const response = await same('get', path, undefined, 200);
          assert.ok(response.body.length > 0, 'default treatment list retains recent row');
          assert.equal(response.body[0].identifier, 'same-treatment');
        }
        await same('get', `/api/v${version}/treatments?count=1&find[eventType]=Carb%20Correction`, undefined, 200);
        await same('get', `/api/v${version}/treatments?find[created_at][$gte]=${time.day()}`, undefined, 200);
        await same('get', `/api/v${version}/treatments`, undefined, 304, { 'If-Modified-Since': new Date(BASE + 86400000 - 123).toUTCString() });
      }
    });

    it('preserves array/single retries, same-time distinct records, duration and temporary target unit preparation', async function () {
      await seed([]);
      for (const version of [1, 2]) {
        const batch = [
          submitted({ identifier: 'a-' + version, eventType: 'Temporary Target', targetBottom: 5.5,
            targetTop: 6.5, units: 'mmol', duration: '30' }),
          submitted({ identifier: 'b-' + version, eventType: 'Carb Correction', carbs: '20' })
        ];
        await same('post', `/api/v${version}/treatments`, batch, 200);
        const ids = (await rows()).map(doc => doc._id);
        await same('post', `/api/v${version}/treatments`, batch, 200);
        assert.deepEqual((await rows()).map(doc => doc._id), ids);
      }
      const stored = await rows();
      assert.equal(stored.length, 4);
      assert.equal(stored.find(doc => doc.identifier === 'a-1').duration, 30);
      assert.ok(stored.find(doc => doc.identifier === 'a-1').targetBottom > 90);
    });

    it('preserves preBolus storage without adding reply slots, including retries', async function () {
      await seed([]);
      const batch = [submitted({ identifier: 'prebolus', carbs: '30', insulin: '2', preBolus: '15' }),
        submitted({ identifier: 'other', eventType: 'BG Check', glucose: 100 })];
      for (let cycle = 0; cycle < 2; cycle++) {
        const reply = await same('post', '/api/v2/treatments', batch, 200);
        assert.equal(reply.body.length, 2);
        assert.equal((await rows()).length, 3);
      }
    });

    it('retains per-item validation refusals and resend slots with opt-in and default replies', async function () {
      for (const optIn of [false, true]) {
        await seed([]);
        referenceEnv.writeValidation = 'reject';
        for (const worker of workers) for (const env of worker.envs) env.writeValidation = 'reject';
        const batch = [
          submitted({ identifier: 'allowed', eventType: 'Temporary Target', duration: 30,
            units: 'mg/dl', targetTop: 110, targetBottom: 100 }),
          submitted({ identifier: 'refused', eventType: 'Temporary Target', duration: 30,
            units: 'mg/dl', targetTop: 90, targetBottom: 140 })
        ];
        const reply = await same('post', '/api/v1/treatments' + (optIn ? '?results=items' : ''), batch, 200);
        const slots = optIn ? reply.body.documents : reply.body;
        assert.equal(slots.length, 2);
        assert.equal(slots[1].refused.status, 400);
        assert.equal((await rows()).length, 1);
        if (optIn) assert.equal(reply.body.items[1].outcome, 'refused');
        await same('post', '/api/v2/treatments?results=items', [batch[1]], 400);
      }
    });

    it('legacy POST and PUT feed actual API3 addressed reads, search and incremental history losslessly', async function () {
      await seed([]);
      await same('post', '/api/v1/treatments', submitted({ extension: { 'literal.dot': [1, false, null] } }), 200);
      const created = (await rows())[0];
      await same('get', '/api/v3/treatments/same-treatment', undefined, 200);
      await same('get', '/api/v3/treatments?eventType=Carb%20Correction&sort$desc=created_at', undefined, 200);
      await same('get', '/api/v3/treatments/history/' + (BASE - 1), undefined, 200);
      const referenceId = (await mongoCollection.findOne({ identifier: 'same-treatment' }))._id.toString();
      await same('put', '/api/v2/treatments', { ...submitted({ carbs: 25 }), _id: created._id }, 200,
        {}, { ...submitted({ carbs: 25 }), _id: referenceId });
      const reply = await http('get', '/api/v3/treatments/same-treatment', { worker: 1 }).expect(200);
      assert.equal(reply.body.result.carbs, 25);
      const history = await http('get', '/api/v3/treatments/history/' + (BASE - 1), { worker: 1 }).expect(200);
      const stored = (await rows())[0];
      assert.equal(history.body.result.length, 1);
      assert.equal(history.body.result[0].srvModified, stored.srvModified);
      assert.equal(history.headers.etag, 'W/"' + stored.srvModified + '"');
      assert.equal(history.headers['last-modified'], new Date(stored.srvModified).toUTCString());
    });

    it('preserves API3 POST deduplication and addressed PUT/PATCH/delete/history shipping outcomes', async function () {
      await same('post', '/api/v3/treatments', submitted(), 200);
      await same('put', '/api/v3/treatments/same-treatment', submitted({ extension: { retained: 1 } }), 200);
      await same('patch', '/api/v3/treatments/same-treatment', { carbs: 12, extension: { added: 2 } }, 200);
      assert.equal((await rows())[0].modifiedBy, 'Current Exact Name');
      await same('get', '/api/v3/treatments/history/' + BASE, undefined, 200);
      await same('delete', '/api/v3/treatments/same-treatment', undefined, 200);
      assert.equal((await rows())[0].isValid, false);
      await same('get', '/api/v3/treatments/same-treatment', undefined, 410);
      await same('delete', '/api/v3/treatments/same-treatment?permanent=true', undefined, 200);
      await same('get', '/api/v3/treatments/same-treatment', undefined, 404);
      await same('post', '/api/v3/treatments', submitted({ identifier: 'new-treatment' }), 201);
      await same('post', '/api/v3/treatments', [submitted()], 400);
    });

    it('preserves identifier collision and failed immutable/date preconditions without writes', async function () {
      await seed([treatment(), treatment({ _id: 'second', identifier: 'held-treatment' })]);
      const before = await rows();
      await same('patch', '/api/v3/treatments/same-treatment', { identifier: 'held-treatment' }, 409);
      await same('patch', '/api/v3/treatments/same-treatment', { identifier: 'unheld-treatment' }, 400);
      await same('put', '/api/v3/treatments/same-treatment', submitted(), 412,
        { 'If-Unmodified-Since': new Date(BASE - 1000).toUTCString() });
      assert.deepEqual(await rows(), before);
      assert.deepEqual(workers[0].events, []);
    });

    // Server-side current compatibility, not execution of a client binary.
    // These records deliberately use the same stable storage and semantic IDs
    // in both databases. Ignore only top-level server clock stamps: extension
    // members named _id/srvCreated/lastModified remain part of the comparison.
    const workflowDocument = doc => Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(doc)))
      .filter(([key]) => !['srvCreated', 'srvModified'].includes(key)));
    async function workflowRows () {
      const actual = await rows();
      const expected = await mongoCollection.find({}).sort({ identifier: 1 }).toArray();
      const ordered = docs => docs.map(workflowDocument).sort((a, b) => a.identifier.localeCompare(b.identifier));
      assert.deepEqual(ordered(actual), ordered(expected), 'whole stored documents, including IDs and nested metadata');
      assert.equal(actual.length, 1);
      assert.equal(actual[0]._id, 'same-id');
      assert.equal(actual[0].identifier, 'same-treatment');
      return actual[0];
    }
    async function workflowRead (path, history = false) {
      const actual = await same('get', path, undefined, 200);
      const expected = await request(referenceApp).get(path).set('Accept', 'application/json').expect(200);
      const docs = reply => path.includes('/api/v3/') ? (history ? reply.body.result : [reply.body.result]) : reply.body;
      assert.deepEqual(docs(actual).map(workflowDocument), docs(expected).map(workflowDocument),
        'HTTP documents retain semantic identity and extension metadata');
      return docs(actual);
    }

    it('mixed-version edit workflow distinguishes omitted fields, nulls and replacement retries', async function () {
      await seed([treatment({ notes: 'remove-on-replace', extension: { stale: true } })]);
      const foreign = await rows(B);
      const replacement = { ...submitted({ carbs: 0, notes: null, nullableExtension: null, extension: {
        _id: 'nested-identity', srvCreated: 7, lastModified: 'extension-value',
        keep: false, remove: 'explicit-null', nested: { keep: 0, remove: 'explicit-null' }, list: [1, null]
      } }), _id: 'same-id' };
      await same('put', '/api/v2/treatments', replacement, 200);
      let stored = await workflowRows();
      // Legacy treatment preparation deliberately removes empty notes and
      // zero carbs (write-intent.js prepareTreatment), unlike extension data.
      assert.equal(Object.hasOwn(stored, 'notes'), false);
      assert.equal(Object.hasOwn(stored, 'carbs'), false);
      assert.equal(stored.nullableExtension, null, 'PUT stores an explicit extension null');
      assert.equal(stored.extension.stale, undefined, 'PUT removes omitted nested members');
      const patch = { extension: { remove: null, nested: { remove: null, added: false }, list: [] } };
      for (let retry = 0; retry < 2; retry++) {
        await same('patch', '/api/v3/treatments/same-treatment', patch, 200);
        stored = await workflowRows();
        assert.equal(stored.nullableExtension, null, 'PATCH keeps an omitted top-level extension null');
        assert.deepEqual(stored.extension, { _id: 'nested-identity', srvCreated: 7,
          lastModified: 'extension-value', keep: false, nested: { keep: 0, added: false }, list: [] });
        for (const version of [1, 2]) await workflowRead(`/api/v${version}/treatments`);
        await workflowRead('/api/v3/treatments/same-treatment');
        await workflowRead('/api/v3/treatments/history/' + (BASE - 1), true);
      }
      const whole = submitted({ carbs: 15, extension: { replaced: [null, false, 0] } });
      for (let retry = 0; retry < 2; retry++) {
        await same('put', '/api/v3/treatments/same-treatment', whole, 200);
        stored = await workflowRows();
        assert.equal(Object.hasOwn(stored, 'notes'), false, 'PUT removes omitted top-level fields');
        assert.equal(Object.hasOwn(stored, 'nullableExtension'), false);
        assert.deepEqual(stored.extension, whole.extension, 'PUT replaces the whole extension');
      }
      assert.deepEqual(await rows(B), foreign);
    });

    it('mixed-version edit workflow preserves failed conditionals and soft-delete history across retry', async function () {
      const foreign = await rows(B);
      await same('patch', '/api/v3/treatments/same-treatment', { notes: 'edited', extension: { nested: [null, 0, false] } }, 200);
      await workflowRows();
      const before = await rows();
      const expectedBefore = await mongoCollection.find({}).toArray();
      const eventsBefore = workers[0].events.length;
      await same('patch', '/api/v3/treatments/same-treatment', { notes: null }, 412,
        { 'If-Unmodified-Since': new Date(BASE - 1000).toUTCString() });
      assert.deepEqual(await rows(), before, 'failed PATCH cannot change even server stamps');
      assert.deepEqual(await mongoCollection.find({}).toArray(), expectedBefore);
      assert.equal(workers[0].events.length, eventsBefore);
      for (let retry = 0; retry < 2; retry++) {
        await same('delete', '/api/v3/treatments/same-treatment', undefined, 200);
        const stored = await workflowRows();
        assert.equal(stored.isValid, false);
        assert.equal(stored.notes, 'edited');
        assert.deepEqual(stored.extension, { nested: [null, 0, false] });
        await same('get', '/api/v3/treatments/same-treatment', undefined, 410);
        const history = await workflowRead('/api/v3/treatments/history/' + (BASE - 1), true);
        assert.equal(history.length, 1);
        assert.equal(history[0].isValid, false, 'incremental readers receive the tombstone');
      }
      assert.deepEqual(await rows(B), foreign);
    });

    it('bounds the shared edit corpus with explicit PostgreSQL nonrepresentable-text refusals', async function () {
      // postgres-entries-write.js jsonValue rejects U+0000 and unpaired
      // surrogates: PostgreSQL JSONB cannot represent them. This is an explicit
      // preview refusal, not a Mongo-equivalent response or a normalized value.
      for (const text of ['synthetic\u0000extension', 'synthetic\ud800extension']) {
        await seed();
        const before = await rows();
        const foreign = await rows(B);
        const doc = { extension: { text } };
        await request(referenceApp).patch('/api/v3/treatments/same-treatment').send(doc).expect(200);
        const refusal = await http('patch', '/api/v3/treatments/same-treatment').send(doc).expect(400);
        assert.deepEqual(refusal.body, { status: 400, message: 'Document cannot be represented by this storage' });
        assert.deepEqual(await rows(), before);
        assert.deepEqual(await rows(B), foreign);
        assert.deepEqual(workers[0].events, []);
        const reference = await mongoCollection.findOne({ identifier: 'same-treatment' });
        // BSON replaces an unpaired surrogate with U+FFFD; Mongo's accepted
        // wire value is observed separately instead of equating it to PG.
        assert.equal(reference.extension.text, text.includes('\u0000') ? text : 'synthetic\ufffdextension');
      }
    });

    it('recovers concurrent duplicate identifier uploads across workers without extra rows', async function () {
      await seed([]);
      const responses = await Promise.all([0, 1].map(worker =>
        http('post', '/api/v3/treatments', { worker }).send(submitted()).expect(res => {
          assert.ok([200, 201].includes(res.status), 'successful insert or shipping deduplication');
        })));
      assert.ok(responses.some(res => res.status === 201));
      assert.equal((await rows()).length, 1);
      assert.equal((await rows())[0].identifier, 'same-treatment');
      assert.equal((await rows(B)).length, 0);
    });

    it('uses version-specific credential carriers after domain parsing without storing secrets', async function () {
      await seed([]);
      for (const version of [1, 2]) {
        const response = await http('post', `/api/v${version}/treatments`, { credential: null }).send([
          submitted({ identifier: 'carrier-' + version, token: tokens[0] })
        ]).expect(200);
        assert.equal(response.body[0].token, undefined);
      }
      assert.ok((await rows()).every(doc => !Object.hasOwn(doc, 'token') && !Object.hasOwn(doc, 'secret')));
      const before = await rows();
      await http('post', '/api/v3/treatments?token=' + tokens[0], { credential: null }).send(submitted()).expect(401);
      assert.deepEqual(await rows(), before);
    });

    it('legacy delete by query and ID preserves typed ObjectId/string handling and missing results', async function () {
      const hex = '65a1b2c3d4e5f60718293a4b';
      await seed([treatment({ _id: hex, identifier: 'string' }),
        treatment({ _id: new ObjectId(hex), identifier: 'object' })]);
      await same('delete', '/api/v1/treatments/' + hex, undefined, 200);
      assert.equal((await rows()).length, 0);
      await seed();
      await same('delete', '/api/v2/treatments?find[eventType]=Carb%20Correction', undefined, 200);
      assert.equal((await rows()).length, 0);
    });

    it('isolates overlapping identifiers and writes across workers and physical RLS sessions', async function () {
      const foreign = await rows(B);
      await http('patch', '/api/v3/treatments/same-treatment', { worker: 0 }).send({ carbs: 21 }).expect(200);
      await http('patch', '/api/v3/treatments/same-treatment', { worker: 1, tenant: B }).send({ carbs: 31 }).expect(200);
      assert.equal((await http('get', '/api/v3/treatments/same-treatment', { worker: 1 }).expect(200)).body.result.carbs, 21);
      assert.equal((await http('get', '/api/v3/treatments/same-treatment', { tenant: B }).expect(200)).body.result.carbs, 31);
      assert.equal(foreign[0].carbs, 902);
      await http('get', '/api/v1/treatments', { tenant: B, credential: jwt[0] }).expect(401);
      await assert.rejects(async () => workers[0].connection.query(`SELECT * FROM "${name}".treatments`), /tenant/);
      const excluded = await scope.withTenant(A, () => workers[0].connection.query(
        `SELECT doc FROM "${name}".treatments WHERE tenant_id = $1`, [B]));
      assert.equal(excluded.rowCount, 0);
      await assert.rejects(scope.withTenant(A, () => workers[0].connection.query(
        `INSERT INTO "${name}".treatments (tenant_id, id_kind, doc) VALUES ($1, 'string', $2)`,
        [B, { _id: 'foreign-write', eventType: 'Note' }])), error => error.code === '42501');
    });

    it('consults current persisted grants and exact subject names after JWT issuance, never anonymous writes', async function () {
      await displayName('Renamed Exact Subject');
      await http('patch', '/api/v3/treatments/same-treatment', { worker: 1 }).send({ carbs: 30 }).expect(200);
      assert.equal((await rows())[0].modifiedBy, 'Renamed Exact Subject');
      await grants(['api:treatments:read']);
      const before = await rows();
      for (const worker of [0, 1]) for (const version of [1, 2, 3]) {
        const denied = version === 3 ? 403 : 401;
        await http('post', `/api/v${version}/treatments`, { worker }).send(submitted()).expect(denied);
        await http('post', `/api/v${version}/treatments`, { worker, credential: null }).send(submitted()).expect(denied);
        await http('post', `/api/v${version}/treatments`, { worker, credential: 'invalid' }).send(submitted()).expect(401);
      }
      assert.deepEqual(await rows(), before);
      await grants(GRANTS);
      await displayName(null);
      await http('patch', '/api/v3/treatments/same-treatment').send({ carbs: 40 }).expect(401);
      await seed();
      const root = await request(workers[0].server).patch('/api/v3/treatments/same-treatment')
        .set('Host', 'one.example.test').set('api-secret', hash(roots[0])).send({ carbs: 40 }).expect(200);
      assert.equal(root.body.status, 200);
      assert.equal((await rows())[0].modifiedBy, undefined);
    });

    it('rolls back failures without any committed-change notification and publishes only committed data', async function () {
      const connection = workers[0].connection;
      const original = connection.transaction;
      const before = await rows();
      connection.transaction = fn => original(async () => { await fn(); throw new Error('synthetic post-write failure'); });
      try {
        await http('patch', '/api/v3/treatments/same-treatment').send({ carbs: 41 }).expect(500);
        await http('put', '/api/v1/treatments').send({ ...submitted({ carbs: 42 }), _id: 'same-id' }).expect(500);
        await http('post', '/api/v2/treatments').send(submitted({ preBolus: 15, carbs: 30 })).expect(500);
        assert.deepEqual(await rows(), before);
        assert.deepEqual(workers[0].events, []);
      } finally { connection.transaction = original; }
      await http('patch', '/api/v3/treatments/same-treatment').send({ carbs: 43 }).expect(200);
      for (const visible of await Promise.all(workers[0].visible)) assert.equal(visible[0].carbs, 43);
    });

    it('maps only submitted nonrepresentability and known outages, preserving internal faults as 500', async function () {
      const before = await rows();
      for (const version of [1, 2, 3]) {
        await http('post', `/api/v${version}/treatments`).send(submitted({ text: '\0' })).expect(400);
      }
      assert.deepEqual(await rows(), before);
      assert.deepEqual(workers[0].events, []);
      const connection = workers[0].connection;
      const original = connection.transaction;
      for (const [error, status] of [
        [Object.assign(new Error('synthetic unavailable'), { code: 'ECONNRESET' }), 503],
        [Object.assign(new TypeError('stored unsupported shape'), { unsupported: true }), 500]
      ]) {
        connection.transaction = async () => { throw error; };
        try {
          await http('put', '/api/v1/treatments').send({ ...submitted(), _id: 'same-id' }).expect(status);
          await http('delete', '/api/v2/treatments/same-id').expect(status);
          await http('patch', '/api/v3/treatments/same-treatment').send({ carbs: 44 }).expect(status);
        } finally { connection.transaction = original; }
      }
      const authority = workers[0].authority;
      const snapshot = authority.subjectSnapshot;
      authority.subjectSnapshot = async () => { throw new Error('synthetic authority unavailable'); };
      try {
        await http('put', '/api/v2/treatments').send(submitted()).expect(503);
        await http('patch', '/api/v3/treatments/same-treatment').send({ carbs: 44 }).expect(503);
      } finally { authority.subjectSnapshot = snapshot; }
      assert.deepEqual(await rows(), before);
      assert.deepEqual(workers[0].events, []);
    });
  });
