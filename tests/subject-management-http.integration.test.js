'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { run } = require('../lib/migrations/postgres');
const catalogue = require('../lib/tenant-authorization/postgres-candidate.json');
const credentialCatalogue = require('../lib/secrets/legacy-credentials-candidate.json');
const createStore = require('../lib/subject-admin/postgres');
const { createSubjectAdmin } = require('../lib/subject-admin/component');
const createAuthority = require('../lib/tenant-authorization/postgres');
const createLegacy = require('../lib/secrets/legacy-postgres');
const { createSecrets } = require('../lib/secrets/component');
const provider = require('./fixtures/tenant-credential-provider');
const scope = require('../lib/storage/tenant-scope');
const request = require('supertest');
const express = require('express');
const net = require('node:net');
const { createSubjectManagementApp } = require('../lib/server/subject-management-app');
const { createTenantApp } = require('../lib/server/tenant-app');
const createResolver = require('../lib/tenant-resolution');
const { optInSuite } = require('./support/opt-in');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SUBJECT = '000000000000000000000001';
const context = { tenant: A, principal: 'manager', consumer: 'admin' };
const namespace = 'subject_http';
const credentialNamespace = 'subject_identity';
const S = namespace + '.tenant_authorization_subjects';
const R = namespace + '.tenant_authorization_roles';
const L = namespace + '.tenant_authorization_subject_roles';
const C = credentialNamespace + '.legacy_credential_subjects';
const AUDIT = namespace + '.tenant_subject_admin_audit';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

