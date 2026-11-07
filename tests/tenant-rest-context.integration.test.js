'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const express = require('express');
const request = require('supertest');
const { Client } = require('pg');
const { MongoClient, ObjectId } = require('mongodb');
const { optInSuite } = require('./support/opt-in');
const environment = require('../lib/server/tenant-app/environment');
const snapshot = require('../lib/server/tenant-app/snapshot');
const context = require('../lib/server/tenant-app/rest-context');
const settingsOptions = require('../lib/server/tenant-app/settings');
const scope = require('../lib/storage/tenant-scope');
const { run } = require('../lib/migrations/postgres');
const { encodeDocument } = require('../lib/storage/postgres-identity');
const connect = require('../lib/storage/postgres-connection');
const authorityFor = require('../lib/tenant-authorization/postgres');
const legacyFor = require('../lib/secrets/legacy-postgres');
const { createPostgresSecrets } = require('../lib/secrets/postgres');
const { createSecrets } = require('../lib/secrets/component');
const { createVaultTransit } = require('../lib/secrets/vault-transit');
const Collection = require('../lib/api3/generic/collection');
const MongoCollection = require('../lib/api3/storage/mongoCollection');
const writeIntent = require('../lib/storage/write-intent');
const createDataAccess = require('../lib/server/tenant-app/data-access');
const createExchange = require('../lib/server/tenant-app/exchange');
const legacyAuthorization = require('../lib/server/tenant-app/legacy-authorization');
const statusAuthorization = require('../lib/server/tenant-app/status-authorization');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SUBJECT = '000000000000000000000001';
const hash = value => crypto.createHash('sha1').update(value).digest('hex');
const random = () => crypto.randomBytes(16).toString('hex');
const language = require('../lib/language')();

