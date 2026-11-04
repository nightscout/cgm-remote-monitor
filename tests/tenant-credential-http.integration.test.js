'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const { MongoClient } = require('mongodb');
const shiro = require('shiro-trie');
const authentication = require('../lib/api3/tenant-authentication');
const srvDates = require('../lib/server/srv-dates');
const express = require('express');
const request = require('supertest');
const { run } = require('../lib/migrations/postgres');
const scope = require('../lib/storage/tenant-scope');
const connect = require('../lib/storage/postgres-connection');
const createAuthority = require('../lib/tenant-authorization/postgres');
const createLegacyAuthority = require('../lib/secrets/legacy-postgres');
const { createPostgresSecrets } = require('../lib/secrets/postgres');
const { createSecrets } = require('../lib/secrets/component');
const createDataAccess = require('../lib/server/tenant-app/data-access');
const createExchange = require('../lib/server/tenant-app/exchange');
const { createTenantApp } = require('../lib/server/tenant-app');
const createResolver = require('../lib/tenant-resolution');
const Api3Collection = require('../lib/api3/generic/collection');
const writer = require('../lib/storage/postgres-entries-write');
const entriesOptions = require('../lib/server/tenant-app/entries');
const purifier = require('../lib/server/purifier');
const provider = require('./fixtures/tenant-credential-provider');
const { optInSuite } = require('./support/opt-in');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SUBJECT = '000000000000000000000001';
const OTHER = '000000000000000000000002';
const hash = value => crypto.createHash('sha1').update(value).digest('hex');
const docker = args => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000
}).trim();

