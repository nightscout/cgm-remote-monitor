'use strict';

const assert = require('node:assert/strict');
const { randomBytes, createHash, createHmac } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const express = require('express');
const request = require('supertest');
const { optInSuite } = require('./support/opt-in');
const { run } = require('../lib/migrations/postgres');
const scope = require('../lib/storage/tenant-scope');
const createAuthority = require('../lib/tenant-authorization/postgres');
const { createSecrets } = require('../lib/secrets/component');
const createAccess = require('../lib/server/tenant-app/data-access');
const createExchange = require('../lib/server/tenant-app/exchange');
const legacyAuthorization = require('../lib/server/tenant-app/legacy-authorization');
const { createTenantApp } = require('../lib/server/tenant-app');
const createResolver = require('../lib/tenant-resolution');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SUBJECT = 'same-subject';
const hash = value => createHash('sha1').update(value).digest('hex');

optInSuite(process.env.NS_REST_AUTHORITY_REVIEW_TEST === '1', 'NS_REST_AUTHORITY_REVIEW_TEST=1')(
  'Independent REST authority review (owned PostgreSQL, synthetic crypto provider)', function () {
    this.timeout(30000);
    const suffix = randomBytes(8).toString('hex');
    const container = 'ns-rest-authority-review-' + suffix;
    const namespace = 'authority_test';
    const role = 'review_app';
    const root = randomBytes(24).toString('hex');
    const signingKey = randomBytes(32);
    const credential = 'viewer-' + hash(hash(root) + SUBJECT).slice(0, 16);
    const effects = [];
    const grants = ['api:entries:read', 'api:entries:create'];
    let owned = false, admin, authority, appURI, mode, exchange, app;
    let wrongVerifier = false;
    const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe', timeout: 30000 }).trim();
    const table = name => namespace + '.tenant_authorization_' + name;
    const http = (tenant, method, path, token) => {
      let call = request(app)[method](path).set('Host', tenant === A ? 'a.example.test' : 'b.example.test');
      if (token !== undefined) call = call.set('Authorization', 'Bearer ' + token);
      return call;
    };

    before(async function () {
      mode = scope.getTenancyMode();
      scope.setTenancyMode('multi');
      const password = randomBytes(24).toString('hex');
      execFileSync('docker', ['run', '--name', container, '-d', '-p', '127.0.0.1::5432',
        '-e', 'POSTGRES_USER=operator', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=authority_test', 'postgres:16'],
      { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: 'pipe', timeout: 30000 });
      owned = true;
      const port = docker(['port', container, '5432/tcp']).split(':').pop();
      const adminURI = 'postgres://operator:' + password + '@127.0.0.1:' + port + '/authority_test';
      const deadline = Date.now() + 15000;
      let ready = false;
      while (!ready) {
        try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'operator']); ready = true; }
        catch (error) { if (Date.now() > deadline) throw error; await delay(100); }
      }
      admin = new Client({ connectionString: adminURI });
      await admin.connect();
      const version = (await admin.query('SHOW server_version')).rows[0].server_version;
      console.log('authority review PostgreSQL version:', version);
      await run('up', { direct: true, connectionString: adminURI, namespace,
        catalogue: require('../lib/tenant-authorization/postgres-candidate.json') });
      const appPassword = randomBytes(24).toString('hex');
      await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${appPassword}'`);
      await admin.query(`GRANT USAGE ON SCHEMA ${namespace} TO ${role}`);
      await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${namespace} TO ${role}`);
      const url = new URL(adminURI);
      url.username = role; url.password = appPassword; appURI = url.toString();
      for (const tenant of [A, B]) {
        await admin.query(`INSERT INTO ${table('config')} VALUES ($1, ARRAY['denied'])`, [tenant]);
        await admin.query(`INSERT INTO ${table('subjects')} (tenant_id, subject_id, display_name) VALUES ($1,$2,$3)`,
          [tenant, SUBJECT, 'Exact ' + tenant]);
        await admin.query(`INSERT INTO ${table('roles')} VALUES ($1,'viewer',$2)`, [tenant, grants]);
        await admin.query(`INSERT INTO ${table('subject_roles')} VALUES ($1,$2,'viewer')`, [tenant, SUBJECT]);
      }
      authority = await createAuthority({ connectionString: appURI, namespace });
      // Deliberately share the synthetic root and signing key. Audience binding
      // must remain decisive even when deployment key isolation is absent.
      const secrets = createSecrets({
        maxTokenLifetimeSeconds: 28800,
        authorize: async who => who.principal === 'verifier' && who.consumer === 'api',
        audit: async () => {},
        store: { async insert () { throw new Error('unused'); }, async get (tenant, id) {
          return { tenant, id, format: 1, ciphertext: JSON.stringify({ tenant, id, data: Buffer.from(root).toString('base64') }) };
        } },
        providerFor: async () => ({ signingVersion: 1,
          decrypt: async value => Buffer.from(value),
          sign: async value => createHmac('sha256', signingKey).update(value).digest(),
          verify: async (version, value, signature) => version === 1 &&
            signature.equals(createHmac('sha256', signingKey).update(value).digest())
        }),
        legacyAuthorityFor: async tenant => ({ reference: { tenant, id: 'root' },
          subjects: [{ subjectId: SUBJECT, tokenPrefix: 'viewer' }] })
      });
      const verifierContext = async tenant => ({ tenant: wrongVerifier ? B : tenant, principal: 'verifier', consumer: 'api' });
      exchange = createExchange({ secrets, authority, verifierContext });
      const dataAccess = createAccess({ secrets, authority, verifierContext, legacyCollections: ['entries'] });
      const router = express.Router();
      const auth = legacyAuthorization();
      router.use(express.json());
      router.use(auth.isPermitted('api:entries:read'));
      router.get('/entries', (req, res) => {
        effects.push({ tenant: scope.currentTenant(), method: 'read' });
        res.json({ tenant: req.tenantContext.tenant });
      });
      router.post('/entries', auth.isPermitted('api:entries:create'), (req, res) => {
        effects.push({ tenant: scope.currentTenant(), method: 'write', body: req.body });
        res.json({ tenant: req.tenantContext.tenant });
      });
      const unused = async () => { throw new Error('management must remain unreachable'); };
      app = createTenantApp({
        resolver: createResolver({ aliases: [{ host: 'a.example.test', tenant: A }, { host: 'b.example.test', tenant: B }] }),
        dataAccess, exchange, legacyRouter: router, dataRouter: express.Router(),
        verifyCredential: async () => null, authorizeRequest: async () => false,
        tenantSettings: { read: unused, replace: unused, rollback: unused },
        subjectPolicy: { read: unused, replace: unused }
      });
    });

    beforeEach(async function () {
      effects.length = 0;
      wrongVerifier = false;
      await admin.query(`UPDATE ${table('roles')} SET permissions=$1`, [grants]);
      assert.equal(docker(['inspect', '--format', '{{.State.Running}}', container]), 'true');
    });
    afterEach(() => assert.equal(docker(['inspect', '--format', '{{.State.Running}}', container]), 'true'));
    after(async function () {
      try { if (authority) await authority.close(); if (admin) await admin.end(); }
      finally { if (owned) docker(['rm', '-f', '-v', container]); if (mode !== undefined) scope.setTenancyMode(mode); }
    });

    it('binds a verified JWT to its host tenant despite shared keys and overlapping subject identifiers', async function () {
      const issuedA = await exchange({ tenant: A, credential });
      const issuedB = await exchange({ tenant: B, credential });
      await http(A, 'get', '/api/v1/entries', issuedA.token).expect(200);
      await http(B, 'get', '/api/v1/entries', issuedA.token).expect(401);
      await http(B, 'get', '/api/v2/entries', issuedB.token).expect(200);
      assert.deepEqual(effects.map(effect => effect.tenant), [A, B]);
    });

    it('rechecks committed current grants on the same JWT and never reaches denied write effects', async function () {
      const issued = await exchange({ tenant: A, credential });
      await http(A, 'post', '/api/v1/entries', issued.token).send({ sgv: 101 }).expect(200);
      await admin.query(`UPDATE ${table('roles')} SET permissions=ARRAY['api:entries:read'] WHERE tenant_id=$1`, [A]);
      await http(A, 'post', '/api/v1/entries', issued.token).send({ sgv: 102 }).expect(401);
      await http(A, 'get', '/api/v1/entries', issued.token).expect(200);
      await admin.query(`UPDATE ${table('roles')} SET permissions=ARRAY[]::text[] WHERE tenant_id=$1`, [A]);
      await http(A, 'get', '/api/v1/entries', issued.token).expect(401);
      assert.deepEqual(effects.map(effect => effect.method), ['write', 'read']);
    });

    it('refuses unavailable current authority without data-handler side effects or SQL detail', async function () {
      const issued = await exchange({ tenant: A, credential });
      await admin.query(`REVOKE SELECT ON ${table('roles')} FROM ${role}`);
      try {
        const response = await http(A, 'get', '/api/v1/entries', issued.token).expect(503);
        assert.deepEqual(response.body, { error: 'AUTHORITY_UNAVAILABLE' });
        assert.equal(effects.length, 0);
      } finally { await admin.query(`GRANT SELECT ON ${table('roles')} TO ${role}`); }
      await http(A, 'get', '/api/v1/entries', issued.token).expect(200);
    });

    it('retains root-secret precedence while refusing an invalid presented credential and verifier crosswire', async function () {
      await http(A, 'get', '/api/v1/entries', 'invalid').expect(401);
      await http(A, 'get', '/api/v1/entries', 'invalid').set('api-secret', hash(root)).expect(200);
      wrongVerifier = true;
      await http(A, 'get', '/api/v1/entries', 'invalid').set('api-secret', hash(root)).expect(503);
      assert.equal(effects.length, 1);
    });

    it('rejects authority mutation privileges including column-only grants before startup', async function () {
      for (const privilege of ['UPDATE', 'UPDATE (permissions)', 'TRIGGER', 'TRUNCATE']) {
        await admin.query(`GRANT ${privilege} ON ${table('roles')} TO ${role}`);
        try {
          await assert.rejects(createAuthority({ connectionString: appURI, namespace }), { code: 'TENANT_AUTHORITY_UNSAFE' });
        } finally { await admin.query(`REVOKE ${privilege} ON ${table('roles')} FROM ${role}`); }
        const restored = await createAuthority({ connectionString: appURI, namespace });
        await restored.close();
      }
    });
  });