optInSuite(process.env.NS_SUBJECT_MANAGEMENT_HTTP_DOCKER_TEST === '1',
  'NS_SUBJECT_MANAGEMENT_HTTP_DOCKER_TEST=1')('separate subject management HTTP (disposable PostgreSQL)', function () {
  this.timeout(30000);
  const container = 'ns-subject-http-' + crypto.randomBytes(8).toString('hex');
  let owned = false, previousMode, admin, adminURI, writerURI, readerURI, store, service;
  const workers = [];
  const roots = new Map([[A, crypto.randomBytes(24).toString('hex')], [B, crypto.randomBytes(24).toString('hex')]]);
  const cryptoProvider = provider();
  const encrypted = new Map();
  let originalCredential, issuedJWT, app, resolver;
  const dataApps = [];
  const state = {};
  let originalConnect;
  const connections = [];
  const database = 'subject_http_' + crypto.randomBytes(8).toString('hex');
  const verifierContext = tenant => ({ tenant, principal: 'verifier', consumer: 'api' });
  async function snapshot () {
    const result = {};
    for (const table of [S, L, C, AUDIT]) {
      result[table] = (await admin.query('SELECT * FROM ' + table + ' ORDER BY tenant_id, ' +
        (table === AUDIT ? 'event_id' : 'subject_id'))).rows;
    }
    return result;
  }
  async function protectedOperation (worker, tenant, credential) {
    const principal = await worker.secrets.verifyLegacyCredential(verifierContext(tenant), credential);
    return principal !== null && await worker.authority.authorize({ tenant, principal, permission: 'api:entries:create' });
  }
  before(async function () {
    previousMode = scope.getTenancyMode();
    scope.setTenancyMode('multi');
    const password = crypto.randomBytes(24).toString('hex');
    execFileSync('docker', ['run', '--name', container, '-d', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_USER=operator',
      '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=' + database, 'postgres:16'],
    { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
    owned = true;
    const port = docker(['port', container, '5432/tcp']).split(':').pop();
    adminURI = 'postgres://operator:' + password + '@127.0.0.1:' + port + '/' + database;
    const deadline = Date.now() + 15000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'operator']); ready = true; }
      catch { await sleep(100); }
    }
    assert.ok(ready);
    await run('up', { direct: true, connectionString: adminURI, namespace, catalogue });
    await run('check', { direct: true, connectionString: adminURI, namespace, catalogue });
    await run('up', { direct: true, connectionString: adminURI, namespace: credentialNamespace, catalogue: credentialCatalogue });
    admin = new Client({ connectionString: adminURI });
    await admin.connect();
    async function role (name) {
      const rolePassword = crypto.randomBytes(24).toString('hex');
      await admin.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${rolePassword}'`);
      await admin.query(`GRANT USAGE ON SCHEMA ${namespace}, ${credentialNamespace} TO ${name}`);
      const url = new URL(adminURI); url.username = name; url.password = rolePassword; return url.toString();
    }
    writerURI = await role('subject_writer');
    readerURI = await role('subject_reader');
    await admin.query(`GRANT SELECT, UPDATE, DELETE ON ${S}, ${C} TO subject_writer`);
    await admin.query(`GRANT SELECT ON ${R} TO subject_writer`);
    await admin.query(`GRANT SELECT, INSERT, DELETE ON ${L} TO subject_writer`);
    await admin.query(`GRANT INSERT ON ${AUDIT} TO subject_writer`);
    await admin.query(`GRANT SELECT ON ${S}, ${R}, ${L}, ${namespace}.tenant_authorization_config,
      ${C}, ${credentialNamespace}.legacy_credential_config TO subject_reader`);
    await admin.query(`INSERT INTO ${namespace}.tenant_authorization_config VALUES ($1, ARRAY['denied']), ($2, ARRAY['denied'])`, [A, B]);
    await admin.query(`INSERT INTO ${credentialNamespace}.legacy_credential_config VALUES ($1,'root'),($2,'root')`, [A, B]);
    await admin.query(`INSERT INTO ${R} VALUES ($1,'uploader',ARRAY['api:entries:create']),
      ($2,'uploader',ARRAY['api:treatments:create']), ($2,'foreign-only',ARRAY['*'])`, [A, B]);
    store = await createStore({ connectionString: writerURI, namespace, credentialNamespace });
    // Synthetic management authorization only, deliberately separate from data root/subject authority.
    service = createSubjectAdmin({ store, authorizeManagement: async actor => {
      if (state.authorityError) throw new Error('synthetic private authority detail');
      return !state.denied && actor.principal === 'manager';
    } });
    resolver = createResolver({ aliases: [{ host: 'one.example.org', tenant: A }, { host: 'two.example.org', tenant: B }] });
    app = createSubjectManagementApp({ resolver, subjectAdmin: service,
      async authenticateManagement ({ tenant, credential }) {
        state.authenticationCalls++;
        if (state.authenticationError) throw new Error('synthetic private provider detail');
        if (credential === 'synthetic-cross-tenant') return { ...context, tenant: B };
        if (credential === 'synthetic-invalid-actor') return { ...context, principal: 'bad principal' };
        if (credential !== 'synthetic-management-' + tenant) return null;
        return { tenant, principal: 'manager', consumer: 'admin' };
      }
    });
    for (let i = 0; i < 2; i++) {
      const worker = { authority: await createAuthority({ connectionString: readerURI, namespace }),
        legacy: await createLegacy({ connectionString: readerURI, namespace: credentialNamespace }) };
      worker.secrets = createSecrets({ providerFor: async () => cryptoProvider,
        store: { async get (tenant, id) { return encrypted.get(tenant + ':' + id); },
          async insert (record) { encrypted.set(record.tenant + ':' + record.id, record); } },
        authorize: async () => true, audit: async () => {}, maxTokenLifetimeSeconds: 28800,
        legacyAuthorityFor: tenant => worker.legacy.read(tenant) });
      workers.push(worker);
      const dataRouter = express.Router();
      dataRouter.get('/entries', (req, res) => res.json({ allowed: true }));
      dataApps.push(createTenantApp({ resolver, dataRouter,
        verifyCredential: async () => null, authorizeRequest: async () => false,
        tenantSettings: { read () {}, replace () {}, rollback () {} }, subjectPolicy: { read () {}, replace () {} },
        dataAccess: async ({ tenant, request: incoming }) => {
          const token = (incoming.get('Authorization') || '').replace(/^Bearer /, '');
          const principal = await worker.secrets.verifyLegacyCredential(verifierContext(tenant), { token });
          if (!principal || !await worker.authority.authorize({ tenant, principal, permission: 'api:entries:create' })) {
            throw Object.assign(new Error('data refused'), { code: 'TENANT_DATA_FORBIDDEN' });
          }
          return { tenant, principal: principal.subjectId, consumer: 'test' };
        }
      }));
    }
    for (const tenant of [A, B]) {
      await workers[0].secrets.encrypt(verifierContext(tenant), 'root', Buffer.from(roots.get(tenant)));
    }
    const enclave = require('../lib/server/enclave')();
    enclave.setApiKey(roots.get(A));
    originalCredential = 'original-' + enclave.getSubjectHash(SUBJECT).substring(0, 16);
    issuedJWT = await workers[0].secrets.signJWT(verifierContext(A), originalCredential, 300);
    // HTTP and PostgreSQL may connect only to this fixture's loopback services.
    originalConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
      const options = Array.isArray(args[0]) ? args[0][0] : args[0];
      const host = typeof options === 'object' ? options.host : args[1];
      connections.push(host);
      assert.ok(['127.0.0.1', '::1', 'localhost'].includes(host), 'unexpected network egress: ' + host);
      return originalConnect.apply(this, args);
    };
  });
  beforeEach(async function () {
    Object.assign(state, { denied: false, authenticationError: false, authorityError: false, authenticationCalls: 0 });
    await admin.query('DELETE FROM ' + L);
    await admin.query('DELETE FROM ' + S);
    await admin.query('DELETE FROM ' + C);
    await admin.query('DELETE FROM ' + AUDIT);
    await admin.query(`INSERT INTO ${S} (tenant_id,subject_id,display_name,notes,created_at) VALUES
      ($1,$3,'Original','preserved','2026-01-01T00:00:00.000Z'),($2,$3,'Foreign','foreign notes','2026-02-01T00:00:00.000Z')`, [A, B, SUBJECT]);
    await admin.query(`INSERT INTO ${C} VALUES ($1,$3,'original'),($2,$3,'foreign')`, [A, B, SUBJECT]);
    await admin.query(`INSERT INTO ${L} VALUES ($1,$3,'uploader'),($2,$3,'uploader')`, [A, B, SUBJECT]);
  });
  after(async function () {
    if (originalConnect) net.Socket.prototype.connect = originalConnect;
    try {
      if (store) await store.close();
      for (const worker of workers) { await worker.authority.close(); await worker.legacy.close(); }
      if (admin) await admin.end();
    } finally {
      scope.setTenancyMode(previousMode);
      if (owned) docker(['rm', '-f', container]);
    }
  });

  const path = '/api/v2/authorization/subjects';
  async function management (method, target = path, body, options = {}) {
    let pending = request(options.app || app)[method](target).set('Host', options.host || 'one.example.org');
    const credential = Object.hasOwn(options, 'credential') ? options.credential : 'synthetic-management-' + A;
    if (credential !== null) pending = pending.set('Authorization', 'Bearer ' + credential);
    if (body !== undefined) pending = pending.send(body);
    const response = await pending;
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['x-powered-by'], undefined);
    assert.equal(response.headers.etag, undefined);
    assert.match(response.headers['content-type'], /^application\/json/);
    assert.equal(response.headers.location, undefined);
    assert.doesNotMatch(response.text, /synthetic private|postgres:|accessToken|digest|stack/);
    return response;
  }
  async function data (index, expected, tenant = A) {
    await request(dataApps[index]).get('/api/v3/entries')
      .set('Host', tenant === A ? 'one.example.org' : 'two.example.org')
      .set('Authorization', 'Bearer ' + issuedJWT).expect(expected);
  }
  function assertResponse (response, status, error) {
    assert.equal(response.status, status, response.text);
    if (error) assert.deepEqual(response.body, { error });
  }

  it('requires explicit composition dependencies before returning the dormant Express app', function () {
    assert.throws(() => createSubjectManagementApp(), TypeError);
    assert.throws(() => createSubjectManagementApp({ resolver, subjectAdmin: service }), TypeError);
    assert.equal(typeof createSubjectManagementApp({ resolver, subjectAdmin: service,
      authenticateManagement: async () => null }).listen, 'function');
  });

  it('renames via shipping verb/body identity, preserves metadata and keeps the earlier JWT usable', async function () {
    for (let i = 0; i < workers.length; i++) await data(i, 200);
    const response = await management('put', path, { _id: SUBJECT, name: 'HTTP Renamed', roles: ['uploader'] });
    assertResponse(response, 200);
    assert.deepEqual(response.body, { subjectId: SUBJECT, name: 'HTTP Renamed', roles: ['uploader'], notes: 'preserved',
      created_at: '2026-01-01T00:00:00.000Z' });
    for (let i = 0; i < workers.length; i++) {
      await data(i, 200);
      assert.equal(await protectedOperation(workers[i], A, { apiSecret: originalCredential }), true);
    }
    const rows = await snapshot();
    assert.equal(rows[C].find(row => row.tenant_id === A).token_prefix, 'httprename');
    assert.equal(rows[S].find(row => row.tenant_id === B).display_name, 'Foreign');
    assert.equal(rows[AUDIT][0].principal, 'manager');
    assert.equal(rows[AUDIT][0].consumer, 'admin');
    assert.doesNotMatch(JSON.stringify(rows[AUDIT]), /HTTP Renamed|preserved|original-/);
  });

  it('revokes omitted roles on the next protected HTTP operation using the same earlier token', async function () {
    for (let i = 0; i < workers.length; i++) await data(i, 200);
    const response = await management('put', path, { _id: SUBJECT, name: 'Original', created_at: '' });
    assertResponse(response, 200);
    assert.deepEqual(response.body.roles, []);
    assert.equal(response.body.notes, 'preserved');
    assert.equal(response.body.created_at, '2026-01-01T00:00:00.000Z');
    for (let i = 0; i < workers.length; i++) {
      await data(i, 403);
      assert.equal(await protectedOperation(workers[i], A, { apiSecret: originalCredential }), false);
    }
    assert.equal((await admin.query('SELECT * FROM ' + L + ' WHERE tenant_id = $1', [B])).rows.length, 1);
  });

  it('deletes through HTTP and refuses the same JWT on independent serving pools without deleting a foreign twin', async function () {
    for (let i = 0; i < workers.length; i++) await data(i, 200);
    const response = await management('delete', path + '/' + SUBJECT);
    assertResponse(response, 200);
    assert.deepEqual(response.body, {});
    for (let i = 0; i < workers.length; i++) {
      await data(i, 403);
      assert.equal(await protectedOperation(workers[i], A, { apiSecret: originalCredential }), false);
    }
    const rows = await snapshot();
    for (const table of [S, L, C]) assert.deepEqual(rows[table].map(row => row.tenant_id), [B]);
    assertResponse(await management('delete', path + '/' + SUBJECT), 404, 'SUBJECT_ADMIN_NOT_FOUND');
  });

  it('uses authenticated matching tenant identity and rejects missing, duplicate, wrong-plane and cross-tenant credentials', async function () {
    const before = await snapshot();
    for (const credential of [null, 'synthetic-data-root', originalCredential, issuedJWT,
      'synthetic-management-' + B, 'synthetic-cross-tenant', 'synthetic-invalid-actor']) {
      assertResponse(await management('put', path, { _id: SUBJECT, name: 'Refused' }, { credential }), 401, 'CREDENTIAL_REFUSED');
    }
    const duplicate = await request(app).put(path).set('Host', 'one.example.org')
      .set('Authorization', ['Bearer synthetic-management-' + A, 'Bearer synthetic-management-' + A])
      .send({ _id: SUBJECT, name: 'Refused' });
    assertResponse(duplicate, 401, 'CREDENTIAL_REFUSED');
    const calls = state.authenticationCalls;
    assertResponse(await management('put', path, { _id: SUBJECT, name: 'Refused' }, { host: 'unknown.example.org' }),
      404, 'TENANT_REFUSED');
    assert.equal(state.authenticationCalls, calls);
    const proxy = await request(app).put(path).set('Host', 'one.example.org')
      .set('X-Resolved-Tenant', B).set('Authorization', 'Bearer synthetic-management-' + A)
      .send({ _id: SUBJECT, name: 'Proxy Assertion' });
    assertResponse(proxy, 400, 'TENANT_REFUSED');
    assert.equal(state.authenticationCalls, calls);
    assert.deepEqual(await snapshot(), before);
    const result = await management('put', path, { _id: SUBJECT, name: 'Foreign Managed', roles: ['uploader'] },
      { host: 'two.example.org', credential: 'synthetic-management-' + B });
    assertResponse(result, 200);
    assert.equal((await workers[1].authority.subjectSnapshot({ tenant: A, principal: { kind: 'subject', subjectId: SUBJECT } })).sub,
      'Original');
    assert.equal((await workers[1].authority.subjectSnapshot({ tenant: B, principal: { kind: 'subject', subjectId: SUBJECT } })).sub,
      'Foreign Managed');
    await data(0, 200);
    await data(1, 403, B);
  });

  it('sanitizes prefixed and plain resolver outages as unavailable before any authentication or write', async function () {
    const before = await snapshot();
    let calls = 0;
    for (const error of [Object.assign(new Error('synthetic private resolver detail'),
      { code: 'TENANT_AUTHORITY_UNAVAILABLE' }), new Error('synthetic private resolver detail')]) {
      const unavailable = createSubjectManagementApp({
        resolver: { resolve () { throw error; } }, subjectAdmin: service,
        authenticateManagement: async () => { calls++; return context; }
      });
      assertResponse(await management('put', path, { _id: SUBJECT, name: 'Unavailable' }, { app: unavailable }),
        503, 'AUTHORITY_UNAVAILABLE');
    }
    assert.equal(calls, 0);
    assert.deepEqual(await snapshot(), before);
  });

  it('refuses body identity injection, derived tokens, malformed metadata and unavailable management authority without writes', async function () {
    const before = await snapshot();
    for (const input of [null, [], { name: 'Missing ID' }, { _id: 'bad id', name: 'Bad ID' },
      { _id: SUBJECT, name: '' }, { _id: SUBJECT, name: 'x', tenant: B },
      { _id: SUBJECT, name: 'x', principal: 'manager' }, { _id: SUBJECT, name: 'x', consumer: 'admin' },
      { _id: SUBJECT, name: 'x', accessToken: 'derived' }, { _id: SUBJECT, name: 'x', roles: ['uploader', 'uploader'] },
      { _id: SUBJECT, name: 'x', roles: 'uploader' }, { _id: SUBJECT, name: 'x', notes: null },
      { _id: SUBJECT, name: 'x', created_at: 'invalid date' }]) {
      const response = await management('put', path, input);
      assert.ok([400, 415].includes(response.status), response.text);
    }
    state.denied = true;
    assertResponse(await management('put', path, { _id: SUBJECT, name: 'Denied' }), 403, 'SUBJECT_ADMIN_FORBIDDEN');
    state.denied = false;
    state.authenticationError = true;
    assertResponse(await management('delete', path + '/' + SUBJECT), 503, 'AUTHORITY_UNAVAILABLE');
    state.authenticationError = false;
    state.authorityError = true;
    assertResponse(await management('put', path, { _id: SUBJECT, name: 'Unavailable' }), 503, 'AUTHORITY_UNAVAILABLE');
    assert.deepEqual(await snapshot(), before);
  });

  it('bounds JSON and media types and reports unsupported methods/paths with protective response headers', async function () {
    const before = await snapshot();
    assertResponse(await management('put', path, '{broken'), 415, 'REQUEST_MEDIA_TYPE');
    const malformed = await request(app).put(path).set('Host', 'one.example.org')
      .set('Authorization', 'Bearer synthetic-management-' + A).set('Content-Type', 'application/json').send('{broken');
    assertResponse(malformed, 400, 'REQUEST_INVALID');
    assert.equal(malformed.headers['cache-control'], 'no-store');
    assert.equal(malformed.headers['referrer-policy'], 'no-referrer');
    assertResponse(await management('put', path, { _id: SUBJECT, name: 'x', notes: 'x'.repeat(65536) }),
      413, 'REQUEST_TOO_LARGE');
    assertResponse(await management('delete', path + '/' + SUBJECT, { name: 'ignored?' }), 400, 'REQUEST_INVALID');
    assertResponse(await management('delete', path + '/' + SUBJECT, 'ignored text'), 415, 'REQUEST_MEDIA_TYPE');
    assertResponse(await management('delete', path + '/' + SUBJECT, []), 400, 'REQUEST_INVALID');
    for (const method of ['get', 'post', 'patch']) {
      const response = await management(method);
      assertResponse(response, 405, 'METHOD_REFUSED');
      assert.equal(response.headers.allow, 'PUT');
    }
    const wrongVerb = await management('put', path + '/' + SUBJECT, { name: 'Wrong verb' });
    assertResponse(wrongVerb, 405, 'METHOD_REFUSED');
    assert.equal(wrongVerb.headers.allow, 'DELETE');
    for (const target of ['/api/v1/authorization/subjects', '/api/v2/authorization/roles', '/api/v3/entries',
      '/api/v1/tenant/settings', '/api/v1/operator/tenants/' + A + '/policy']) {
      assertResponse(await management('get', target), 404, 'NOT_FOUND');
    }
    assert.deepEqual(await snapshot(), before);
  });

  it('preserves known-role-only and metadata refusal mappings without partial changes', async function () {
    const before = await snapshot();
    for (const role of ['unknown', 'foreign-only', 'readable']) {
      assertResponse(await management('put', path, { _id: SUBJECT, name: 'Invalid Role', roles: [role] }),
        400, 'SUBJECT_ADMIN_UNKNOWN_ROLE');
    }
    assertResponse(await management('put', path, { _id: 'absent', name: 'Missing' }), 404, 'SUBJECT_ADMIN_NOT_FOUND');
    assert.deepEqual(await snapshot(), before);
    await admin.query('DELETE FROM ' + C + ' WHERE tenant_id = $1', [A]);
    const incomplete = await snapshot();
    assertResponse(await management('put', path, { _id: SUBJECT, name: 'Incomplete' }), 409, 'SUBJECT_ADMIN_METADATA_MISSING');
    assertResponse(await management('delete', path + '/' + SUBJECT), 409, 'SUBJECT_ADMIN_METADATA_MISSING');
    assert.deepEqual(await snapshot(), incomplete);
  });

  it('clears notes explicitly, accepts creation time and serializes concurrent HTTP replacement/deletion', async function () {
    let response = await management('put', path, { _id: SUBJECT, name: 'Metadata', roles: ['uploader'], notes: '',
      created_at: '2026-03-01T00:00:00.000Z' });
    assertResponse(response, 200);
    assert.equal(response.body.notes, '');
    assert.equal(response.body.created_at, '2026-03-01T00:00:00.000Z');
    const results = await Promise.all([
      management('put', path, { _id: SUBJECT, name: 'First', roles: ['uploader'], notes: 'one' }),
      management('put', path, { _id: SUBJECT, name: 'Second', notes: 'two' })
    ]);
    for (response of results) assertResponse(response, 200);
    const row = (await admin.query('SELECT display_name,notes FROM ' + S + ' WHERE tenant_id = $1', [A])).rows[0];
    assert.equal((await workers[1].legacy.read(A)).subjects[0].tokenPrefix, row.display_name.toLowerCase());
    assert.equal(row.notes, row.display_name === 'First' ? 'one' : 'two');
    assert.deepEqual((await admin.query('SELECT role_name FROM ' + L + ' WHERE tenant_id = $1', [A])).rows,
      row.display_name === 'First' ? [{ role_name: 'uploader' }] : []);
    const raced = await Promise.all([management('put', path, { _id: SUBJECT, name: 'Racing' }),
      management('delete', path + '/' + SUBJECT)]);
    assert.ok([200, 404].includes(raced[0].status));
    assertResponse(raced[1], 200);
    await data(1, 403);
  });

  it('rolls back final-audit persistence failure and sanitizes the backend failure response', async function () {
    const before = await snapshot();
    await admin.query(`ALTER TABLE ${AUDIT} ADD CONSTRAINT fail_http_control CHECK (operation = 'impossible')`);
    try {
      assertResponse(await management('put', path, { _id: SUBJECT, name: 'Rollback' }), 503, 'SUBJECT_ADMIN_STORE_UNAVAILABLE');
      assertResponse(await management('delete', path + '/' + SUBJECT), 503, 'SUBJECT_ADMIN_STORE_UNAVAILABLE');
      assert.deepEqual(await snapshot(), before);
      await data(1, 200);
    } finally { await admin.query(`ALTER TABLE ${AUDIT} DROP CONSTRAINT fail_http_control`); }
  });

  it('leaves management routes absent from both independent data apps and performs no network egress', async function () {
    const before = await snapshot();
    for (const dataApp of dataApps) {
      for (const version of [1, 2, 3]) {
        for (const credential of [issuedJWT, 'synthetic-management-' + A]) {
          for (const [method, target] of [['put', '/api/v' + version + '/authorization/subjects'],
            ['delete', '/api/v' + version + '/authorization/subjects/' + SUBJECT]]) {
            const response = await request(dataApp)[method](target).set('Host', 'one.example.org')
              .set('Authorization', 'Bearer ' + credential).send({ _id: SUBJECT, name: 'Not Mounted' });
            assert.ok([401, 403, 404, 405].includes(response.status), response.text);
          }
        }
      }
    }
    assert.deepEqual(await snapshot(), before);
    assert.ok(connections.length > 0);
    assert.ok(connections.every(host => ['127.0.0.1', '::1', 'localhost'].includes(host)));
  });
});
