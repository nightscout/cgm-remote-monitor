'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const request = require('supertest');
const connect = require('../lib/storage/postgres-connection');
const entriesWrite = require('../lib/storage/postgres-entries-write');
const scope = require('../lib/storage/tenant-scope');
const createResolver = require('../lib/tenant-resolution');
const { createTenantApp } = require('../lib/server/tenant-app');
const entriesLab = require('./fixtures/tenant-entries-lab');
const { run } = require('../lib/migrations/postgres');
const catalogue = require('../migrations/candidates/postgres-entries-v1.json');
const { optInSuite } = require('./support/opt-in');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const tenants = [A, B];
const docker = args => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000
}).trim();

optInSuite(process.env.NS_TENANT_HTTP_DOCKER_TEST === '1', 'NS_TENANT_HTTP_DOCKER_TEST=1')(
  'M3 tenant entries HTTP lab (disposable PostgreSQL Docker)', function () {
    this.timeout(60000);
    const name = 'ns-tenant-http-' + randomBytes(8).toString('hex');
    const namespace = 'tenant_http';
    const table = namespace + '.entries';
    const role = 'tenant_http_app';
    const credentials = new Map(tenants.map(tenant => [randomBytes(24).toString('hex'), tenant]));
    let owned = false, admin, connection, server, migration, appURL, mode;
    let revoked = false, authorityUnavailable = false;
    let readinessChecks = 0;
    const ownerUnavailable = async () => { throw new Error('owner services not installed in entries lab'); };
    const options = {
      resolver: createResolver({ aliases: [
        { host: 'one.example.test', tenant: A }, { host: 'two.example.test', tenant: B }
      ] }),
      async verifyCredential ({ tenant, credential }) {
        return credentials.get(credential) === tenant
          ? { tenant, principal: 'uploader', consumer: 'lab' } : null;
      },
      async authorizeRequest (context, action) {
        if (authorityUnavailable) throw new Error('private authority failure');
        return !revoked && tenants.includes(context.tenant) && action.plane === 'data' &&
          ((action.method === 'GET' && /^\/entries\/[^/]+$/.test(action.path)) ||
           (action.method === 'POST' && action.path === '/entries') ||
           (action.method === 'PATCH' && /^\/entries\/[^/]+$/.test(action.path)));
      },
      tenantSettings: { read: ownerUnavailable, replace: ownerUnavailable, rollback: ownerUnavailable },
      subjectPolicy: { read: ownerUnavailable, replace: ownerUnavailable }
    };

    async function stopHTTP () {
      if (server) {
        const closing = server;
        server = null;
        await new Promise((resolve, reject) => closing.close(error => error ? reject(error) : resolve()));
      }
    }

    async function startHTTP (namespaceOverride = namespace) {
      const readiness = { ...migration, namespace: namespaceOverride };
      if (!(await run('check', readiness)).current) {
        throw new Error('tenant entries schema is not current');
      }
      const app = createTenantApp({
        ...options,
        dataRouter: entriesLab({
          connection, table: namespaceOverride + '.entries',
          async checkReady () {
            readinessChecks++;
            return (await run('check', readiness)).current;
          }
        })
      });
      server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      assert.equal(server.address().address, '127.0.0.1');
    }

    function http (tenant, method = 'get', path = '/api/v3/entries/shared-entry', credentialTenant = tenant) {
      const credential = [...credentials].find(([, id]) => id === credentialTenant)?.[0] || 'invalid';
      return request(server)[method](path)
        .set('Host', tenant === A ? 'one.example.test' : 'two.example.test')
        .set('Authorization', 'Bearer ' + credential).set('Accept', 'application/json')
        .timeout({ response: 5000, deadline: 10000 });
    }

    async function persisted () {
      const result = await admin.query(
        'SELECT tenant_id, id_kind, doc FROM "' + namespace + '".entries ORDER BY tenant_id, "_id"');
      return result.rows;
    }

    before(async function () {
      mode = scope.getTenancyMode();
      scope.setTenancyMode('multi');
      const password = randomBytes(24).toString('hex');
      execFileSync('docker', ['run', '--rm', '--name', name, '-d', '-p', '127.0.0.1::5432',
        '-e', 'POSTGRES_USER=operator', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=tenant_http', 'postgres:16'],
      { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
      owned = true;
      const port = docker(['port', name, '5432/tcp']).split(':').pop();
      const connectionString = 'postgres://operator:' + password + '@127.0.0.1:' + port + '/tenant_http';
      const deadline = Date.now() + 20000;
      for (;;) {
        assert.equal(docker(['inspect', '--format', '{{.State.Running}}', name]), 'true');
        try {
          docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'operator', '-d', 'tenant_http']);
          break;
        } catch (error) {
          if (![1, 2].includes(error.status) || Date.now() >= deadline) throw error;
          await delay(100);
        }
      }
      admin = new Client({ connectionString });
      await admin.connect();
      migration = { direct: true, connectionString, namespace, catalogue };
      assert.deepEqual((await run('up', migration)).done, ['0001_entries', '0002_entries_insertion_order']);
      const appPassword = randomBytes(24).toString('hex');
      // Fixture-only role grants, following the migration integration harness.
      // All entries DDL comes from the reviewed candidate via the real runner.
      await admin.query('CREATE ROLE "' + role + '" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD \'' + appPassword + '\'');
      await admin.query('GRANT USAGE ON SCHEMA "' + namespace + '" TO "' + role + '"');
      await admin.query('GRANT SELECT, INSERT, UPDATE, DELETE ON "' + namespace + '".entries TO "' + role + '"');
      const url = new URL(connectionString);
      url.username = role;
      url.password = appPassword;
      appURL = url.toString();
      connection = await connect({ connectionString: appURL, max: 1 });
      await startHTTP();
      // Verify the exact test listener is responsive, not merely allocated.
      await http(A, 'get', '/api/v3/entries/not-present').expect(404);
    });

    beforeEach(async function () {
      revoked = false;
      authorityUnavailable = false;
      await admin.query('DELETE FROM "' + namespace + '".entries');
      const writer = entriesWrite({ connection, table });
      for (const [tenant, sgv] of [[A, 100], [B, 200]]) {
        await connection.withTenant(tenant, async () => {
          for (const [id, identifier] of [['shared-id', 'shared-entry'], [
            tenant === A ? 'only-a-id' : 'only-b-id', tenant === A ? 'only-a' : 'only-b'
          ]]) {
            await writer.insertOne({
              _id: id, identifier, sgv, type: 'sgv', date: 1793664000000,
              app: 'tenant-http-lab', utcOffset: 0, srvCreated: 1793664000000, srvModified: 1793664000000
            }, { normalize: false });
          }
        });
      }
    });

    after(async function () {
      try {
        await stopHTTP();
      } finally {
        try {
          if (connection) await connection.end();
        } finally {
          try { if (admin) await admin.end(); } finally {
            try { if (owned) docker(['rm', '-f', name]); } finally {
              if (mode !== undefined) scope.setTenancyMode(mode);
            }
          }
        }
      }
    });

    it('serves the real API3 GET handler with overlapping identifiers and storage IDs', async function () {
      for (const [tenant, sgv] of [[A, 100], [B, 200], [A, 100]]) {
        const own = await http(tenant).expect(200);
        assert.equal(own.body.result.sgv, sgv);
        assert.equal(own.body.result.identifier, 'shared-entry');
        assert.equal(own.headers['cache-control'], 'no-store');
        const byId = await http(tenant, 'get', '/api/v3/entries/shared-id').expect(200);
        assert.equal(byId.body.result.sgv, sgv);
      }
    });

    it('commits different PATCH outcomes through M1 while reusing one physical pool connection', async function () {
      const responses = await Promise.all([
        http(A, 'patch').send({ sgv: 111 }).expect(200),
        http(B, 'patch').send({ sgv: 222 }).expect(200)
      ]);
      assert.ok(responses.every(response => response.body.outcome === 'merged'));
      for (const [tenant, sgv] of [[A, 111], [B, 222], [A, 111]]) {
        assert.equal((await http(tenant).expect(200)).body.result.sgv, sgv);
      }
      const shared = (await persisted()).filter(row => row.doc._id === 'shared-id');
      assert.deepEqual(shared.map(row => [row.tenant_id, row.doc.sgv, row.doc.modifiedBy]),
        [[A, 111, 'uploader'], [B, 222, 'uploader']]);
    });

    it('persists POST uploads with the same identifier across app and database pool reconnect', async function () {
      for (const [tenant, sgv] of [[A, 123], [B, 234]]) {
        const created = await http(tenant, 'post', '/api/v3/entries').send({
          identifier: 'same-upload', date: 1793664000001, utcOffset: 0, app: 'tenant-http-lab', type: 'sgv', sgv
        }).expect(201);
        assert.equal(created.body.outcome, 'inserted');
        assert.equal(created.body.identifier, 'same-upload');
      }
      const before = await persisted();
      const uploads = before.filter(row => row.doc.identifier === 'same-upload');
      assert.equal(uploads.length, 2);
      assert.notEqual(uploads[0].doc._id, uploads[1].doc._id);
      await stopHTTP();
      await connection.end();
      connection = await connect({ connectionString: appURL, max: 1 });
      await startHTTP();
      for (const [tenant, sgv] of [[B, 234], [A, 123]]) {
        assert.equal((await http(tenant, 'get', '/api/v3/entries/same-upload').expect(200)).body.result.sgv, sgv);
      }
      assert.deepEqual(await persisted(), before);
    });

    it('explicitly refuses credentials from the other tenant for both reads and writes', async function () {
      const before = await persisted();
      const checks = readinessChecks;
      for (const [tenant, foreign] of [[A, B], [B, A]]) {
        for (const method of ['get', 'patch', 'post']) {
          const response = await http(tenant, method,
            method === 'post' ? '/api/v3/entries' : '/api/v3/entries/shared-entry', foreign)
            .send(method === 'get' ? undefined : { sgv: 999 }).expect(401);
          assert.deepEqual(response.body, { error: 'CREDENTIAL_REFUSED' });
        }
      }
      assert.equal(readinessChecks, checks, 'foreign credentials must not reach the data adapter');
      assert.deepEqual(await persisted(), before);
    });

    it('does not disclose or modify other-tenant-only identifiers or accept body/header tenant selectors', async function () {
      const before = await persisted();
      for (const [tenant, otherOnly] of [[A, 'only-b'], [B, 'only-a']]) {
        const path = '/api/v3/entries/' + otherOnly;
        await http(tenant, 'get', path).expect(404);
        await http(tenant, 'patch', path).send({ sgv: 999 }).expect(404);
        await http(tenant, 'patch').send({ tenant_id: tenant === A ? B : A, sgv: 999 }).expect(400);
        await http(tenant).set('X-Resolved-Tenant', tenant === A ? B : A).expect(400);
        await http(tenant).set('X-Forwarded-Host', tenant === A ? 'two.example.test' : 'one.example.test').expect(400);
      }
      assert.deepEqual(await persisted(), before);
    });

    it('rechecks current authority and fails closed on revocation or authority failure', async function () {
      await http(A).expect(200);
      const before = await persisted();
      revoked = true;
      await http(A).expect(403);
      await http(A, 'patch').send({ sgv: 999 }).expect(403);
      revoked = false;
      authorityUnavailable = true;
      const response = await http(B, 'patch').send({ sgv: 999 }).expect(503);
      assert.deepEqual(response.body, { error: 'AUTHORITY_UNAVAILABLE' });
      assert.deepEqual(await persisted(), before);
    });

    it('refuses startup with an unapplied candidate without creating schema', async function () {
      const before = await persisted();
      await stopHTTP();
      try {
        await assert.rejects(startHTTP('tenant_http_absent'), /schema is stale|checksum drift/);
        assert.equal(server, null, 'the listener must not bind before schema readiness');
        assert.equal((await admin.query("SELECT to_regnamespace('tenant_http_absent') AS schema")).rows[0].schema, null);
      } finally {
        await startHTTP();
      }
      assert.deepEqual(await persisted(), before);
    });

    it('refuses requests and startup on a stale migration ledger, then recovers without writes', async function () {
      await http(A).expect(200);
      const before = await persisted();
      await admin.query('UPDATE "' + namespace + '".schema_migrations SET checksum = $1 WHERE name = $2',
        ['0'.repeat(64), '0001_entries']);
      try {
        for (const tenant of tenants) {
          for (const method of ['get', 'patch', 'post']) {
            const response = await http(tenant, method, method === 'post' ? '/api/v3/entries' : '/api/v3/entries/shared-entry')
              .send(method === 'get' ? undefined : { sgv: 999 }).expect(503);
            assert.deepEqual(response.body, { error: 'AUTHORITY_UNAVAILABLE' });
          }
        }
        assert.deepEqual(await persisted(), before);
        await stopHTTP();
        await assert.rejects(startHTTP(), /schema is stale|checksum drift/);
        assert.equal(server, null, 'the listener must not bind with a stale migration ledger');
      } finally {
        await admin.query('UPDATE "' + namespace + '".schema_migrations SET checksum = $1 WHERE name = $2',
          [catalogue.migrations[0].checksum, '0001_entries']);
      }
      await startHTTP();
      await http(A).expect(200);
      await http(B).expect(200);
    });

    it('refuses a pending required migration even when the entries table still exists', async function () {
      const before = await persisted();
      const removed = await admin.query('DELETE FROM "' + namespace + '".schema_migrations WHERE name = $1 RETURNING *',
        ['0002_entries_insertion_order']);
      try {
        assert.deepEqual((await run('status', migration)).pending, ['0002_entries_insertion_order']);
        await http(A).expect(503);
        await http(B, 'patch').send({ sgv: 999 }).expect(503);
        await http(A, 'post', '/api/v3/entries').send({
          identifier: 'must-not-write', date: 1793664000001, utcOffset: 0, app: 'tenant-http-lab', sgv: 999
        }).expect(503);
        assert.deepEqual(await persisted(), before);
        await stopHTTP();
        await assert.rejects(startHTTP(), /schema is stale|checksum drift/);
        assert.equal(server, null, 'the listener must not bind with a pending required migration');
      } finally {
        const row = removed.rows[0];
        await admin.query('INSERT INTO "' + namespace + '".schema_migrations (name, checksum, applied_at) VALUES ($1, $2, $3)',
          [row.name, row.checksum, row.applied_at]);
      }
      await startHTTP();
      await http(A).expect(200);
    });

    it('keeps operator and owner services out of the public data plane', async function () {
      const before = await persisted();
      await http(A, 'get', '/api/v1/operator/tenants/' + B + '/policy').expect(404);
      await http(A, 'get', '/api/v3/operator/tenants/' + B + '/policy').expect(403);
      await http(A, 'get', '/api/v1/tenant/settings').expect(403);
      assert.deepEqual(await persisted(), before);
    });
  });