optInSuite(process.env.NS_TENANT_CREDENTIAL_HTTP_DOCKER_TEST === '1',
  'NS_TENANT_CREDENTIAL_HTTP_DOCKER_TEST=1')('tenant credential/current-authority actual GET (PostgreSQL)', function () {
  this.timeout(90000);
  const container = 'ns-tenant-credential-http-' + crypto.randomBytes(8).toString('hex');
  const role = 'credential_http_app';
  const roots = [crypto.randomBytes(24).toString('hex'), crypto.randomBytes(24).toString('hex')];
  const providers = [provider(), provider()];
  const workers = [];
  let owned = false, admin, previousMode, appURI, time = Date.now(), subjectTokens, jwt, signingUnavailable = false;
  const schemas = [
    ['credential_data', require('../migrations/candidates/postgres-entries-v1.json')],
    ['credential_auth', require('../lib/tenant-authorization/postgres-candidate.json')],
    ['credential_secrets', require('../lib/secrets/postgres-candidate.json')],
    ['credential_identity', require('../lib/secrets/legacy-credentials-candidate.json')]
  ];
  const ctx = (tenant, principal = 'verifier') => ({ tenant, principal, consumer: 'api' });

  function http (worker = 0, tenant = A, headers = {}, method = 'get', path = '/api/v3/entries/shared-entry') {
    let call = request(workers[worker].server)[method](path)
      .set('Host', tenant === A ? 'one.example.test' : tenant === B ? 'two.example.test' : 'unknown.example.test')
      .timeout({ response: 5000, deadline: 15000 });
    for (const [key, value] of Object.entries(headers)) call = call.set(key, value);
    return call;
  }
  const bearer = token => ({ Authorization: 'Bearer ' + token });
  const secret = value => ({ 'api-secret': value });
  async function rows () {
    return (await admin.query('SELECT tenant_id, doc FROM credential_data.entries ORDER BY tenant_id, "_id"')).rows;
  }

  async function makeWorker () {
    const worker = {};
    workers.push(worker);
    worker.legacy = await createLegacyAuthority({ connectionString: appURI, namespace: 'credential_identity' });
    worker.authority = await createAuthority({ connectionString: appURI, namespace: 'credential_auth' });
    worker.persistence = await createPostgresSecrets({ connectionString: appURI, namespace: 'credential_secrets' });
    worker.secrets = createSecrets({
      ...worker.persistence,
      providerFor: async tenant => {
        assert.ok([A, B].includes(tenant));
        const current = providers[tenant === A ? 0 : 1];
        return { ...current, async sign (input) {
          if (signingUnavailable) throw new Error('synthetic signer unavailable');
          return current.sign(input);
        } };
      },
      // These are synthetic trusted service capabilities, not user/data grants.
      // User permissions below always come from the real authority repository.
      authorize: async (identity, action) => identity.consumer === 'api' &&
        ((identity.principal === 'verifier' && ['decrypt', 'verify', 'sign'].includes(action.operation)) ||
         (identity.principal === 'issuer' && ['encrypt', 'sign'].includes(action.operation))),
      maxTokenLifetimeSeconds: 28800,
      now: () => time,
      legacyAuthorityFor: tenant => worker.legacy.read(tenant)
    });
    worker.connection = await connect({ connectionString: appURI, max: 1 });
    const data = express.Router();
    data.use((req, res, next) => scope.withTenant(req.tenantContext.tenant, next));
    worker.collections = new Map();
    worker.environments = new Map();
    worker.events = [];
    for (const tenant of [A, B]) {
      const routes = express.Router();
      const bus = new EventEmitter();
      for (const event of ['storage-intent-committed', 'storage-socket-create', 'storage-socket-update', 'data-received']) {
        bus.on(event, value => worker.events.push({ tenant, event, value }));
      }
      const routeApp = {
        get: (path, handler) => handler === undefined ? (path === 'API3_DEDUP_FALLBACK_ENABLED' ? true : undefined)
          : routes.get(path, handler),
        setENVTruthy: () => undefined
      };
      for (const method of ['post', 'put', 'patch', 'delete']) routeApp[method] = routes[method].bind(routes);
      const env = {};
      worker.environments.set(tenant, env);
      const routeCollection = new Api3Collection({
        ctx: { bus, purifier: purifier({}, {}) },
        env, app: routeApp, colName: 'entries', storageColName: 'entries',
        fallbackGetDate: doc => new Date(doc.srvModified),
        dedupFallbackFields: ['date', 'type'], fallbackDateField: 'date',
        ...entriesOptions({ connection: worker.connection, table: 'credential_data.entries', bus, env })
      });
      routeCollection.mapRoutes();
      worker.collections.set(tenant, routeCollection);
      data.use((req, res, next) => req.tenantContext.tenant === tenant ? routes(req, res, next) : next());
    }
    const unavailable = async () => { throw new Error('owner services not installed'); };
    worker.server = createTenantApp({
      resolver: createResolver({ aliases: [
        { host: 'one.example.test', tenant: A }, { host: 'two.example.test', tenant: B }
      ] }),
      dataAccess: createDataAccess({ secrets: worker.secrets, authority: worker.authority, verifierContext: ctx }),
      exchange: createExchange({ secrets: worker.secrets, authority: worker.authority, verifierContext: ctx }),
      verifyCredential: async () => null,
      authorizeRequest: async () => false,
      tenantSettings: { read: unavailable, replace: unavailable, rollback: unavailable },
      subjectPolicy: { read: unavailable, replace: unavailable },
      dataRouter: data
    }).listen(0, '127.0.0.1');
    await once(worker.server, 'listening');
    assert.equal(worker.server.address().address, '127.0.0.1');
  }

  before(async function () {
    previousMode = scope.getTenancyMode();
    scope.setTenancyMode('multi');
    const password = crypto.randomBytes(24).toString('hex');
    execFileSync('docker', ['run', '--name', container, '-d', '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_USER=operator', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=credential_test', 'postgres:16'],
    { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    owned = true;
    const port = docker(['port', container, '5432/tcp']).split(':').pop();
    const adminURI = 'postgres://operator:' + password + '@127.0.0.1:' + port + '/credential_test';
    const deadline = Date.now() + 20000;
    for (;;) {
      try {
        docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'operator', '-d', 'credential_test']);
        break;
      } catch (error) {
        if (![1, 2].includes(error.status) || Date.now() > deadline) throw error;
        await delay(100);
      }
    }
    assert.equal(docker(['inspect', '--format', '{{.State.Running}}', container]), 'true');
    for (const [namespace, catalogue] of schemas) {
      const options = { direct: true, connectionString: adminURI, namespace, catalogue };
      await run('up', options);
      assert.equal((await run('check', options)).current, true);
    }
    admin = new Client({ connectionString: adminURI });
    await admin.connect();
    const appPassword = crypto.randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${appPassword}'`);
    await admin.query(`GRANT USAGE ON SCHEMA credential_data, credential_auth, credential_secrets, credential_identity TO ${role}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON credential_data.entries TO ${role}`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA credential_auth, credential_identity TO ${role}`);
    await admin.query(`GRANT SELECT, INSERT ON credential_secrets.secret_records TO ${role}`);
    await admin.query(`GRANT INSERT ON credential_secrets.secret_audit TO ${role}`);
    const url = new URL(adminURI);
    url.username = role;
    url.password = appPassword;
    appURI = url.toString();
    await admin.query(`INSERT INTO credential_identity.legacy_credential_config VALUES
      ($1, 'operator-import-a'), ($2, 'operator-import-b')`, [A, B]);
    for (const tenant of [A, B]) {
      await admin.query(`INSERT INTO credential_identity.legacy_credential_subjects VALUES
        ($1, $2, 'sameviewer'), ($1, $3, 'sameviewer')`, [tenant, SUBJECT, OTHER]);
      await admin.query(`INSERT INTO credential_auth.tenant_authorization_config VALUES ($1, ARRAY['denied'])`, [tenant]);
      await admin.query(`INSERT INTO credential_auth.tenant_authorization_subjects (tenant_id, subject_id) VALUES ($1, $2), ($1, $3)`,
        [tenant, SUBJECT, OTHER]);
      await admin.query(`UPDATE credential_auth.tenant_authorization_subjects
        SET display_name = 'Same Viewer Exact ' || CASE WHEN tenant_id = $1 THEN 'A' ELSE 'B' END
        WHERE tenant_id = $2`, [A, tenant]);
      await admin.query(`INSERT INTO credential_auth.tenant_authorization_roles VALUES
        ($1, 'viewer', ARRAY['api:entries:read']), ($1, 'uploader', ARRAY['api:entries:create'])`, [tenant]);
      await admin.query(`INSERT INTO credential_auth.tenant_authorization_subject_roles VALUES
        ($1, $2, 'viewer'), ($1, $3, 'uploader')`, [tenant, SUBJECT, OTHER]);
    }
    await makeWorker();
    await makeWorker();
    for (const [index, tenant] of [A, B].entries()) {
      await workers[0].secrets.encrypt(ctx(tenant, 'issuer'), index === 0 ? 'operator-import-a' : 'operator-import-b',
        Buffer.from(roots[index]));
      await workers[0].connection.withTenant(tenant, () => writer({
        connection: workers[0].connection, table: 'credential_data.entries'
      }).insertOne({ _id: 'same-id', identifier: 'shared-entry', sgv: index === 0 ? 101 : 202,
        date: 1793664000000, srvModified: 1793664000000, type: 'sgv' }, { normalize: false }));
    }
    subjectTokens = roots.map(root => 'sameviewer-' + hash(hash(root) + SUBJECT).slice(0, 16));
    jwt = await Promise.all([A, B].map((tenant, index) =>
      workers[0].secrets.signJWT(ctx(tenant, 'issuer'), subjectTokens[index], 300)));
    await http(0, A, bearer(jwt[0])).expect(200);
  });

  function exchange (credential, worker = 0, tenant = A, headers = {}) {
    return http(worker, tenant, headers, 'get',
      '/api/v2/authorization/request/' + encodeURIComponent(credential));
  }

  it('packet: distinguishes root plaintext from accepted SHA1 and SHA512 headers on actual GET', async function () {
    const before = await rows();
    for (const [index, tenant] of [A, B].entries()) {
      const enclave = require('../lib/server/enclave')();
      enclave.setApiKey(roots[index]);
      const forms = [
        { label: 'plaintext', value: roots[index], status: 401, principal: null },
        { label: 'SHA1 lowercase hex', value: hash(roots[index]), status: 200, principal: { kind: 'root' } },
        { label: 'SHA1 uppercase hex', value: hash(roots[index]).toUpperCase(), status: 200, principal: { kind: 'root' } },
        { label: 'SHA512 lowercase hex', value: crypto.createHash('sha512').update(roots[index]).digest('hex'),
          status: 200, principal: { kind: 'root' } }
      ];
      for (const form of forms) {
        assert.equal(enclave.isApiKey(form.value), form.status === 200, form.label);
        assert.deepEqual(await workers[index].secrets.verifyLegacyCredential(ctx(tenant), { apiSecret: form.value }),
          form.principal, form.label);
        await http(index, tenant, secret(form.value)).expect(form.status);
      }
    }
    assert.deepEqual(await rows(), before);
  });

  it('packet: distinguishes missing display metadata from authority unavailability', async function () {
    const principal = { kind: 'subject', subjectId: SUBJECT };
    const permission = 'api:entries:create';
    const initial = await workers[0].authority.subjectSnapshot({ tenant: A, principal });
    const before = await rows();
    await admin.query(`UPDATE credential_auth.tenant_authorization_roles
      SET permissions = ARRAY['api:entries:read', 'api:entries:create'] WHERE tenant_id = $1 AND name = 'viewer'`, [A]);
    try {
      await admin.query(`UPDATE credential_auth.tenant_authorization_subjects SET display_name = NULL
        WHERE tenant_id = $1 AND subject_id = $2`, [A, SUBJECT]);
      assert.equal(await workers[1].authority.authorize({ tenant: A, principal, permission }), true);
      assert.equal(await workers[1].authority.subjectSnapshot({ tenant: A, principal }), null);
      await exchange(subjectTokens[0], 1).expect(401);
      await http(1, A, bearer(jwt[0])).expect(200);
      await admin.query(`REVOKE SELECT ON credential_auth.tenant_authorization_subjects FROM ${role}`);
      try {
        await assert.rejects(workers[1].authority.subjectSnapshot({ tenant: A, principal }),
          { code: 'TENANT_AUTHORITY_UNAVAILABLE' });
        await exchange(subjectTokens[0], 1).expect(503);
      } finally {
        await admin.query(`GRANT SELECT ON credential_auth.tenant_authorization_subjects TO ${role}`);
      }
    } finally {
      await admin.query(`UPDATE credential_auth.tenant_authorization_roles
        SET permissions = ARRAY['api:entries:read'] WHERE tenant_id = $1 AND name = 'viewer'`, [A]);
      await admin.query(`UPDATE credential_auth.tenant_authorization_subjects SET display_name = $3
        WHERE tenant_id = $1 AND subject_id = $2`, [A, SUBJECT, initial.sub]);
    }
    assert.deepEqual(await rows(), before);
  });

  it('accepts actual POST with a separately verified root SHA1 header and returns the shipping contract', async function () {
    await http(0, A, secret(hash(roots[0]))).expect(200);
    const response = await http(0, A, secret(hash(roots[0])), 'post', '/api/v3/entries')
      .send({ identifier: 'packet-synthetic-entry', date: 1793664000000,
        utcOffset: 0, app: 'synthetic-packet', type: 'sgv', sgv: 123 });
    assert.equal(response.status, 201, 'actual tenant API3 POST must reach the shipping create handler');
    assert.equal(response.body.identifier, 'packet-synthetic-entry');
    assert.equal(response.headers.location, '/api/v3/entries/packet-synthetic-entry');
    assert.ok(response.headers['last-modified']);
    await admin.query("DELETE FROM credential_data.entries WHERE identifier = 'packet-synthetic-entry'");
  });

  it('accepts legitimate extension field names and JSON values through the actual PostgreSQL entries handler', async function () {
    const response = await http(0, A, secret(hash(roots[0])), 'post', '/api/v3/entries').send({
      identifier: 'extension-synthetic-entry', date: 1793664000000,
      utcOffset: 0, app: 'synthetic-extensions', type: 'sgv', sgv: 123,
      'vendor-field': { '測定': [true, null, 2.5, 'synthetic'] }, '測定': 'synthetic'
    });
    assert.equal(response.status, 201);
    await admin.query("DELETE FROM credential_data.entries WHERE identifier = 'extension-synthetic-entry'");
  });

  describe('actual entries POST mutations', function () {
      const doc = (identifier = 'mutation-entry', extra = {}) => ({
        identifier, date: 1793664000000, utcOffset: 0, app: 'synthetic-mutations', type: 'sgv', sgv: 123, ...extra
      });
      const post = (body, worker = 0, tenant = A, headers = secret(hash(roots[tenant === A ? 0 : 1]))) =>
        http(worker, tenant, headers, 'post', '/api/v3/entries').send(body);
      async function permissions (values, tenant = A) {
        await admin.query(`UPDATE credential_auth.tenant_authorization_roles SET permissions = $1
          WHERE tenant_id = $2 AND name = 'viewer'`, [values, tenant]);
      }
      afterEach(async function () {
        await admin.query("DELETE FROM credential_data.entries WHERE identifier LIKE 'mutation-%'");
        for (const tenant of [A, B]) await permissions(['api:entries:read'], tenant);
        for (const worker of workers) {
          worker.events.length = 0;
          for (const tenant of [A, B]) {
            worker.environments.get(tenant).write = {};
            const collection = worker.collections.get(tenant);
            collection.autoPruneDays = undefined;
            collection.nextAutoPrune = new Date();
          }
        }
      });

      for (const key of ['vendor-field', '測定', 'unknown_ordinary']) {
        it(`differentiates literal ${key} insert/replacement/merge/unset through actual Mongo and PG HTTP`, async function () {
          const mongo = new MongoClient(process.env.CUSTOMCONNSTR_mongo);
          await mongo.connect();
          const name = 'mutation_reference_' + crypto.randomBytes(8).toString('hex');
          const env = {};
          const app = express();
          app.set('API3_DEDUP_FALLBACK_ENABLED', true);
          app.setENVTruthy = () => undefined;
          app.use(...require('../lib/api3/shared/jsonParser')());
          app.use((req, res, next) => scope.withTenant(A, next));
          app.use((req, res, next) => {
            const grants = shiro.new();
            grants.add('api:entries:create');
            grants.add('api:entries:update');
            authentication.bind(req, { shiros: [grants] });
            next();
          });
          const bus = new EventEmitter(), mongoEvents = [];
          for (const event of ['storage-intent-committed', 'storage-socket-create', 'storage-socket-update', 'data-received']) {
            bus.on(event, value => mongoEvents.push({ event, value }));
          }
          new Api3Collection({
            ctx: { store: { db: mongo.db(), collection: n => mongo.db().collection(n), ensureIndexes () {} },
              bus, purifier: purifier({}, {}) },
            env, app, colName: 'entries', storageColName: name,
            dedupFallbackFields: ['date', 'type'], fallbackDateField: 'date'
          }).mapRoutes();
          const next = srvDates.next;
          srvDates.next = () => 1793664999000;
          try {
            const pgEnv = workers[0].environments.get(A);
            const bBefore = (await rows()).filter(row => row.tenant_id === B);
            const sequence = [
              doc('mutation-literal', { [key]: { 'nested-field': 1, '測定': [true, null, 2.5] }, keep: 'first' }),
              doc('mutation-literal', { [key]: { 'nested-field': 2 } }),
              doc('mutation-literal', { [key]: { '測定': [null, false] }, keep: 'retained' }),
              doc('mutation-literal', { [key]: { 'nested-field': null } }),
              doc('mutation-literal', { [key]: null })
            ];
            for (const [index, body] of sequence.entries()) {
              if (index === 2) {
                env.write = { resend: 'merge-except-treatments' };
                pgEnv.write = { resend: 'merge-except-treatments' };
              }
              mongoEvents.length = 0;
              workers[0].events.length = 0;
              const reference = await request(app).post('/entries').send(body);
              const actual = await post(body);
              assert.equal(actual.status, index === 0 ? 201 : 200);
              assert.deepEqual(actual.body, reference.body);
              for (const header of ['location', 'last-modified']) assert.equal(actual.headers[header], reference.headers[header]);
              const expected = await mongo.db().collection(name).findOne({});
              const stored = (await admin.query(`SELECT doc FROM credential_data.entries
                WHERE tenant_id = $1 AND identifier = 'mutation-literal'`, [A])).rows[0].doc;
              const withoutIdentity = value => {
                const copy = { ...value };
                delete copy._id;
                return copy;
              };
              assert.deepEqual(withoutIdentity(stored), withoutIdentity(expected));
              assert.deepEqual(workers[0].events.map(event => event.event), mongoEvents.map(event => event.event));
              assert.deepEqual((await rows()).filter(row => row.tenant_id === B), bBefore);
            }
          } finally {
            srvDates.next = next;
            await mongo.db().collection(name).drop();
            await mongo.close();
          }
        });
      }

      it('uses exact stored-identity branch grants, current names and cross-pool revocation, never anonymous writes', async function () {
        const issued = (await exchange(subjectTokens[0]).expect(200)).body.token;
        const headers = bearer(issued);
        await permissions(['api:entries:create']);
        const principal = { kind: 'subject', subjectId: SUBJECT };
        const originalName = (await workers[0].authority.subjectSnapshot({ tenant: A, principal })).sub;
        const currentName = originalName + ' Changed';
        await admin.query(`UPDATE credential_auth.tenant_authorization_subjects SET display_name = $3
          WHERE tenant_id = $1 AND subject_id = $2`, [A, SUBJECT, currentName]);
        try { await post(doc(), 0, A, headers).expect(201); }
        finally {
          await admin.query(`UPDATE credential_auth.tenant_authorization_subjects SET display_name = $3
            WHERE tenant_id = $1 AND subject_id = $2`, [A, SUBJECT, originalName]);
        }
        const created = (await rows()).find(row => row.doc.identifier === 'mutation-entry').doc;
        assert.equal(created.subject, currentName);
        await post(doc('mutation-entry', { sgv: 124 }), 1, A, headers).expect(403);
        await permissions(['api:entries:update']);
        await post(doc('mutation-new'), 1, A, headers).expect(403);
        await post(doc('mutation-entry', { sgv: 124 }), 1, A, headers).expect(200);
        await permissions(['api:entries:read']);
        await post(doc('mutation-entry', { sgv: 125 }), 0, A, headers).expect(403);
        const stored = (await rows()).find(row => row.doc.identifier === 'mutation-entry').doc;
        assert.equal(stored.sgv, 124);
        await post(doc(), 0, B, headers).expect(401);
        await post(doc(), 0, A, secret('invalid')).expect(401);
        await post(doc(), 0, A, {}).expect(403);
        for (const method of ['put', 'patch', 'delete']) await http(0, A, headers, method).send(doc()).expect(405);
        await http(0, A, headers, 'get', '/api/v3/entries/history').expect(405);
      });

      it('refuses the next legacy-carrier POST on another worker after persisted write revocation', async function () {
        await permissions(['api:entries:create', 'api:entries:update']);
        await post(doc(), 0, A, secret(subjectTokens[0])).expect(201);
        const before = await rows();
        await permissions(['api:entries:read']);
        await post(doc('mutation-entry', { sgv: 129 }), 1, A, secret(subjectTokens[0])).expect(403);
        await post(doc('mutation-new'), 1, A, secret(subjectTokens[0])).expect(403);
        assert.deepEqual(await rows(), before);
      });

      it('keeps the shipping data parser, purifier and computed-identifier resend above the owner body limit', async function () {
        const input = doc('mutation-computed', { notes: '<synthetic>text</synthetic>', padding: 'x'.repeat(70 * 1024) });
        delete input.identifier;
        const created = await post(input).expect(201);
        const identifier = created.body.identifier;
        assert.equal(typeof identifier, 'string');
        const stored = (await rows()).find(row => row.tenant_id === A && row.doc.identifier === identifier).doc;
        assert.equal(stored.padding.length, 70 * 1024);
        assert.equal(stored.notes, 'text');
        await post(input).expect(200);
        const before = await rows();
        await http(0, A, secret(hash(roots[0])), 'post', '/api/v3/entries').type('json').send('{').expect(500);
        assert.deepEqual(await rows(), before);
        await admin.query('DELETE FROM credential_data.entries WHERE tenant_id = $1 AND identifier = $2', [A, identifier]);
      });

      it('requires current display metadata only for subject POST and distinguishes metadata outage', async function () {
        await permissions(['api:entries:read', 'api:entries:create']);
        const before = await workers[0].authority.subjectSnapshot({ tenant: A, principal: { kind: 'subject', subjectId: SUBJECT } });
        await admin.query(`UPDATE credential_auth.tenant_authorization_subjects SET display_name = NULL
          WHERE tenant_id = $1 AND subject_id = $2`, [A, SUBJECT]);
        try {
          await post(doc(), 1, A, bearer(jwt[0])).expect(401);
          await http(1, A, bearer(jwt[0])).expect(200);
          await admin.query(`REVOKE SELECT ON credential_auth.tenant_authorization_subjects FROM ${role}`);
          try { await post(doc(), 1, A, bearer(jwt[0])).expect(503); }
          finally { await admin.query(`GRANT SELECT ON credential_auth.tenant_authorization_subjects TO ${role}`); }
        } finally {
          await admin.query(`UPDATE credential_auth.tenant_authorization_subjects SET display_name = $3
            WHERE tenant_id = $1 AND subject_id = $2`, [A, SUBJECT, before.sub]);
        }
      });

      it('separates invalid JSON representation, immutable identity, unavailable storage and internal stored shapes', async function () {
        const before = await rows();
        for (const fields of [{ 'dot.path': 1 }, { '$operator': 1 }, { 'nul\0key': 1 }, { value: 'nul\0value' },
          { nested: { value: 'nul\0value' } }, { value: '\ud800' }, { '\ud800': 1 }]) {
          await post(doc('mutation-refused', fields)).expect(400);
        }
        await post(doc('mutation-refused', { _id: 'client-id' })).expect(400);
        assert.deepEqual(await rows(), before);
        await admin.query(`REVOKE INSERT ON credential_data.entries FROM ${role}`);
        try { await post(doc()).expect(503); }
        finally { await admin.query(`GRANT INSERT ON credential_data.entries TO ${role}`); }
        const storage = workers[0].collections.get(A).storage;
        const original = storage.findOneFilter;
        storage.findOneFilter = async () => { throw Object.assign(new TypeError('synthetic stored shape'), { unsupported: true }); };
        try { await post(doc()).expect(500); }
        finally { storage.findOneFilter = original; }
        assert.deepEqual(await rows(), before);
      });

      it('keeps acknowledgement/refusal/deleted responses branch-sensitive and emits exactly one intent without mutation notifications', async function () {
        await post(doc()).expect(201);
        const stored = (await rows()).find(row => row.doc.identifier === 'mutation-entry').doc;
        const env = workers[0].environments.get(A);
        for (const [mode, status] of [['acknowledge', 200], ['refuse', 409]]) {
          env.write = { resend: mode };
          await permissions(['api:entries:create']);
          await post(doc(), 0, A, bearer(jwt[0])).expect(403);
          await permissions(['api:entries:update']);
          workers[0].events.length = 0;
          await post(doc(), 0, A, bearer(jwt[0])).expect(status);
          assert.deepEqual(workers[0].events.map(event => event.event), ['storage-intent-committed']);
          assert.deepEqual((await rows()).find(row => row.doc.identifier === 'mutation-entry').doc, stored);
        }
        await admin.query(`UPDATE credential_data.entries SET doc = doc || '{"isValid":false}'::jsonb
          WHERE tenant_id = $1 AND identifier = 'mutation-entry'`, [A]);
        workers[0].events.length = 0;
        const acknowledged = await post(doc(), 0, A, bearer(jwt[0])).expect(200);
        assert.equal(acknowledged.body.lastModified, stored.srvModified);
        assert.equal(acknowledged.body.isDeduplication, true);
        assert.deepEqual(workers[0].events.map(event => event.event), ['storage-intent-committed']);
        assert.equal((await rows()).find(row => row.doc.identifier === 'mutation-entry').doc.isValid, false);
      });

      it('preserves configured per-tenant retention without requiring the uploader delete permission', async function () {
        for (const tenant of [A, B]) {
          await permissions(['api:entries:create'], tenant);
          const collection = workers[0].collections.get(tenant);
          collection.autoPruneDays = '30';
          collection.nextAutoPrune = new Date(0);
          await workers[0].connection.withTenant(tenant, () => writer({
            connection: workers[0].connection, table: 'credential_data.entries'
          }).insertOne(doc('mutation-old', { date: Date.now() - 40 * 86400000, srvCreated: Date.now() })));
        }
        workers[0].events.length = 0;
        for (const [index, tenant] of [A, B].entries()) {
          await post(doc(), 0, tenant, bearer(jwt[index])).expect(201);
          const deadline = Date.now() + 5000;
          while (!workers[0].events.some(event => event.tenant === tenant &&
            event.event === 'storage-intent-committed' && event.value.op === 'prune')) {
            assert.ok(Date.now() < deadline, 'tenant prune must finish');
            await delay(10);
          }
          assert.equal((await rows()).filter(row => row.tenant_id === tenant && row.doc.identifier === 'mutation-old').length, 0);
          if (tenant === A) {
            assert.equal((await rows()).filter(row => row.tenant_id === B && row.doc.identifier === 'mutation-old').length, 1);
          }
        }
        assert.notEqual(workers[0].collections.get(A), workers[0].collections.get(B));
        assert.ok(workers[0].collections.get(A).nextAutoPrune > new Date(Date.now() + 3500000));
        assert.ok(workers[0].collections.get(B).nextAutoPrune > new Date(Date.now() + 3500000));
      });

      it('answers and emits only after commit and emits nothing on a rolled-back mutation', async function () {
        const connection = workers[0].connection;
        const transaction = connection.transaction;
        workers[0].events.length = 0;
        connection.transaction = fn => transaction(async () => {
          await fn();
          throw new Error('synthetic rollback before commit');
        });
        try {
          await post(doc()).expect(500);
          assert.equal((await rows()).some(row => row.doc.identifier === 'mutation-entry'), false);
          assert.deepEqual(workers[0].events, []);
        } finally { connection.transaction = transaction; }
        let committed = false;
        connection.transaction = async fn => {
          const result = await transaction(fn);
          assert.ok((await rows()).some(row => row.doc.identifier === 'mutation-entry'));
          assert.deepEqual(workers[0].events, []);
          committed = true;
          return result;
        };
        try {
          await post(doc()).expect(201);
          assert.equal(committed, true);
          assert.deepEqual(workers[0].events.map(event => event.event),
            ['storage-intent-committed', 'storage-socket-create', 'data-received']);
        } finally { connection.transaction = transaction; }
      });

      for (const canUpdate of [false, true]) {
        it(`matches actual Mongo identifier-insert race outcomes with update permission ${canUpdate}`, async function () {
          const mongo = new MongoClient(process.env.CUSTOMCONNSTR_mongo);
          await mongo.connect();
          const name = 'mutation_race_' + crypto.randomBytes(8).toString('hex');
          await mongo.db().collection(name).createIndex({ identifier: 1 }, { name: 'identifier_unique', unique: true });
          const permissionsList = ['api:entries:create', ...(canUpdate ? ['api:entries:update'] : [])];
          await permissions(permissionsList);
          const app = express(), bus = new EventEmitter(), referenceEvents = [];
          app.setENVTruthy = () => undefined;
          app.use(...require('../lib/api3/shared/jsonParser')());
          app.use((req, res, next) => scope.withTenant(A, next));
          app.use((req, res, next) => {
            const grants = shiro.new();
            for (const permission of permissionsList) grants.add(permission);
            authentication.bind(req, { shiros: [grants], subject: { name: 'Synthetic Race' } });
            next();
          });
          for (const event of ['storage-intent-committed', 'storage-socket-create', 'storage-socket-update', 'data-received']) {
            bus.on(event, () => referenceEvents.push(event));
          }
          const collection = new Api3Collection({
            ctx: { store: { db: mongo.db(), collection: n => mongo.db().collection(n), ensureIndexes () {} },
              bus, purifier: purifier({}, {}) },
            env: {}, app, colName: 'entries', storageColName: name
          });
          collection.mapRoutes();
          function synchronize (storages) {
            let arrived = 0, release;
            const ready = new Promise(resolve => { release = resolve; });
            return storages.map(storage => {
              const original = storage.findOneFilter;
              let initial = true;
              storage.findOneFilter = async (...args) => {
                const result = await original(...args);
                if (initial) {
                  initial = false;
                  if (++arrived === 2) release();
                  await ready;
                }
                return result;
              };
              return () => { storage.findOneFilter = original; };
            });
          }
          // One reference adapter serves two concurrent operations.
          const original = collection.storage.findOneFilter;
          let arrived = 0, release;
          const ready = new Promise(resolve => { release = resolve; });
          collection.storage.findOneFilter = async (...args) => {
            const result = await original(...args);
            if (arrived < 2) {
              if (++arrived === 2) release();
              await ready;
            }
            return result;
          };
          const restores = synchronize(workers.map(worker => worker.collections.get(A).storage));
          workers.forEach(worker => { worker.events.length = 0; });
          try {
            const reference = await Promise.all([0, 1].map(() => request(app).post('/entries').send(doc('mutation-race'))));
            const actual = await Promise.all([0, 1].map(worker => post(doc('mutation-race'), worker, A, bearer(jwt[0]))));
            const statuses = replies => replies.map(reply => reply.status).sort();
            assert.deepEqual(statuses(actual), statuses(reference));
            assert.deepEqual(statuses(actual), canUpdate ? [200, 201] : [201, 500]);
            assert.equal((await rows()).filter(row => row.tenant_id === A && row.doc.identifier === 'mutation-race').length, 1);
            assert.equal(await mongo.db().collection(name).countDocuments(), 1);
            assert.deepEqual(workers.flatMap(worker => worker.events.map(event => event.event)).sort(), referenceEvents.sort());
          } finally {
            restores.forEach(restore => restore());
            await mongo.db().collection(name).drop();
            await mongo.close();
          }
        });
      }
    });
  it('exchanges persisted own-tenant subjects into canonical eight-hour JWTs for actual GET, not root exchange', async function () {
    const before = await rows();
    for (const [tenant, index] of [[A, 0], [B, 1]]) {
      const digest = hash(hash(roots[index]) + SUBJECT);
      for (const credential of [subjectTokens[index], digest, digest.slice(0, 16),
        hash(subjectTokens[index]), hash(subjectTokens[index]).slice(0, 16),
        'alternate-prefix-' + digest.slice(0, 16), jwt[index]]) {
        const response = await exchange(credential, index, tenant, { Authorization: 'Bearer' }).expect(200);
        assert.deepEqual(Object.keys(response.body).sort(), ['exp', 'iat', 'permissionGroups', 'sub', 'token']);
        assert.equal(response.body.sub, 'Same Viewer Exact ' + (index === 0 ? 'A' : 'B'));
        assert.deepEqual(response.body.permissionGroups, [['api:entries:read'], []]);
        assert.equal(response.body.iat, Math.floor(time / 1000));
        assert.equal(response.body.exp - response.body.iat, 28800);
        const decoded = await workers[1 - index].secrets.verifyJWT(ctx(tenant), response.body.token);
        assert.deepEqual(Object.keys(decoded).sort(), ['accessToken', 'aud', 'exp', 'iat']);
        assert.equal(decoded.accessToken, subjectTokens[index]);
        assert.equal(decoded.aud, tenant);
        await http(1 - index, tenant, bearer(response.body.token)).expect(200);
        await http(index, tenant === A ? B : A, bearer(response.body.token)).expect(401);
        await exchange(response.body.token, 1 - index, tenant === A ? B : A).expect(401);
      }
      for (const credential of [roots[index], hash(roots[index]),
        crypto.createHash('sha512').update(roots[index]).digest('hex')]) {
        const denied = await exchange(credential, index, tenant).expect(401);
        assert.deepEqual(denied.body, { status: 401, message: 'Unauthorized', description: 'Invalid/Missing' });
      }
      await exchange(subjectTokens[1 - index], index, tenant).expect(401);
      const issued = (await exchange(subjectTokens[index], index, tenant).expect(200)).body.token;
      await http(index, tenant, bearer(issued), 'get', '/api/v1/tenant/settings').expect(401);
      await http(index, tenant, bearer(issued), 'post', '/api/v3/entries').expect(403);
    }
    await exchange('invalid', 0, A, { 'api-secret': subjectTokens[0] }).expect(401);
    await exchange('invalid').query({ token: subjectTokens[0], secret: hash(roots[0]) })
      .send({ token: subjectTokens[0], secret: hash(roots[0]) }).expect(401);
    await exchange(subjectTokens[0], 1, A, { Authorization: 'Basic ignored' })
      .query({ token: 'ignored' }).send({ token: 'ignored' }).expect(200);
    await exchange(subjectTokens[0], 0, 'unknown').expect(404);
    await exchange(subjectTokens[0]).set('X-Resolved-Tenant', B).expect(400);
    await http(0, A, {}, 'get', '/api/v2/authorization/request?token=' + subjectTokens[0]).expect(404);
    await http(0, A, {}, 'post', '/api/v2/authorization/request/' + subjectTokens[0]).expect(404);
    assert.deepEqual(await rows(), before);
  });

  it('reads current names and grants across pools, refuses incomplete imports and applies revocation to issued JWT GET', async function () {
    const issued = (await exchange(subjectTokens[0]).expect(200)).body.token;
    const parts = issued.split('.');
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    claims.exp++;
    const input = parts[0] + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url');
    const overlong = input + '.' + (await providers[0].sign(Buffer.from(input))).toString('base64url');
    await exchange(overlong, 1).expect(401);
    await http(1, A, bearer(overlong)).expect(401);
    await admin.query(`UPDATE credential_auth.tenant_authorization_subjects SET display_name = NULL
      WHERE tenant_id = $1 AND subject_id = $2`, [A, SUBJECT]);
    try {
      await exchange(subjectTokens[0], 1).expect(401);
    } finally {
      await admin.query(`UPDATE credential_auth.tenant_authorization_subjects SET display_name = 'Same Viewer Renamed'
        WHERE tenant_id = $1 AND subject_id = $2`, [A, SUBJECT]);
    }
    const renamed = await exchange(issued, 1).expect(200);
    assert.equal(renamed.body.sub, 'Same Viewer Renamed');
    await admin.query('BEGIN');
    try {
      await admin.query(`UPDATE credential_auth.tenant_authorization_subjects SET display_name = 'New Display Exact'
        WHERE tenant_id = $1 AND subject_id = $2`, [A, SUBJECT]);
      await admin.query(`UPDATE credential_identity.legacy_credential_subjects SET token_prefix = 'newdisplay'
        WHERE tenant_id = $1 AND subject_id = $2`, [A, SUBJECT]);
      await admin.query('COMMIT');
      const current = await exchange(issued, 1).expect(200);
      assert.equal(current.body.sub, 'New Display Exact');
      assert.equal((await workers[1].secrets.verifyJWT(ctx(A), current.body.token)).accessToken,
        'newdisplay-' + hash(hash(roots[0]) + SUBJECT).slice(0, 16));
      await http(0, A, bearer(current.body.token)).expect(200);
    } finally {
      await admin.query(`UPDATE credential_identity.legacy_credential_subjects SET token_prefix = 'sameviewer'
        WHERE tenant_id = $1 AND subject_id = $2`, [A, SUBJECT]);
    }
    await admin.query(`DELETE FROM credential_auth.tenant_authorization_subject_roles
      WHERE tenant_id = $1 AND subject_id = $2`, [A, SUBJECT]);
    try {
      const response = await exchange(issued, 1).expect(200);
      assert.deepEqual(response.body.permissionGroups, [[]]);
      await http(1, A, bearer(response.body.token)).expect(403);
      await http(0, A, bearer(issued)).expect(403);
    } finally {
      await admin.query(`INSERT INTO credential_auth.tenant_authorization_subject_roles VALUES ($1, $2, 'viewer')`,
        [A, SUBJECT]);
    }
    await http(1, A, bearer(issued)).expect(200);
    await admin.query(`UPDATE credential_auth.tenant_authorization_roles SET permissions = ARRAY['api:profile:read']
      WHERE tenant_id = $1 AND name = 'viewer'`, [A]);
    try {
      const response = await exchange(issued, 1).expect(200);
      assert.deepEqual(response.body.permissionGroups, [['api:profile:read'], []]);
      await http(1, A, bearer(issued)).expect(403);
    } finally {
      await admin.query(`UPDATE credential_auth.tenant_authorization_roles SET permissions = ARRAY['api:entries:read']
        WHERE tenant_id = $1 AND name = 'viewer'`, [A]);
    }
    await admin.query(`DELETE FROM credential_identity.legacy_credential_subjects WHERE tenant_id = $1 AND subject_id = $2`,
      [A, SUBJECT]);
    try {
      await exchange(issued, 1).expect(401);
      await http(1, A, bearer(issued)).expect(401);
    } finally {
      await admin.query(`INSERT INTO credential_identity.legacy_credential_subjects VALUES ($1, $2, 'sameviewer')`,
        [A, SUBJECT]);
    }
    await http(1, A, bearer(issued)).expect(200);
    await admin.query(`DELETE FROM credential_auth.tenant_authorization_subject_roles
      WHERE tenant_id = $1 AND subject_id = $2`, [A, SUBJECT]);
    await admin.query(`DELETE FROM credential_auth.tenant_authorization_subjects
      WHERE tenant_id = $1 AND subject_id = $2`, [A, SUBJECT]);
    try {
      await exchange(issued, 1).expect(401);
      await http(1, A, bearer(issued)).expect(403);
    } finally {
      await admin.query(`INSERT INTO credential_auth.tenant_authorization_subjects VALUES ($1, $2, 'Same Viewer Exact A')`,
        [A, SUBJECT]);
      await admin.query(`INSERT INTO credential_auth.tenant_authorization_subject_roles VALUES ($1, $2, 'viewer')`,
        [A, SUBJECT]);
    }
    await exchange(issued, 1).expect(200);
  });

  it('keeps exchange invalid-token refusal distinct from anonymous policies and enforces expiry and eight-hour bounds', async function () {
    for (const mode of ['denied', 'readable', 'status-only']) {
      await admin.query(`UPDATE credential_auth.tenant_authorization_config SET anonymous_roles = ARRAY[$1]
        WHERE tenant_id = $2`, [mode, A]);
      try {
        const response = await exchange(subjectTokens[0], 1).expect(200);
        assert.deepEqual(response.body.permissionGroups, [['api:entries:read'],
          mode === 'readable' ? ['*:*:read'] : mode === 'status-only' ? ['api:status:read'] : []]);
        await http(0, A).expect(mode === 'readable' ? 200 : 403);
        for (const value of ['invalid', 'null', await workers[0].secrets.signJWT(ctx(A, 'issuer'), 'unknown', 60)]) {
          await exchange(value, 1).expect(401);
        }
        await http(0, A, { Authorization: 'Bearer' }).expect(401);
      } finally {
        await admin.query(`UPDATE credential_auth.tenant_authorization_config SET anonymous_roles = ARRAY['denied']
          WHERE tenant_id = $1`, [A]);
      }
    }
    const issued = (await exchange(subjectTokens[0]).expect(200)).body.token;
    const previous = time;
    try {
      time += 28800000;
      await exchange(issued, 1).expect(401);
      await http(1, A, bearer(issued)).expect(401);
    } finally {
      time = previous;
    }
    await assert.rejects(workers[0].secrets.signJWT(ctx(A, 'issuer'), subjectTokens[0], 28801),
      { code: 'SECRETS_TOKEN_LIFETIME' });
    await exchange(subjectTokens[0], 1).expect(200);
  });

  it('fails exchange closed during signing, durable-audit, credential metadata and current authority outages', async function () {
    signingUnavailable = true;
    try {
      const response = await exchange(subjectTokens[0]).expect(503);
      assert.deepEqual(response.body, { error: 'AUTHORITY_UNAVAILABLE' });
    } finally {
      signingUnavailable = false;
    }
    for (const [privilege, table] of [
      ['INSERT', 'credential_secrets.secret_audit'],
      ['SELECT', 'credential_identity.legacy_credential_subjects'],
      ['SELECT', 'credential_auth.tenant_authorization_subjects'],
      ['SELECT', 'credential_auth.tenant_authorization_roles']
    ]) {
      await admin.query(`REVOKE ${privilege} ON ${table} FROM ${role}`);
      try {
        assert.deepEqual((await exchange(subjectTokens[0], 1).expect(503)).body, { error: 'AUTHORITY_UNAVAILABLE' });
      } finally {
        await admin.query(`GRANT ${privilege} ON ${table} TO ${role}`);
      }
      const response = await exchange(subjectTokens[0], 1).expect(200);
      await http(0, A, bearer(response.body.token)).expect(200);
    }
  });

  after(async function () {
    try {
      for (const worker of workers) {
        if (worker.server) await new Promise(resolve => worker.server.close(resolve));
        if (worker.connection) await worker.connection.end();
        if (worker.legacy) await worker.legacy.close();
        if (worker.authority) await worker.authority.close();
        if (worker.persistence) await worker.persistence.close();
      }
      if (admin) await admin.end();
    } finally {
      scope.setTenancyMode(previousMode);
      if (owned) docker(['rm', '-f', container]);
    }
  });

  it('serves actual GET from both pooled workers with overlapping IDs and same token presentation prefix', async function () {
    for (const [worker, tenant, index] of [[0, A, 0], [1, B, 1], [1, A, 0], [0, B, 1]]) {
      const response = await http(worker, tenant, bearer(jwt[index])).expect(200);
      assert.equal(response.body.result.sgv, index === 0 ? 101 : 202);
      assert.equal(response.body.result.identifier, 'shared-entry');
      await http(worker, tenant, secret(subjectTokens[index])).expect(200);
      await http(worker, tenant, secret(hash(subjectTokens[index]))).expect(200);
    }
    const conditional = await http(0, A, bearer(jwt[0]))
      .set('If-Modified-Since', new Date(1793664000000).toUTCString()).expect(304);
    assert.equal(conditional.text, '');
    await http(1, A, { Authorization: 'bearer ' + jwt[0] }).expect(200);
    assert.equal((await rows()).length, 2);
  });

  it('serves the shipping API3 entries search through current tenant authority', async function () {
    const baseDate = 1793664000000;
    for (const [tenant, offset] of [[A, 0], [B, 100]]) {
      await workers[0].connection.withTenant(tenant, async () => {
        const insert = writer({ connection: workers[0].connection, table: 'credential_data.entries' });
        for (const [label, delta, isValid] of [
          ['search-low', 10, true], ['search-mid', 20, undefined],
          ['search-high', 30, true], ['search-invalid', 40, false]
        ]) {
          await insert.insertOne({
            _id: label, identifier: label, sgv: 110 + offset + delta,
            date: baseDate + delta, srvModified: baseDate + delta, type: 'sgv',
            ...(isValid === undefined ? {} : { isValid })
          }, { normalize: false });
        }
      });
    }
    const afterSeed = await rows();
    const searchTokens = await Promise.all([A, B].map((tenant, index) =>
      exchange(subjectTokens[index], index, tenant).expect(200)));
    const tokens = searchTokens.map(response => response.body.token);

    function search (worker, tenant, headers = {}, query = {}, path = '/api/v3/entries') {
      let call = request(workers[worker].server).get(path)
        .set('Host', tenant === A ? 'one.example.test' : 'two.example.test')
        .timeout({ response: 5000, deadline: 15000 });
      for (const [key, value] of Object.entries(headers)) call = call.set(key, value);
      return call.query(query);
    }

    const query = { 'sgv$gte': '120', sort: 'date', limit: '1', skip: '1', fields: 'sgv' };
    for (const [worker, tenant, expected] of [[0, A, 130], [1, B, 220]]) {
      const response = await search(worker, tenant, bearer(tokens[tenant === A ? 0 : 1]), query).expect(200);
      assert.deepEqual(response.body.result, [{ sgv: expected }]);
      assert.equal(response.headers['cache-control'], 'no-store');
    }

    await search(1, B, bearer(tokens[0]), query).expect(401);
    const isolated = await search(1, B, bearer(tokens[1]), { 'sgv$eq': '130', limit: '1' }).expect(200);
    assert.deepEqual(isolated.body.result, []);
    await search(0, A, {}, query).expect(403);
    await search(0, A, secret(hash(roots[0])), query).expect(200);
    await search(0, A, { 'api-secret': 'invalid' }, query).expect(401);

    await admin.query(`UPDATE credential_auth.tenant_authorization_config
      SET anonymous_roles = ARRAY['readable'] WHERE tenant_id = $1`, [A]);
    try {
      await search(0, A, {}, query).expect(200);
      await admin.query(`UPDATE credential_auth.tenant_authorization_config
        SET anonymous_roles = ARRAY['status-only'] WHERE tenant_id = $1`, [A]);
      await search(1, A, {}, query).expect(403);
    } finally {
      await admin.query(`UPDATE credential_auth.tenant_authorization_config
        SET anonymous_roles = ARRAY['denied'] WHERE tenant_id = $1`, [A]);
    }

    await admin.query(`DELETE FROM credential_auth.tenant_authorization_subject_roles
      WHERE tenant_id = $1 AND subject_id = $2`, [A, SUBJECT]);
    try {
      await search(1, A, bearer(tokens[0]), query).expect(403);
    } finally {
      await admin.query(`INSERT INTO credential_auth.tenant_authorization_subject_roles
        VALUES ($1, $2, 'viewer')`, [A, SUBJECT]);
    }

    await search(0, A, bearer(tokens[0]), query).expect(200);
    await search(1, A, bearer(tokens[0]), {}, '/api/v3/entries/history').expect(405);
    await search(1, A, bearer(tokens[0]), {}, '/api/v3/entries/history/1793664000000').expect(405);
    await search(1, A, bearer(jwt[0]), { 'sgv$re': '.*' }).expect(500);
    await search(1, A, bearer(jwt[0]), { limit: '1' }).expect(200);

    await admin.query(`REVOKE SELECT ON credential_data.entries FROM ${role}`);
    try {
      await search(1, A, bearer(tokens[0]), query).expect(500);
    } finally {
      await admin.query(`GRANT SELECT ON credential_data.entries TO ${role}`);
    }
    await search(1, A, bearer(tokens[0]), query).expect(200);
    assert.deepEqual(await rows(), afterSeed);
  });

  it('rechecks revoked API3 search authority across independently pooled workers', async function () {
    const issued = (await exchange(subjectTokens[0], 0, A).expect(200)).body.token;
    const query = { limit: '1' };
    const before = await searchForAuthority(0, A, bearer(issued), query).expect(200);
    assert.equal(before.body.result.length, 1);
    await admin.query(`DELETE FROM credential_auth.tenant_authorization_subject_roles
      WHERE tenant_id = $1 AND subject_id = $2`, [A, SUBJECT]);
    try {
      await searchForAuthority(1, A, bearer(issued), query).expect(403);
    } finally {
      await admin.query(`INSERT INTO credential_auth.tenant_authorization_subject_roles
        VALUES ($1, $2, 'viewer')`, [A, SUBJECT]);
    }

    function searchForAuthority (worker, tenant, headers, query) {
      return request(workers[worker].server).get('/api/v3/entries')
        .set('Host', tenant === A ? 'one.example.test' : 'two.example.test')
        .set('Authorization', headers.Authorization)
        .query(query)
        .timeout({ response: 5000, deadline: 15000 });
    }
  });

  it('verifies root without returning its material and keeps uploader distinct', async function () {
    for (const [index, tenant] of [A, B].entries()) {
      await http(index, tenant, secret(hash(roots[index]))).expect(200);
      const uploader = 'sameviewer-' + hash(hash(roots[index]) + OTHER).slice(0, 16);
      await http(index, tenant, secret(uploader)).expect(403);
      await http(index, tenant, secret(hash(roots[1 - index]))).expect(401);
      const verified = await workers[index].secrets.verifyLegacyCredential(ctx(tenant),
        { apiSecret: hash(roots[index]) });
      assert.deepEqual(verified, { kind: 'root' });
    }
  });

  it('refuses foreign, unknown, malformed and expired JWT credentials, never falling back to readable anonymous', async function () {
    await admin.query(`UPDATE credential_auth.tenant_authorization_config SET anonymous_roles = ARRAY['readable']`);
    try {
      for (const [tenant, index] of [[A, 0], [B, 1]]) {
        await http(0, tenant, bearer(jwt[1 - index])).expect(401);
        await http(0, tenant, secret(subjectTokens[1 - index])).expect(401);
        for (const token of ['malformed', await workers[0].secrets.signJWT(ctx(tenant, 'issuer'), 'root', 30)]) {
          await http(1, tenant, bearer(token)).expect(401);
        }
        await http(0, tenant, secret('')).expect(401);
        const expired = await workers[0].secrets.signJWT(ctx(tenant, 'issuer'), subjectTokens[index], 1);
        time += 1000;
        await http(1, tenant, bearer(expired)).expect(401);
      }
      await http(0, 'unknown', bearer(jwt[0])).expect(404);
      await http(0, A, { Authorization: 'Basic invalid' }).expect(401);
      await http(0, A, {}, 'get', '/api/v3/entries/shared-entry?token=invalid').expect(401);
      await http(0, A, {}, 'get', '/api/v3/entries/shared-entry?secret=invalid').expect(401);
      await http(0, A, bearer(jwt[0])).set('X-Resolved-Tenant', B).expect(400);
    } finally {
      await admin.query(`UPDATE credential_auth.tenant_authorization_config SET anonymous_roles = ARRAY['denied']`);
    }
  });

  it('applies anonymous denied/readable/status-only and subject/default union without enabling writes or owner access', async function () {
    const before = await rows();
    for (const [policy, status] of [['denied', 403], ['readable', 200], ['status-only', 403]]) {
      await admin.query(`UPDATE credential_auth.tenant_authorization_config SET anonymous_roles = ARRAY[$1]
        WHERE tenant_id = $2`, [policy, A]);
      await http(0, A).expect(status);
      await http(1, A).expect(status);
      if (policy === 'readable') {
        const uploader = 'sameviewer-' + hash(hash(roots[0]) + OTHER).slice(0, 16);
        await http(1, A, secret(uploader)).expect(200);
      }
      await http(0, A, {}, 'post', '/api/v3/entries').expect(403);
      for (const method of ['post', 'put', 'patch', 'delete']) {
        await http(0, A, {}, method).expect(405);
      }
      await http(0, A, {}, 'get', '/api/v1/tenant/settings').expect(401);
      await http(0, A, secret(hash(roots[0])), 'get', '/api/v1/tenant/settings').expect(401);
      await http(0, A, {}, 'get', '/api/v3/status').expect(405);
    }
    await admin.query(`UPDATE credential_auth.tenant_authorization_config SET anonymous_roles = ARRAY['denied']`);
    assert.deepEqual(await rows(), before);
  });

  it('observes committed grant removal and policy changes across independently pooled workers', async function () {
    await http(0, A, bearer(jwt[0])).expect(200);
    await http(1, A, bearer(jwt[0])).expect(200);
    await admin.query(`DELETE FROM credential_auth.tenant_authorization_subject_roles WHERE tenant_id = $1 AND subject_id = $2`,
      [A, SUBJECT]);
    await http(1, A, bearer(jwt[0])).expect(403);
    await http(0, A, bearer(jwt[0])).expect(403);
    await admin.query(`INSERT INTO credential_auth.tenant_authorization_subject_roles VALUES ($1, $2, 'viewer')`, [A, SUBJECT]);
    await http(1, A, bearer(jwt[0])).expect(200);
    await admin.query(`UPDATE credential_auth.tenant_authorization_roles SET permissions = ARRAY['api:treatments:read']
      WHERE tenant_id = $1 AND name = 'viewer'`, [A]);
    await http(0, A, bearer(jwt[0])).expect(403);
    await admin.query(`UPDATE credential_auth.tenant_authorization_roles SET permissions = ARRAY['api:entries:read']
      WHERE tenant_id = $1 AND name = 'viewer'`, [A]);
    await http(0, A, bearer(jwt[0])).expect(200);
    await http(1, B, bearer(jwt[1])).expect(200);
  });

  it('rechecks imported subject metadata without caching verified success', async function () {
    const before = await rows();
    await admin.query(`DELETE FROM credential_identity.legacy_credential_subjects WHERE tenant_id = $1 AND subject_id = $2`,
      [A, SUBJECT]);
    await http(0, A, bearer(jwt[0])).expect(401);
    await http(1, A, secret(subjectTokens[0])).expect(401);
    await admin.query(`INSERT INTO credential_identity.legacy_credential_subjects VALUES ($1, $2, 'sameviewer')`, [A, SUBJECT]);
    await http(0, A, bearer(jwt[0])).expect(200);
    assert.deepEqual(await rows(), before);
  });

  it('rechecks current root references without caching verified success', async function () {
    const before = await rows();
    const replacement = crypto.randomBytes(24).toString('hex');
    await workers[0].secrets.encrypt(ctx(A, 'issuer'), 'operator-replacement', Buffer.from(replacement));
    await admin.query(`UPDATE credential_identity.legacy_credential_config SET root_reference_id = 'operator-replacement'
      WHERE tenant_id = $1`, [A]);
    await http(1, A, secret(hash(roots[0]))).expect(401);
    await http(0, A, bearer(jwt[0])).expect(401);
    await http(1, A, secret(hash(replacement))).expect(200);
    await admin.query(`UPDATE credential_identity.legacy_credential_config SET root_reference_id = 'operator-import-a'
      WHERE tenant_id = $1`, [A]);
    await http(0, A, secret(hash(roots[0]))).expect(200);
    assert.deepEqual(await rows(), before);
  });

  it('fails closed on missing references and authorization-store outage, then recovers without writes', async function () {
    const before = await rows();
    await admin.query(`UPDATE credential_identity.legacy_credential_config SET root_reference_id = 'missing' WHERE tenant_id = $1`, [A]);
    await http(0, A, secret(hash(roots[0]))).expect(503);
    await admin.query(`UPDATE credential_identity.legacy_credential_config SET root_reference_id = 'operator-import-a' WHERE tenant_id = $1`, [A]);
    await admin.query(`REVOKE SELECT ON credential_identity.legacy_credential_config FROM ${role}`);
    try {
      await http(0, A, bearer(jwt[0])).expect(503);
      await http(1, A, secret(hash(roots[0]))).expect(503);
    } finally {
      await admin.query(`GRANT SELECT ON credential_identity.legacy_credential_config TO ${role}`);
    }
    await admin.query(`REVOKE INSERT ON credential_secrets.secret_audit FROM ${role}`);
    try {
      await http(0, A, bearer(jwt[0])).expect(503);
    } finally {
      await admin.query(`GRANT INSERT ON credential_secrets.secret_audit TO ${role}`);
    }
    await admin.query(`REVOKE SELECT ON credential_auth.tenant_authorization_roles FROM ${role}`);
    try {
      await http(0, A, bearer(jwt[0])).expect(503);
      await http(1, A, secret(hash(roots[0]))).expect(503);
      await http(0, A).expect(503);
    } finally {
      await admin.query(`GRANT SELECT ON credential_auth.tenant_authorization_roles TO ${role}`);
    }
    await http(0, A, bearer(jwt[0])).expect(200);
    assert.deepEqual(await rows(), before);
  });

  it('refuses writable credential metadata privileges instead of trusting a serving writer', async function () {
    await admin.query(`GRANT UPDATE (token_prefix) ON credential_identity.legacy_credential_subjects TO ${role}`);
    try {
      await assert.rejects(createLegacyAuthority({ connectionString: appURI, namespace: 'credential_identity' }),
        { code: 'SECRETS_LEGACY_AUTHORITY_UNSAFE' });
    } finally {
      await admin.query(`REVOKE UPDATE (token_prefix) ON credential_identity.legacy_credential_subjects FROM ${role}`);
    }
    await admin.query(`GRANT UPDATE (display_name) ON credential_auth.tenant_authorization_subjects TO ${role}`);
    try {
      await assert.rejects(createAuthority({ connectionString: appURI, namespace: 'credential_auth' }),
        { code: 'TENANT_AUTHORITY_UNSAFE' });
    } finally {
      await admin.query(`REVOKE UPDATE (display_name) ON credential_auth.tenant_authorization_subjects FROM ${role}`);
    }
  });
});