describe('Tenant-local display environment and shipping snapshot loader', function () {
  let mode;
  before(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  after(() => scope.setTenancyMode(mode));

  function ports (tenant, fail) {
    const now = Date.now();
    const result = {};
    for (const logical of ['entries', 'treatments', 'devicestatus', 'activity', 'profile', 'food']) {
      const method = logical === 'profile' ? 'last' : 'list';
      result[logical] = { tenant, store: { [method] (...args) {
        assert.equal(scope.currentTenant(), tenant);
        const cb = args.at(-1);
        if (logical === fail) return cb(new Error('synthetic read failed'));
        const rows = logical === 'entries' ? [{ _id: 'same', type: 'sgv', date: now, sgv: tenant === A ? 101 : 202 }] : [];
        cb(null, rows);
      } } };
    }
    result.stats = { tenant, async read () { return { dataSize: tenant === A ? 10 : 20, indexSize: 1 }; } };
    return result;
  }

  it('projects only typed tenant display settings, including nested allowlists', function () {
    const env = environment({ settings: {
      customTitle: 'Tenant A', enable: ['careportal'], apnsKey: 'process-secret',
      thresholds: { bgHigh: 270, unknown: 'process-secret' }, unknown: { secret: 'process-secret' }
    }, extendedSettings: { devicestatus: { days: 2, secret: 'process-secret' }, provider: 'process-secret' } });
    const shown = env.settings.filteredSettings(env.settings);
    assert.equal(shown.customTitle, 'Tenant A');
    assert.equal(shown.thresholds.bgHigh, 270);
    assert.equal(JSON.stringify(env).includes('process-secret'), false);
    assert.deepEqual(env.extendedSettings, { devicestatus: { days: 2 } });
    assert.equal(shown.apnsKey, undefined);
  });

  it('normalizes actual tenant readings with private clocks/cache and rejects crosswired ports', async function () {
    const aPorts = ports(A);
    const a = snapshot({ tenant: A, ports: aPorts, env: environment(), language });
    const b = snapshot({ tenant: B, ports: ports(B), env: environment(), language });
    const [one, two] = await Promise.all([a.load(), b.load()]);
    assert.equal(one.ddata.sgvs[0].mgdl, 101);
    assert.equal(two.ddata.sgvs[0].mgdl, 202);
    assert.equal(one.cache.getDataRef('entries')[0].sgv, 101);
    assert.equal(two.cache.getDataRef('entries')[0].sgv, 202);
    assert.notEqual(one.bus, two.bus);
    assert.equal(one.ddata.dbstats.dataSize, 10);
    assert.throws(() => snapshot({ tenant: A, ports: { ...aPorts, entries: ports(B).entries }, env: environment(), language }),
      /tenant-bound entries/);
    await assert.rejects(scope.withTenant(B, () => a.load()), /scope mismatch/);
    await assert.rejects(a.load({ at: NaN }), /milliseconds/);
  });

  it('refuses partial success when the shipping loader logs and continues after a failed port', async function () {
    await assert.rejects(snapshot({ tenant: A, ports: ports(A, 'entries'), env: environment(), language }).load(),
      /synthetic read failed/);
  });
});

const enabled = process.env.NS_REST_CONTEXT_HTTP_TEST === '1' &&
  process.env.NS_TEST_POSTGRES_ADMIN_URI && process.env.CUSTOMCONNSTR_mongo;
optInSuite(enabled, 'NS_REST_CONTEXT_HTTP_TEST=1 with disposable PG/Mongo/Docker Vault')(
  'Tenant H actual HTTP (owned PostgreSQL/RLS, Mongo oracle, real Vault)', function () {
  this.timeout(90000);
  const suffix = random().slice(0, 12);
  const prefix = 'h_' + suffix;
  const namespaces = { data: prefix + '_data', auth: prefix + '_auth', identity: prefix + '_identity', secrets: prefix + '_secrets' };
  const vaultName = 'ns-rest-context-vault-' + suffix;
  const rootToken = random(), roots = [random(), random()];
  const providers = new Map(), apps = {}, mongoStores = {}, collections = {}, oracleJWT = {};
  const settingsFlags = {};
  const tokens = [], events = [];
  let mode, admin, connection, authority, legacy, persistence, secrets, exchange, mongo, vaultOwned, address, appURI;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
  const identity = tenant => ({ tenant, principal: 'verifier', consumer: 'api' });
  const http = (backend, tenant, path, credential, method = 'get', body) => {
    let call = request(apps[backend][tenant])[method](path);
    if (credential !== undefined) call = call.set('api-secret', credential);
    return body === undefined ? call : call.send(body);
  };
  async function vault (resource, body) {
    const response = await fetch(address + '/v1/' + resource, {
      method: 'POST', headers: { 'X-Vault-Token': rootToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
    });
    assert.ok(response.ok, 'operator fixture Vault HTTP ' + response.status);
    return response.status === 204 ? {} : response.json();
  }
  const catalogue = {
    version: 1,
    migrations: require('../migrations/candidates/postgres-settings-v1.json').migrations
  };

  before(async function () {
    mode = scope.getTenancyMode();
    scope.setTenancyMode('multi');
    const adminURI = process.env.NS_TEST_POSTGRES_ADMIN_URI;
    for (const [namespace, candidate] of [
      [namespaces.data, catalogue],
      [namespaces.auth, require('../lib/tenant-authorization/postgres-candidate.json')],
      [namespaces.identity, require('../lib/secrets/legacy-credentials-candidate.json')],
      [namespaces.secrets, require('../lib/secrets/postgres-candidate.json')]
    ]) await run('up', { direct: true, connectionString: adminURI, namespace, catalogue: candidate });
    admin = new Client({ connectionString: adminURI });
    await admin.connect();
    const role = prefix + '_app', password = random();
    await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA ${Object.values(namespaces).join(',')} TO "${role}"`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${namespaces.data}.settings TO "${role}"`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${namespaces.auth},${namespaces.identity} TO "${role}"`);
    await admin.query(`GRANT SELECT, INSERT ON ${namespaces.secrets}.secret_records TO "${role}"`);
    await admin.query(`GRANT INSERT ON ${namespaces.secrets}.secret_audit TO "${role}"`);
    const url = new URL(adminURI);
    url.username = role; url.password = password; appURI = url.toString();
    for (const [i, tenant] of [A, B].entries()) {
      await admin.query(`INSERT INTO ${namespaces.identity}.legacy_credential_config VALUES ($1,$2)`, [tenant, 'root-' + i]);
      await admin.query(`INSERT INTO ${namespaces.identity}.legacy_credential_subjects VALUES ($1,$2,'sameviewer')`, [tenant, SUBJECT]);
      await admin.query(`INSERT INTO ${namespaces.auth}.tenant_authorization_config VALUES ($1,ARRAY['status-only'])`, [tenant]);
      await admin.query(`INSERT INTO ${namespaces.auth}.tenant_authorization_subjects
        (tenant_id,subject_id,display_name) VALUES ($1,$2,$3)`, [tenant, SUBJECT, 'Same Viewer ' + i]);
      await admin.query(`INSERT INTO ${namespaces.auth}.tenant_authorization_roles VALUES
        ($1,'viewer',ARRAY['api:settings:read','api:settings:create','api:settings:update','api:settings:delete','api:status:read'])`, [tenant]);
      await admin.query(`INSERT INTO ${namespaces.auth}.tenant_authorization_subject_roles VALUES ($1,$2,'viewer')`, [tenant, SUBJECT]);
      tokens[i] = 'sameviewer-' + hash(hash(roots[i]) + SUBJECT).slice(0, 16);
    }
    execFileSync('docker', ['run', '--name', vaultName, '-d', '-p', '127.0.0.1::8200',
      '-e', 'VAULT_DEV_ROOT_TOKEN_ID', 'hashicorp/vault@sha256:962a92876e168d68eaaa24b0b8b49bbce1cb63024060a67bba95cd158a366fc2',
      'server', '-dev', '-dev-listen-address=0.0.0.0:8200'],
    { env: { ...process.env, VAULT_DEV_ROOT_TOKEN_ID: rootToken }, stdio: 'pipe', timeout: 30000 });
    vaultOwned = true;
    address = 'http://127.0.0.1:' + docker(['port', vaultName, '8200/tcp']).split(':').pop();
    const deadline = Date.now() + 20000;
    for (;;) {
      try {
        const response = await fetch(address + '/v1/sys/health', { signal: AbortSignal.timeout(1000) });
        await response.body.cancel();
        if (response.ok) break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
      }
      if (Date.now() > deadline) throw new Error('Owned Vault readiness failed');
      await delay(100);
    }
    await vault('sys/mounts/transit', { type: 'transit' });
    for (const [i, tenant] of [A, B].entries()) {
      for (const purpose of ['data', 'signing']) await vault('transit/keys/tenant-' + i + '-' + purpose, { type: 'aes256-gcm96' });
      const policy = `path "transit/decrypt/tenant-${i}-data" { capabilities=["update"] }\n` +
        ['hmac', 'verify'].map(op => `path "transit/${op}/tenant-${i}-signing" { capabilities=["update"] }`).join('\n');
      await vault('sys/policies/acl/tenant-' + i, { policy });
      const credential = (await vault('auth/token/create', { policies: ['tenant-' + i], no_default_policy: true, ttl: '15m' })).auth.client_token;
      providers.set(tenant, createVaultTransit({ address, mount: 'transit', encryptionKey: 'tenant-' + i + '-data',
        signingKey: 'tenant-' + i + '-signing', signingVersion: 1, allowInsecureLoopback: true, getToken: () => credential }));
      const envelope = Buffer.from(JSON.stringify({ tenant, id: 'root-' + i, data: Buffer.from(roots[i]).toString('base64') }));
      const encrypted = await vault('transit/encrypt/tenant-' + i + '-data', { plaintext: envelope.toString('base64') });
      await admin.query(`INSERT INTO ${namespaces.secrets}.secret_records (tenant_id,id,format,ciphertext) VALUES ($1,$2,1,$3)`,
        [tenant, 'root-' + i, encrypted.data.ciphertext]);
    }
    connection = await connect({ connectionString: appURI, max: 2 });
    authority = await authorityFor({ connectionString: appURI, namespace: namespaces.auth });
    legacy = await legacyFor({ connectionString: appURI, namespace: namespaces.identity });
    persistence = await createPostgresSecrets({ connectionString: appURI, namespace: namespaces.secrets });
    secrets = createSecrets({ ...persistence, providerFor: async tenant => providers.get(tenant),
      authorize: async (who, action) => who.consumer === 'api' && who.principal === 'verifier' &&
        ['decrypt', 'verify', 'sign'].includes(action.operation),
      maxTokenLifetimeSeconds: 28800, legacyAuthorityFor: tenant => legacy.read(tenant) });
    exchange = createExchange({ secrets, authority, verifierContext: identity });
    mongo = new MongoClient(process.env.CUSTOMCONNSTR_mongo);
    await mongo.connect();
    for (const backend of ['pg', 'mongo']) {
      apps[backend] = {};
      collections[backend] = {};
      settingsFlags[backend] = {};
      for (const [i, tenant] of [A, B].entries()) {
        const app = express(), v3 = express.Router(), bus = new EventEmitter();
        bus.on('storage-intent-committed', value => events.push({ tenant, value }));
        const env = environment({ settings: { customTitle: 'Tenant ' + i, apiSecret: 'PROCESS-SENTINEL', enable: ['careportal'] },
          extendedSettings: { devicestatus: { days: 2, token: 'PROCESS-SENTINEL' } } });
        const ctx = { bus, purifier: require('../lib/server/purifier')({}, {}) };
        const routeApp = express();
        routeApp.setENVTruthy = () => undefined;
        routeApp.set('API3_MAX_LIMIT', 1000);
        routeApp.set('API3_DEDUP_FALLBACK_ENABLED', true);
        routeApp.set('API3_SETTINGS_STRICT_READ_ENABLED', false);
        if (backend === 'mongo') {
          mongoStores[tenant] = mongo.db(prefix + '_' + i);
          ctx.store = { db: mongoStores[tenant], collection: name => mongoStores[tenant].collection(name) };
          await mongoStores[tenant].collection('settings').createIndex({ identifier: 1 }, {
            unique: true, partialFilterExpression: { identifier: { $type: 'string', $gt: '' } }
          });
        }
        const mongoStorage = backend === 'mongo' ? new MongoCollection(ctx, env, 'settings', 'settings', []) : undefined;
        const col = new Collection({ ctx, env, app: routeApp, colName: 'settings', storageColName: 'settings',
          ...(backend === 'pg' ? settingsOptions({ connection, table: namespaces.data + '.settings', bus, env }) : {
            storage: mongoStorage, intentFactory: () => writeIntent.forCollectionResolved(mongoStorage, 'settings', 'v3', { env })
          }) });
        col.mapRoutes();
        collections[backend][tenant] = col;
        const accessOptions = { secrets, authority, verifierContext: identity, collections: ['settings'],
          safeRoutes: { 1: ['/status','/verifyauth'], 2: ['/status','/verifyauth','/authorization/permissions','/authorization/permissions/trie'],
            3: ['/status','/version','/lastModified','/versions'] } };
        const dataAccess = createDataAccess(accessOptions);
        const strictAccess = createDataAccess({ ...accessOptions, strictSettingsRead: true });
        const flags = settingsFlags[backend][tenant] = { strict: false, app: routeApp };
        const routers = context({ env, authorization: legacyAuthorization(), collections: { settings: col },
          versionInfo: { name: 'Nightscout', version: 'test', storage: { storage: backend, version: 'fixture' } },
          admitted: { 1: [], 2: [], 3: ['settings'] },
          statusAuthorization: statusAuthorization({ tenant, exchange }) });
        app.disable('etag');
        app.use((req, res, next) => {
          res.set('Cache-Control', 'no-store');
          req.tenantAuthenticate = async version => {
            const who = await (flags.strict ? strictAccess : dataAccess)({
              tenant, request: req, version: version || Number(req.baseUrl.slice(-1))
            });
            if (!who) throw Object.assign(new Error('invalid credential'), { status: 401 });
            req.tenantContext = who;
          };
          scope.withTenant(tenant, next);
        });
        app.use('/api/v1', routers.legacy);
        app.use('/api/v2', routers.legacy, routers.v2);
        const protect = async (req, res, next) => {
          try { await req.tenantAuthenticate(3); next(); } catch (error) { next(error); }
        };
        v3.use(...require('../lib/api3/shared/jsonParser')(), protect, routers.v3, routeApp);
        app.use('/api/v3', v3);
        app.use('/api', protect, routers.root);
        app.use((error, req, res, next) => {
          if (res.headersSent) return next(error);
          res.status(error.status || (error.code === 'TENANT_DATA_FORBIDDEN' ? 403 : 503)).json({ error: error.code });
        });
        apps[backend][tenant] = app;
      }
    }
    apps.oracle = {};
    for (const [i, tenant] of [A, B].entries()) {
      const db = mongoStores[tenant];
      await db.collection('auth_subjects').insertOne({ _id: new ObjectId(SUBJECT), name: 'Same Viewer ' + i, roles: ['viewer'] });
      await db.collection('auth_roles').insertOne({ name: 'viewer', permissions: [
        'api:settings:read', 'api:settings:create', 'api:settings:update', 'api:settings:delete', 'api:status:read'
      ] });
      const enclave = require('../lib/server/enclave')();
      enclave.setApiKey(roots[i]);
      enclave.setJWTKey(random());
      const settings = require('../lib/settings')();
      settings.enable = ['careportal'];
      settings.authDefaultRoles = 'status-only';
      settings.authFailDelay = 0;
      settings.customTitle = 'Tenant ' + i;
      const env = { settings, extendedSettings: {}, enclave, authentication_collections_prefix: 'auth_', trustProxy: false };
      const ctx = { store: { db, collection: name => db.collection(name) }, bus: new EventEmitter(), language,
        settings, moment: require('moment') };
      ctx.authorization = require('../lib/authorization')(env, ctx);
      await scope.withTenant(tenant, () => new Promise((resolve, reject) =>
        ctx.authorization.storage.reload(error => error ? reject(error) : resolve())));
      assert.equal(ctx.authorization.storage.subjects[0].accessToken, tokens[i]);
      oracleJWT[tenant] = ctx.authorization.authorize(tokens[i]).token;
      const app = express(), parent = express(), wares = require('../lib/middleware')(env);
      parent.set('name', 'Nightscout');
      parent.set('version', 'test');
      parent.enable('api');
      parent.extendedClientSettings = {};
      parent.use(wares.rawParser, wares.jsonParser, wares.urlencodedParser, wares.sendJSONStatus);
      parent.use(require('../lib/api/status')(parent, wares, env, ctx));
      parent.use(require('../lib/api/verifyauth')(ctx));
      app.use((req, res, next) => scope.withTenant(tenant, next));
      app.use('/api/v1', parent);
      app.use('/api/v2', parent);
      apps.oracle[tenant] = app;
    }
  });

  after(async function () {
    if (mongo) { for (const db of Object.values(mongoStores)) await db.dropDatabase(); await mongo.close(); }
    for (const service of [authority, legacy, persistence]) if (service) await service.close();
    if (connection) await connection.end();
    if (admin) {
      for (const namespace of Object.values(namespaces)) await admin.query(`DROP SCHEMA "${namespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${prefix}_app"`);
      await admin.end();
    }
    if (vaultOwned) docker(['rm', '-f', '-v', vaultName]);
    if (mode) scope.setTenancyMode(mode);
  });

  it('serves safe legacy status/probes and honest API3/root discovery over real authority', async function () {
    for (const backend of ['pg', 'mongo']) {
      const credential = hash(roots[0]);
      const status = await http(backend, A, '/api/v1/status.json', credential).expect(200);
      assert.equal(status.headers['cache-control'], 'no-store');
      assert.equal(status.body.settings.customTitle, 'Tenant 0');
      assert.deepEqual(status.body.extendedSettings, { devicestatus: { days: 2 } });
      assert.equal(JSON.stringify(status.body).includes('PROCESS-SENTINEL'), false);
      const probe = await http(backend, A, '/api/v2/verifyauth', credential).expect(200);
      assert.equal(probe.body.message.canRead, true);
      assert.equal(probe.body.message.canWrite, true);
      const info = await http(backend, A, '/api/v3/status', tokens[0]).expect(200);
      assert.deepEqual(info.body.result.apiPermissions, { settings: 'crud' });
      const versions = await http(backend, A, '/api/versions', tokens[0]).expect(200);
      assert.deepEqual(versions.body.map(row => row.collections), [[], [], ['settings']]);
      await http(backend, A, '/api/v3/version', undefined).expect(200);
      const permissions = await http(backend, A, '/api/v2/authorization/permissions', credential).expect(200);
      assert.ok(permissions.body.includes('api:settings:read'));
      assert.ok(!permissions.body.includes('api:entries:read'));
      await http(backend, A, '/api/v2/authorization/permissions/trie', credential).expect(200);
      await http(backend, A, '/api/v2/authorization/permissions', tokens[0]).expect(401);
    }
  });

  it('matches shipping carrier precedence and body consumption without anonymous credential fallback', async function () {
    const issued = await exchange({ tenant: A, credential: tokens[0] });
    const scenarios = [
      { query: { token: tokens[0] }, body: { token: 'ignored-body' } },
      { query: { secret: tokens[0] }, headers: { 'api-secret': 'ignored-header' } },
      { body: [{ token: tokens[0], extension: { retained: true } }] },
      { body: { secret: tokens[0], extension: { retained: true } } },
      { headers: { 'api-secret': hash(roots[0]) }, query: { token: tokens[0] } },
      { headers: { Authorization: 'malformed' }, query: { token: tokens[0] } }
    ];
    for (const version of [1, 2]) {
      for (const [index, scenario] of scenarios.entries()) {
        const results = [];
        for (const backend of ['pg', 'oracle']) {
          let call = request(apps[backend][A]).get('/api/v' + version + '/status').set('Accept', 'application/json');
          if (scenario.query) call = call.query(scenario.query);
          if (scenario.headers) call = call.set(scenario.headers);
          if (scenario.body) call = call.send(scenario.body);
          const response = await call.expect(200);
          results.push(response.body.authorized?.sub);
          assert.equal(response.headers['cache-control'], 'no-store');
        }
        const expected = [1, 3].includes(index) ? undefined : 'Same Viewer 0';
        assert.deepEqual(results, [expected, expected], 'carrier scenario ' + index + ', version ' + version);
      }
      for (const backend of ['pg', 'oracle']) {
        const token = backend === 'pg' ? issued.token : oracleJWT[A];
        const result = await request(apps[backend][A]).get('/api/v' + version + '/status')
          .set('Accept', 'application/json').set('Authorization', 'Bearer ' + token)
          .query({ token: 'ignored-invalid' }).expect(200);
        assert.equal(result.body.authorized.sub, 'Same Viewer 0');
        const root = await http(backend, A, '/api/v' + version + '/verifyauth', hash(roots[0])).expect(200);
        assert.deepEqual(root.body.message, {
          canRead: true, canWrite: true, isAdmin: true, message: 'OK', rolefound: 'NOTFOUND', permissions: 'ROLE'
        });
      }
    }
    for (const query of [{ token: '' }, { token: ['one', 'two'] }, { secret: '' }, { token: 'invalid' }]) {
      await request(apps.pg[A]).get('/api/v1/status').query(query).expect(401);
    }
    await request(apps.pg[A]).get('/api/v1/status').set('Authorization', 'malformed').expect(401);
    await request(apps.pg[A]).get('/api/v1/status').set('Authorization', ['Bearer one', 'Bearer two']).expect(401);
    // Shipping single falls through an empty query token to its configured
    // public status role. Tenant mode deliberately rejects a presented token.
    await request(apps.oracle[A]).get('/api/v1/status').query({ token: '' }).expect(200);
  });

  it('retains status format/header negotiation and inherited HEAD/OPTIONS', async function () {
    for (const backend of ['pg', 'oracle']) {
      for (const version of [1, 2]) {
        const prefix = '/api/v' + version + '/status';
        for (const [suffix, type] of [['.json', 'application/json'], ['.js', 'application/javascript'],
          ['.txt', 'text/plain'], ['.html', 'text/html']]) {
          const response = await http(backend, A, prefix + suffix, hash(roots[0])).expect(200);
          assert.equal(response.type, type);
          assert.equal(response.headers['cache-control'], 'no-store');
        }
        for (const suffix of ['.svg', '.png']) {
          const response = await http(backend, A, prefix + suffix, hash(roots[0])).expect(302);
          assert.equal(response.headers.location, 'http://img.shields.io/badge/Nightscout-OK-green' + suffix);
        }
        await http(backend, A, prefix, hash(roots[0]), 'head').expect(200);
        const options = await http(backend, A, prefix, hash(roots[0]), 'options').expect(200);
        assert.ok(options.headers.allow.includes('HEAD'));
        const denied = await http(backend, A, '/api/v' + version + '/verifyauth', undefined).expect(200);
        assert.equal(denied.body.message.message, 'UNAUTHORIZED');
        assert.equal(denied.body.message.permissions, 'DEFAULT');
      }
    }
  });

  it('matches generic settings CRUD/history, nested extensions, conditional headers and strict read', async function () {
    const observed = [];
    for (const backend of ['pg', 'mongo']) {
      const root = hash(roots[0]);
      const created = await http(backend, A, '/api/v3/settings', tokens[0], 'post', {
        identifier: 'same-settings', app: 'synthetic', date: 1700000000000, utcOffset: 0,
        value: { arbitrary: [{ nested: 'retained' }] }
      }).expect(201);
      assert.equal(created.body.identifier, 'same-settings');
      await http(backend, B, '/api/v3/settings', tokens[1], 'post', {
        identifier: 'same-settings', app: 'synthetic', date: 1700000000000, utcOffset: 0,
        value: { foreignSentinel: 'TENANT-B-ONLY' }
      }).expect(201);
      const read = await http(backend, A, '/api/v3/settings/same-settings', tokens[0]).expect(200);
      assert.deepEqual(read.body.result.value, { arbitrary: [{ nested: 'retained' }] });
      assert.equal(JSON.stringify(read.body).includes('TENANT-B-ONLY'), false);
      const flags = settingsFlags[backend][A];
      flags.strict = true;
      flags.app.set('API3_SETTINGS_STRICT_READ_ENABLED', true);
      try {
        await http(backend, A, '/api/v3/settings/same-settings', tokens[0]).expect(403);
        await http(backend, A, '/api/v3/settings/same-settings', root).expect(200);
      } finally {
        flags.strict = false;
        flags.app.set('API3_SETTINGS_STRICT_READ_ENABLED', false);
      }
      await request(apps[backend][A]).get('/api/v3/settings/same-settings').set('api-secret', tokens[0])
        .set('If-Modified-Since', read.headers['last-modified']).expect(304);
      await http(backend, A, '/api/v3/settings', tokens[0]).expect(403);
      await http(backend, A, '/api/v3/settings/history/1700000000000', tokens[0]).expect(403);
      await http(backend, A, '/api/v3/settings/same-settings', tokens[0], 'patch', { value: { changed: true } }).expect(200);
      const history = await http(backend, A, '/api/v3/settings/history/1700000000000', root).expect(200);
      assert.ok(history.headers.etag);
      observed.push(history.body.result.map(doc => ({ identifier: doc.identifier, value: doc.value })));
      await http(backend, A, '/api/v3/settings/same-settings', tokens[0], 'put', {
        app: 'synthetic', date: 1700000000000, utcOffset: 0, value: { replaced: true }
      }).expect(200);
      await http(backend, A, '/api/v3/settings/same-settings', tokens[0], 'delete').expect(200);
      await http(backend, A, '/api/v3/settings/same-settings', tokens[0]).expect(410);
    }
    assert.deepEqual(observed[0], observed[1]);
  });

  it('keeps typed identities, tenant clocks and document extensions behind forced RLS', async function () {
    const hex = '65a1b2c3d4e5f60718293a4b';
    for (const [tenant, value, stamp] of [[A, 'a', 1000], [B, 'b', 9999999999999]]) {
      for (const id of [hex, new ObjectId(hex)]) {
        const encoded = encodeDocument({ _id: id, identifier: value + (typeof id), value: { sentinel: value }, srvModified: stamp });
        await admin.query(`INSERT INTO ${namespaces.data}.settings (tenant_id,id_kind,doc) VALUES ($1,$2,$3)`,
          [tenant, encoded.id_kind, encoded.doc]);
      }
    }
    const rows = await connection.withTenant(A, () => connection.query(`SELECT id_kind,doc FROM ${namespaces.data}.settings WHERE "_id"=$1`, [hex]));
    assert.equal(rows.rows.length, 2);
    assert.deepEqual(new Set(rows.rows.map(row => row.id_kind)), new Set(['string', 'objectid']));
    assert.equal(JSON.stringify(rows.rows).includes('"sentinel":"b"'), false);
    const one = await http('pg', A, '/api/v3/lastModified', tokens[0]).expect(200);
    const two = await http('pg', B, '/api/v3/lastModified', tokens[1]).expect(200);
    assert.notEqual(one.body.result.collections.settings, two.body.result.collections.settings);
    assert.equal(two.body.result.collections.settings, 9999999999999);
    const table = await admin.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass', [namespaces.data + '.settings']);
    assert.deepEqual(table.rows, [{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  it('refuses nonrepresentable submitted extensions without writes and sanitizes recognized outages', async function () {
    const before = events.length;
    await request(apps.pg[A]).post('/api/v3/settings').set('api-secret', tokens[0])
      .set('Content-Type', 'application/json')
      .send('{"identifier":"unrepresentable","date":1700000000000,"utcOffset":0,"app":"synthetic","value":{"bad":1e999}}')
      .expect(400);
    await http('pg', A, '/api/v3/settings/unrepresentable', tokens[0]).expect(404);
    assert.equal(events.length, before);
    await http('pg', A, '/api/v3/settings', undefined, 'post', {
      identifier: 'anonymous-write', app: 'synthetic', date: 1700000000000, utcOffset: 0
    }).expect(403);
    await admin.query(`REVOKE SELECT ON ${namespaces.data}.settings FROM "${prefix}_app"`);
    try {
      const outage = await http('pg', A, '/api/v3/settings/same-settings', hash(roots[0])).expect(503);
      assert.deepEqual(outage.body, { error: 'STORAGE_UNAVAILABLE' });
    } finally {
      await admin.query(`GRANT SELECT ON ${namespaces.data}.settings TO "${prefix}_app"`);
    }
    await admin.query(`REVOKE SELECT ON ${namespaces.auth}.tenant_authorization_roles FROM "${prefix}_app"`);
    try {
      const outage = await http('pg', A, '/api/v3/status', tokens[0]).expect(503);
      assert.deepEqual(outage.body, { error: 'TENANT_AUTHORITY_UNAVAILABLE' });
    } finally {
      await admin.query(`GRANT SELECT ON ${namespaces.auth}.tenant_authorization_roles TO "${prefix}_app"`);
    }
  });

  it('consults current persisted grants and exact subject names on later requests', async function () {
    await http('pg', B, '/api/v3/settings', tokens[1], 'post', {
      identifier: 'rename', app: 'synthetic', date: 1700000000000, utcOffset: 0
    }).expect(201);
    await admin.query(`UPDATE ${namespaces.auth}.tenant_authorization_subjects SET display_name='Renamed Exact' WHERE tenant_id=$1`, [B]);
    await http('pg', B, '/api/v3/settings/rename', tokens[1], 'patch', { extension: true }).expect(200);
    const read = await http('pg', B, '/api/v3/settings/rename', tokens[1]).expect(200);
    assert.equal(read.body.result.modifiedBy, 'Renamed Exact');
    await admin.query(`UPDATE ${namespaces.auth}.tenant_authorization_roles SET permissions=ARRAY[]::text[] WHERE tenant_id=$1`, [B]);
    await http('pg', B, '/api/v3/settings/rename', tokens[1], 'patch', { extension: false }).expect(403);
    await http('pg', B, '/api/v3/settings/rename', tokens[1]).expect(403);
    await http('pg', A, '/api/v3/settings/rename', tokens[1]).expect(401);
  });
});
