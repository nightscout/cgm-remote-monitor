'use strict';

// Small native PostgreSQL + actual preview/API path. The operation-window
// adapter below is a refusal protocol, not native platform fencing evidence.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const express = require('express'), request = require('supertest');
const scope = require('../lib/storage/tenant-scope');
const connect = require('../lib/storage/postgres-connection');
const preview = require('../lib/server/serve/preview-domains');
const environment = require('../lib/server/tenant-app/environment');
const { run } = require('../lib/migrations/postgres');
const dataAccess = require('../lib/server/tenant-app/data-access');
const { createTenantApp } = require('../lib/server/tenant-app');
const { optInSuite } = require('./support/opt-in');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const domains = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'];
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
optInSuite(process.env.NS_REST_ACQUISITION_NATIVE === '1', 'NS_REST_ACQUISITION_NATIVE=1')('entries acquisition native preview path', function () {
  this.timeout(60000);
  const name = 'ns-rest-acquisition-native-' + randomBytes(5).toString('hex');
  const ns = 'acquisition';
  const role = 'acquisition_api';
  const auth = 'acquisition_authority';
  const password = randomBytes(24).toString('hex');
  const credentials = new Map([['synthetic-a', A], ['synthetic-b', B]]);
  let owned = false, containerId, pinnedImage, admin, connection, authority, app, oldApp, previous, closed = false;
  let suspended = false, checks = 0, queries = [];
  const at = Date.now() - 1000;
  const unavailable = async () => { throw new Error('owner service outside fixture'); };
  const http = (method, path, tenant = A, token = tenant === A ? 'synthetic-a' : 'synthetic-b') =>
    request(app)[method](path + (path.includes('?') ? '&' : '?') + 'token=' + token)
      .set('Host', tenant === A ? 'a.example.test' : 'b.example.test').set('Accept', 'application/json');
  before(async () => {
    previous = scope.getTenancyMode(); scope.setTenancyMode('multi');
    pinnedImage = docker(['image', 'inspect', 'postgres:16', '--format', '{{.Id}}']);
    const id = execFileSync('docker', ['run', '--rm', '-d', '--name', name,
      '--label', 'com.docker.compose.project=ns-rest-acquisition-native-20261113', '--label', 'ns.rest.owner=rest-raw-acquisition-20261113',
      '--cpus=1', '--memory=512m', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD', pinnedImage],
    { env: { ...process.env, POSTGRES_PASSWORD: password }, encoding: 'utf8', timeout: 30000 }).trim();
    owned = true; containerId = id;
    const port = docker(['port', name, '5432/tcp']).split(':').pop();
    console.log('REST_NATIVE_OWNED ' + JSON.stringify({ id, name, port, pinnedImage, owner: 'rest-raw-acquisition-20261113' }));
    const uri = new URL('postgres://postgres@127.0.0.1:' + port + '/postgres'); uri.password = password;
    for (let i = 0; ; i++) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); break; }
      catch (e) { if (i >= 100) throw e; await delay(100); }
    }
    admin = new Client({ connectionString: uri.toString() }); await admin.connect();
    for (const d of domains) await run('up', { direct: true, connectionString: uri.toString(), namespace: ns + '_' + d,
      catalogue: require('../lib/server/serve/postgres-domains').get(d).catalogue });
    await run('up', { direct: true, connectionString: uri.toString(), namespace: auth,
      catalogue: require('../lib/tenant-authorization/postgres-candidate.json') });
    const secret = randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${secret}'`);
    for (const d of domains) {
      await admin.query(`GRANT USAGE ON SCHEMA ${ns}_${d} TO ${role}`);
      if (d === 'entries') await require('./fixtures/tenant-insertion-grants').grant(admin, { namespace: ns + '_entries', role,
        domain: 'entries', catalogue: require('../migrations/candidates/postgres-entries-v1.json') });
      else await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${ns}_${d} TO ${role}`);
    }
    await admin.query(`GRANT USAGE ON SCHEMA ${auth} TO ${role}`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${auth} TO ${role}`);
    for (const tenant of [A, B]) {
      await admin.query(`INSERT INTO ${auth}.tenant_authorization_config VALUES ($1, ARRAY['denied'])`, [tenant]);
      await admin.query(`INSERT INTO ${auth}.tenant_authorization_subjects (tenant_id,subject_id,display_name) VALUES ($1,'subject','synthetic')`, [tenant]);
      await admin.query(`INSERT INTO ${auth}.tenant_authorization_roles VALUES ($1,'writer',$2)`, [tenant, ['api:entries:read', 'api:entries:create', 'api:entries:delete']]);
      await admin.query(`INSERT INTO ${auth}.tenant_authorization_subject_roles VALUES ($1,'subject','writer')`, [tenant]);
    }
    uri.username = role; uri.password = secret;
    connection = await connect({ connectionString: uri.toString(), max: 1 });
    const query = connection.query.bind(connection);
    connection.query = async (...args) => { queries.push(args[0]); return query(...args); };
    authority = await require('../lib/tenant-authorization/postgres')({ connectionString: uri.toString(), namespace: auth });
    const previewOptions = { config: { domains, legacyEnabled: true, contextEnabled: true, bindings: new Map([[A, {}], [B, {}]]),
      environments: new Map([A, B].map(t => [t, environment()])), namespaces: Object.fromEntries(domains.map(d => [d, ns + '_' + d])) },
    connection, exchange: async () => null };
    const graph = await preview(previewOptions);
    const file = require.resolve('../lib/server/serve/preview-domains');
    const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
    const source = fs.readFileSync(file, 'utf8');
    const restored = source.replace("const rawEntries = /^\\/entries(?:\\/[^/]+)?$/.test(entriesPath);", 'const rawEntries = false;');
    assert.notEqual(restored, source, 'full acquisition control mutation landed');
    const output = { exports: {} };
    vm.runInThisContext('(function(require,module,exports){' + restored + '\n})', { filename: file })(createRequire(file), output, output.exports);
    const oldGraph = await output.exports(previewOptions);
    const access = dataAccess({ authority, secrets: { verifyLegacyCredential: async ({ tenant }, { token }) =>
      credentials.get(token) === tenant ? { kind: 'subject', subjectId: 'subject' } : null },
    verifierContext: async tenant => ({ tenant, consumer: 'api' }), collections: domains, legacyCollections: domains });
    const options = { resolver: { resolve: async req => req.hostname === 'a.example.test' ? A : B },
      verifyCredential: unavailable, authorizeRequest: unavailable, tenantSettings: { read: unavailable, replace: unavailable, rollback: unavailable },
      subjectPolicy: { read: unavailable, replace: unavailable }, dataRouter: express.Router(), legacyRouter: graph.legacyRouter, dataAccess: access,
      operationWindow: { run: async (tenant, fn) => {
        checks++; if (suspended) throw Object.assign(new Error('restore in progress'), { code: 'TENANT_MAINTENANCE', status: 503 });
        return scope.withTenant(tenant, fn);
      } } };
    app = createTenantApp(options);
    oldApp = createTenantApp({ ...options, legacyRouter: oldGraph.legacyRouter });
  });
  after(async () => {
    try { if (connection && !closed) await connection.end(); }
    finally { try { if (authority) await authority.close(); }
      finally { try { if (admin) await admin.end(); }
      finally { if (owned) {
        const metadata = JSON.parse(docker(['inspect', containerId]))[0];
        assert.equal(metadata.Config.Labels['ns.rest.owner'], 'rest-raw-acquisition-20261113');
        assert.equal(metadata.Image, pinnedImage);
        docker(['rm', '-f', '-v', containerId]); console.log('REST_NATIVE_REMOVED ' + containerId);
      } scope.setTenancyMode(previous); } } }
  });
  it('persists each tenant through actual POST then reads matching content with no unrelated SQL', async () => {
    for (const [tenant, sgv] of [[A, 123], [B, 234]]) {
      queries = [];
      await http('post', '/api/v1/entries', tenant).send([{ type: 'sgv', sgv, date: at, dateString: new Date(at).toISOString(), device: 'synthetic' }]).expect(200);
      assert(!queries.some(s => /pg_column_size|acquisition_(treatments|profile|food|activity|devicestatus)/.test(s)), 'NATIVE_WRITE_NO_UNRELATED_READ');
      for (const version of [1, 2]) {
        queries = [];
        const response = await http('get', '/api/v' + version + '/entries/sgv.json?count=1', tenant).expect(200);
        assert.equal(response.body[0].sgv, sgv);
        assert.equal(response.headers['last-modified'], new Date(at).toUTCString());
        assert(!queries.some(s => /pg_column_size|acquisition_(treatments|profile|food|activity|devicestatus)/.test(s)), 'NATIVE_READ_NO_UNRELATED_READ');
        console.log('REST_NATIVE_READ ' + JSON.stringify({ version, tenant, sqlStatements: queries.length }));
      }
    }
    const stored = (await admin.query(`SELECT tenant_id,doc FROM ${ns}_entries.entries ORDER BY tenant_id`)).rows;
    assert.deepEqual(stored.map(r => [r.tenant_id, r.doc.sgv]), [[A, 123], [B, 234]]);
    await http('post', '/api/v1/entries').send([
      { type: 'sgv', sgv: 111, date: at - 5 * 86400000, dateString: new Date(at - 5 * 86400000).toISOString(), device: 'stale' },
      { type: 'sgv', sgv: 144, date: at + 86400000, dateString: new Date(at + 86400000).toISOString(), device: 'future' },
      { type: 'mbg', mbg: 122, date: at - 1000, dateString: new Date(at - 1000).toISOString(), device: 'mbg' },
      { type: 'cal', scale: 1, slope: 2, intercept: 3, date: at - 2000, dateString: new Date(at - 2000).toISOString(), device: 'cal' }
    ]).expect(200);
    for (const version of [1, 2]) for (const path of ['/entries.json', '/entries/sgv.json?count=1', '/entries/sgv.json?count=50', '/entries/mbg.json?count=1', '/entries/cal.json?count=1', '/entries?find[date][$gte]=' + (at - 6 * 86400000), '/entries/current.json', '/entries.csv', '/entries?count=0']) {
      const actual = await http('get', '/api/v' + version + path).expect(200);
      queries = [];
      const expected = await request(oldApp).get('/api/v' + version + path + (path.includes('?') ? '&' : '?') + 'token=synthetic-a')
        .set('Host', 'a.example.test').set('Accept', 'application/json').expect(200);
      assert.deepEqual(actual.body, expected.body, 'same payload ' + path);
      assert.equal(actual.text, expected.text, 'same representation ' + path);
      assert.equal(actual.headers['last-modified'], expected.headers['last-modified'], 'same header ' + path);
      assert.equal(actual.headers['content-type'], expected.headers['content-type']);
      if (path.includes('/entries/sgv')) console.log('REST_NATIVE_OLD_READ ' + JSON.stringify({ version, sqlStatements: queries.length }));
    }
    const first = await http('get', '/api/v1/entries').expect(200);
    await http('get', '/api/v1/entries').set('If-Modified-Since', first.headers['last-modified']).expect(304);
  });
  it('retains current role/membership/foreign-token and restore admission refusals with no writes', async () => {
    const before = (await admin.query(`SELECT tenant_id,doc FROM ${ns}_entries.entries ORDER BY tenant_id`)).rows;
    await http('post', '/api/v1/entries', A, 'synthetic-b').send([{ type: 'sgv', sgv: 999, date: at }]).expect(401);
    await admin.query(`UPDATE ${auth}.tenant_authorization_roles SET permissions=ARRAY[]::text[] WHERE tenant_id=$1`, [A]);
    await http('get', '/api/v1/entries/sgv').expect(401);
    await http('get', '/api/v1/entries/sgv', B).expect(200);
    await admin.query(`UPDATE ${auth}.tenant_authorization_roles SET permissions=$2 WHERE tenant_id=$1`, [A, ['api:entries:read', 'api:entries:create', 'api:entries:delete']]);
    await http('get', '/api/v1/entries/sgv').expect(200);
    await admin.query(`DELETE FROM ${auth}.tenant_authorization_subject_roles WHERE tenant_id=$1`, [A]);
    await admin.query(`DELETE FROM ${auth}.tenant_authorization_subjects WHERE tenant_id=$1`, [A]);
    await http('get', '/api/v1/entries/sgv').expect(401);
    suspended = true;
    const prior = checks;
    await http('post', '/api/v1/entries', B).send([{ type: 'sgv', sgv: 999, date: at }]).expect(503);
    assert.equal(checks, prior + 1, 'actual route crosses operation-window adapter'); suspended = false;
    assert.deepEqual((await admin.query(`SELECT tenant_id,doc FROM ${ns}_entries.entries ORDER BY tenant_id`)).rows, before);
    await connection.end(); closed = true;
    await http('get', '/api/v1/entries/sgv', B).expect(500);
  });
});
