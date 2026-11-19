'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { request: httpRequest } = require('node:http');
const express = require('express');
const request = require('supertest');
const settings = require('../lib/server/serve/deployment-settings');
const { catalogueDigest } = require('../lib/subject-admin/owner-policy');
const { createTenantApp } = require('../lib/server/tenant-app');
const createResolver = require('../lib/tenant-resolution');
const { optInSuite } = require('./support/opt-in');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const TARGET = 'target', MANAGER = 'manager';
const endpoint = '/api/v2/authorization/subjects';
const catalogue = ['api:entries:read', 'api:entries:create'];

// Exercise owner subject management with provisioned synthetic tenants and scoped service logins.
optInSuite(process.env.NS_OWNER_PREVIEW_TEST === '1',
  'NS_OWNER_PREVIEW_TEST=1 with owned PostgreSQL and Vault')('explicit headless owner executable composition', function () {
    this.timeout(60000);
    const registryLab = require('./fixtures/multitenant-preview-replicas')({ restartableDatabase: true });
    const namespaces = { authorization: 'preview_authorization', credentials: 'preview_legacy', access: 'preview_access' };
    const consumer = settings.IDENTITY.managementConsumer;
    const children = new Set(), workers = [];
    let admin, directory, serving, readerRole;
    const t = table => '"' + namespaces.authorization + '".' + table;
    const a = table => '"' + namespaces.access + '".access_' + table;
    const c = '"' + namespaces.credentials + '".legacy_credential_subjects';
    async function token (tenant = A, override = {}, header = {}) {
      const now = Math.floor(Date.now() / 1000);
      return registryLab.signToken(tenant, { purpose: 'management',
        header: { alg: 'EdDSA', typ: 'ns-access+jwt', kid: 'management1', ...header },
        claims: { iss: settings.IDENTITY.managementIssuer, aud: settings.IDENTITY.managementAudience, tid: tenant, purpose: 'management', sub: MANAGER, sid: 'session', cv: 1,
          iat: now, nbf: now, exp: now + 600, ...override } });
    }
    async function start (overrides = {}, expectReady = true) {
      const worker = { stdout: '', stderr: '' };
      const child = spawn(process.execPath, [path.resolve(__dirname, '../bin/nightscout.js'), 'multitenant', 'tenant-admin'],
        { cwd: directory, env: { ...serving, NS_SERVE_INTERNAL_SOCKET: path.join(directory, crypto.randomUUID().slice(0, 8) + '.sock'),
          ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
      worker.child = child; children.add(worker);
      child.stdout.on('data', bytes => { worker.stdout += bytes.toString(); });
      child.stderr.on('data', bytes => { worker.stderr += bytes.toString(); });
      worker.closed = once(child, 'close');
      const deadline = Date.now() + 15000;
      while (!/Listening for role tenant-admin on 127\.0\.0\.1:(\d+)/.test(worker.stdout) && child.exitCode === null && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const match = worker.stdout.match(/Listening for role tenant-admin on 127\.0\.0\.1:(\d+)/);
      if (expectReady) { assert(match, 'owner preview did not bind; ' + worker.stderr); worker.port = Number(match[1]); }
      else { assert.equal(match, null, 'unsafe/missing schema must refuse before bind'); await worker.closed; assert.notEqual(child.exitCode, 0); }
      assert(!worker.stdout.includes(serving.NS_OWNER_WRITER_PG) && !worker.stderr.includes(serving.NS_OWNER_WRITER_PG), 'no database credentials in diagnostics');
      return worker;
    }
    async function stop (worker) {
      if (worker.child.exitCode === null) worker.child.kill('SIGTERM');
      await worker.closed; children.delete(worker);
    }
    async function http (worker, credential, body = { _id: TARGET, name: 'Updated', roles: ['reader'] }, host = 'one.example.test', method = 'PUT', resource = endpoint) {
      // Node22 global fetch replaces explicit Host with the loopback URL host.
      // Use the established replica fixture's node:http wire semantics; never
      // relax the product resolver or pretend an IP host selects a tenant.
      if (credential === undefined) credential = await token();
      const payload = ['GET', 'DELETE'].includes(method) ? undefined : JSON.stringify(body);
      return new Promise((resolve, reject) => {
        const request = httpRequest({ hostname: '127.0.0.1', port: worker.port, path: resource, method,
          headers: { Host: host, Authorization: 'Bearer ' + credential,
            ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
          signal: AbortSignal.timeout(5000), agent: false
        }, response => {
          let bytes = ''; response.setEncoding('utf8');
          response.on('data', chunk => { bytes += chunk; });
          response.on('end', () => {
            try { resolve({ status: response.statusCode, body: response.headers['content-type']?.includes('application/json') && bytes ? JSON.parse(bytes) : bytes }); }
            catch (error) { reject(error); }
          });
          response.on('error', reject);
        });
        request.on('error', reject); request.end(payload);
      });
    }
    async function snapshot () {
      const result = {};
      for (const table of [t('tenant_authorization_subjects'), t('tenant_authorization_subject_roles'), c, t('tenant_subject_admin_audit')]) {
        result[table] = (await admin.query('SELECT * FROM ' + table + ' ORDER BY tenant_id,' + (table.includes('audit') ? 'event_id' : 'subject_id') +
          (table.includes('subject_roles') ? ',role_name' : ''))).rows;
      }
      return result;
    }
    async function refused (worker, credential, status = 401, body, host) {
      const before = await snapshot(); const response = await http(worker, credential, body, host);
      assert.equal(response.status, status, JSON.stringify(response.body)); assert.deepEqual(await snapshot(), before);
    }
    before(async function () {
      await registryLab.setup(); admin = registryLab.admin;
      directory = registryLab.directory;
      const { urls, roles } = registryLab.platform;
      readerRole = roles.owner_reader;
      serving = registryLab.environment({ NS_OWNER_CATALOGUE: catalogue.join(','),
        NS_OWNER_WRITER_PG: urls.owner_writer, NS_OWNER_READER_PG: urls.owner_reader,
        NS_OWNER_CREDENTIALS_PG: urls.owner_credentials, NS_OWNER_SETTINGS_PG: urls.owner_settings,
        NS_LIFETIME_PG: urls.lifetime_tenant_admin, TENANT_ADMIN_HOSTNAME: '127.0.0.1', TENANT_ADMIN_PORT: '0' });
      for (const tenant of [A, B]) {
        for (const subject of [TARGET, MANAGER]) {
          await admin.query(`INSERT INTO ${t('tenant_authorization_subjects')}(tenant_id,subject_id,display_name) VALUES($1,$2,$2)`, [tenant, subject]);
          await admin.query(`INSERT INTO ${c}(tenant_id,subject_id,token_prefix) VALUES($1,$2,$2)`, [tenant, subject]);
        }
        for (const [name, grants] of [['reader', ['api:entries:read']], ['uploader', ['api:entries:create']]]) {
          await admin.query(`INSERT INTO ${t('tenant_authorization_roles')} VALUES($1,$2,$3,false)`, [tenant, name, grants]);
        }
        assert.equal((await admin.query(`UPDATE ${t('tenant_owner_policy')} SET catalogue_digest=$2,ceiling=$3 WHERE tenant_id=$1`, [tenant, catalogueDigest(catalogue), catalogue])).rowCount, 1);
        await admin.query(`INSERT INTO ${t('tenant_owner_actors')}(tenant_id,principal,consumer,active,can_update,delegable) VALUES($1,$2,$4,true,true,$3)`, [tenant, MANAGER, catalogue, consumer]);
        await admin.query(`INSERT INTO ${a('credentials')} VALUES($1,'management-credential',$2,1,true)`, [tenant, MANAGER]);
        await admin.query(`INSERT INTO ${a('sessions')} VALUES($1,'session',$2,'management-credential',1,$3,true,'management')`, [tenant, MANAGER, Math.floor(Date.now() / 1000) + 3600]);
      }
      workers.push(await start(), await start());
    });
    after(async function () {
      try { for (const worker of children) await stop(worker); }
      finally { await registryLab.cleanup(); }
    });
    it('commits an own-tenant update through the actual CLI listener and stable configured actor', async function () {
      const response = await http(workers[0]); assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal((await admin.query(`SELECT display_name FROM ${t('tenant_authorization_subjects')} WHERE tenant_id=$1 AND subject_id=$2`, [A, TARGET])).rows[0].display_name, 'Updated');
      const audit = (await admin.query(`SELECT principal,consumer FROM ${t('tenant_subject_admin_audit')}`)).rows;
      assert.deepEqual(audit, [{ principal: MANAGER, consumer }]);
    });
    it('PROVISIONING_PRIVATE: /v1/tenants (one, batch, read, description) on the tenant-admin listener answers exactly as an unknown route', async function () {
      // decision operator-rest-api: provisioning is reachable only on the admin listener.
      const unknownPost = await http(workers[0], await token(), { id: A, hosts: ['leak.example.test'] }, 'one.example.test', 'POST', '/v1/no-such-route');
      const unknownGet = await http(workers[0], await token(), undefined, 'one.example.test', 'GET', '/v1/no-such-route');
      for (const answer of [unknownGet, unknownPost]) assert.ok(answer.status >= 400 && answer.status < 500, 'unknown owner routes refuse');
      for (const [method, resource, body] of [['POST', '/v1/tenants', { id: A, hosts: ['leak.example.test'] }], ['POST', '/v1/tenants/batch', { tenants: [{ id: A, hosts: ['leak.example.test'] }] }],
        ['GET', '/v1/tenants/' + A, undefined], ['GET', '/v1/openapi.json', undefined]]) {
        const answer = await http(workers[0], await token(), body, 'one.example.test', method, resource);
        const expected = method === 'POST' ? unknownPost : unknownGet;
        assert.deepEqual([answer.status, answer.body], [expected.status, expected.body], method + ' ' + resource);
      }
    });
    it('refuses root/data/wrong-purpose/foreign/unknown-key credentials without persistent effects', async function () {
      for (const credential of ['synthetic-root', 'synthetic-legacy-subject', await token(A, { purpose: 'data' }), await token(B), await token(A, {}, { kid: 'unknown' })]) {
        await refused(workers[0], credential);
      }
    });
    it('observes current credential/session/key/tenant revocation on the next operation across two independent workers', async function () {
      const credential = await token();
      for (const [table, column, disabled, restored] of [['credentials', 'enabled', false, true], ['credentials', 'generation', 2, 1],
        ['sessions', 'active', false, true], ['sessions', 'generation', 2, 1], ['sessions', 'expires_at', 1, Math.floor(Date.now() / 1000) + 3600],
        ['keys', 'active', false, true], ['tenants', 'active', false, true]]) {
        const match = { credentials: " AND credential_id='management-credential'", sessions: " AND session_id='session'", keys: " AND kid='management1'", tenants: '' }[table];
        const change = value => admin.query(`UPDATE ${a(table)} SET "${column}"=$2 WHERE tenant_id=$1` + match, [A, value]);
        assert.equal((await change(disabled)).rowCount, 1);
        try { for (const worker of workers) await refused(worker, credential); }
        finally { await change(restored); }
      }
    });
    it('retains transactional operator ceiling and current actor delegation fences', async function () {
      await admin.query(`UPDATE ${t('tenant_owner_policy')} SET ceiling=ARRAY['api:entries:read'] WHERE tenant_id=$1`, [A]);
      try { await refused(workers[0], await token(), 403, { _id: TARGET, name: 'Refused', roles: ['uploader'] }); }
      finally { await admin.query(`UPDATE ${t('tenant_owner_policy')} SET ceiling=$2 WHERE tenant_id=$1`, [A, catalogue]); }
      await admin.query(`UPDATE ${t('tenant_owner_actors')} SET active=false WHERE tenant_id=$1`, [A]);
      try { await refused(workers[1], await token(), 403); }
      finally { await admin.query(`UPDATE ${t('tenant_owner_actors')} SET active=true WHERE tenant_id=$1`, [A]); }
    });
    it('refuses missing schema or unsafe reader privileges before binding the owner listener', async function () {
      await stop(await start({ NS_PG_PREFIX: 'missing' }, false));
      await stop(await start({ NS_OWNER_READER_PG: registryLab.adminConnectionString }, false));
    });
    it('keeps management routes off the actual data app and commits an owner revocation through the owner listener', async function () {
      const resolver = createResolver({ aliases: [{ host: 'one.example.test', tenant: A }] });
      const dataRouter = express.Router(); dataRouter.get('/entries', (req, res) => res.json([]));
      const app = createTenantApp({ resolver, dataRouter, verifyCredential: async () => null,
        authorizeRequest: async () => false, tenantSettings: { read () {}, replace () {}, rollback () {} },
        subjectPolicy: { read () {}, replace () {} }, dataAccess: async () => { throw new Error('management must not acquire data authority'); } });
      const before = await snapshot();
      const response = await request(app).put(endpoint).set('Host', 'one.example.test').set('Authorization', 'Bearer ' + await token()).send({ _id: TARGET, name: 'Refused' });
      assert([401, 403, 404, 405].includes(response.status), 'data app must not expose owner handler: ' + response.status); assert.deepEqual(await snapshot(), before);
      // The owner candidate (68f35cd0) fences creation, revocation and issuance in
      // the store transaction; DELETE is no longer refused. Revoke a dedicated
      // synthetic subject so TARGET stays available to later cases.
      const REVOKED = 'revoked';
      await admin.query(`INSERT INTO ${t('tenant_authorization_subjects')}(tenant_id,subject_id,display_name) VALUES($1,$2,$2)`, [A, REVOKED]);
      await admin.query(`INSERT INTO ${c}(tenant_id,subject_id,token_prefix) VALUES($1,$2,$2)`, [A, REVOKED]);
      const removed = await http(workers[0], await token(), undefined, 'one.example.test', 'DELETE', endpoint + '/' + REVOKED);
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      for (const table of [t('tenant_authorization_subjects'), c]) {
        assert.equal((await admin.query('SELECT 1 FROM ' + table + ' WHERE tenant_id=$1 AND subject_id=$2', [A, REVOKED])).rowCount, 0);
      }
      const after = await snapshot();
      for (const table of [t('tenant_authorization_subjects'), t('tenant_authorization_subject_roles'), c]) assert.deepEqual(after[table], before[table]);
      assert.equal(after[t('tenant_subject_admin_audit')].length, before[t('tenant_subject_admin_audit')].length + 1);
    });
    it('uses separate actual API and owner listeners in one CLI process with real PostgreSQL and Vault', async function () {
      const combined = registryLab.start(registryLab.configuration(), serving, { roles: 'tenant-admin,api' });
      let ownerPort;
      try {
        await registryLab.until(async () => {
          assert.equal(combined.exit, null, 'combined actual CLI must remain alive before both binds');
          const api = /Listening for role api on 127\.0\.0\.1:(\d+)/.exec(combined.stdout);
          if (api) combined.port = Number(api[1]);
          return api && /Listening for role tenant-admin on 127\.0\.0\.1:(\d+)/.test(combined.stdout);
        }, 'both actual CLI listeners');
        const match = /Listening for role tenant-admin on 127\.0\.0\.1:(\d+)/.exec(combined.stdout);
        assert.ok(match, 'the same actual CLI process must bind its owner listener');
        ownerPort = Number(match[1]);
        assert.notEqual(ownerPort, combined.port, 'data and management require separate actual sockets');
        const before = await snapshot();
        const response = await http({ port: combined.port }, await token(), { _id: TARGET, name: 'Wrong Plane', roles: ['reader'] });
        assert([401, 403, 404, 405].includes(response.status), 'data listener must not expose management route: ' + response.status);
        assert.deepEqual(await snapshot(), before, 'data listener refusal must not mutate owner rows or audit');
        const dataToken = await registryLab.localToken(A);
        const seed = await registryLab.http(combined, A, 'POST', '/api/v3/entries', dataToken,
          { identifier: 'owner-plane-data-canary', type: 'sgv', date: 1793664000000, utcOffset: 0,
            app: 'synthetic-owner-plane', sgv: 145 });
        assert.equal(seed.status, 201, 'DATA mutation: ' + JSON.stringify(seed.body));
        const beforeData = (await registryLab.admin.query('SELECT tenant_id,doc FROM preview_entries.entries ORDER BY tenant_id,doc::text')).rows;
        assert.equal(beforeData.length, 1); assert.equal(beforeData[0].doc.sgv, 145);
        const accepted = await http({ port: ownerPort }, await token(), { _id: TARGET, name: 'Owner Plane', roles: ['reader'] });
        assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
        const target = (await admin.query(`SELECT display_name FROM ${t('tenant_authorization_subjects')} WHERE tenant_id=$1 AND subject_id=$2`, [A, TARGET])).rows;
        assert.deepEqual(target, [{ display_name: 'Owner Plane' }]);
        assert.equal((await admin.query(`SELECT count(*)::int AS count FROM ${t('tenant_subject_admin_audit')}`)).rows[0].count,
          before[t('tenant_subject_admin_audit')].length + 1, 'owner plane must persist exactly one audit event');
        assert.deepEqual((await registryLab.admin.query('SELECT tenant_id,doc FROM preview_entries.entries ORDER BY tenant_id,doc::text')).rows, beforeData,
          'an owner update must leave DATA rows unchanged');
        console.log('OWNER_PREVIEW_COMBINED_LISTENERS ' + JSON.stringify({ sameProcess: true, distinctSockets: true,
          realProviders: ['PostgreSQL', 'Vault'], dataManagementStatus: response.status, ownerManagementStatus: accepted.status,
          independentOwnerAuditDelta: 1, independentDataUnchanged: true }));
        await registryLab.stop(combined);
        await assert.rejects(fetch('http://127.0.0.1:' + ownerPort + '/', { signal: AbortSignal.timeout(1000) }),
          'same process shutdown must also close the owner socket');
      } finally { if (registryLab.workers.has(combined)) await registryLab.stop(combined); }
    });
    it('sanitizes an exact-owned reader SQL refusal as 503 without mutation and recovers after restoration', async function () {
      const credential = await token();
      // Revoke only this fixture-owned reader's existing SELECT grant. This is
      // a real PostgreSQL permission refusal, not a callback/stub or a claim of
      // transport/network failure. No unknown backend or service is touched.
      await admin.query(`REVOKE SELECT ON ${a('credentials')} FROM "${readerRole}"`);
      try {
        assert.equal((await admin.query("SELECT has_table_privilege($1,$2,'SELECT') AS allowed",
          [readerRole, a('credentials')])).rows[0].allowed, false);
        for (const worker of workers) {
          const before = await snapshot();
          const response = await http(worker, credential);
          assert.equal(response.status, 503);
          assert.deepEqual(response.body, { error: 'AUTHORITY_UNAVAILABLE' }, 'private database details must be sanitized');
          assert.deepEqual(await snapshot(), before, 'authority refusal must precede every owner mutation');
        }
      } finally { await admin.query(`GRANT SELECT ON ${a('credentials')} TO "${readerRole}"`); }
      const before = await snapshot();
      const response = await http(workers[0], credential, { _id: TARGET, name: 'After Authority Restore', roles: ['reader'] });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal((await admin.query(`SELECT display_name FROM ${t('tenant_authorization_subjects')} WHERE tenant_id=$1 AND subject_id=$2`, [A, TARGET])).rows[0].display_name,
        'After Authority Restore');
      assert.equal((await admin.query(`SELECT count(*)::int AS count FROM ${t('tenant_subject_admin_audit')}`)).rows[0].count,
        before[t('tenant_subject_admin_audit')].length + 1);
      console.log('OWNER_PREVIEW_READER_SQL_REFUSAL ' + JSON.stringify({ scope: 'exact-owned reader SELECT privilege', workers: workers.length,
        refusedStatus: 503, sanitized: true, independentStateUnchangedDuringRefusal: true, restoredStatus: response.status, auditDeltaAfterRestore: 1 }));
    });
    it('reports datastore loss and serves authenticated tenant writes after replacing the PostgreSQL process', async function () {
      const socketPath = path.join(directory, 'owner-health.sock');
      const selected = await start({ NS_SERVE_INTERNAL_SOCKET: socketPath, NS_DATASTORE_PROBE_INTERVAL_MS: '250' });
      const ready = () => require('./fixtures/role-readiness-probe')({ socketPath, timeoutMs: 1500 });
      const birth = async () => (await admin.query('SELECT pg_postmaster_start_time()::text AS birth')).rows[0].birth;
      try {
        const credential = await token(), before = await birth();
        assert.equal((await http(selected, credential)).status, 200);
        assert.equal(await ready(), true);
        await registryLab.restartDatabase(async () => {
          await registryLab.until(async () => !(await ready()), 'private role health turns unavailable');
          assert.equal((await http(selected, credential)).status, 503);
        });
        admin = registryLab.admin;
        assert.notEqual(await birth(), before);
        await registryLab.until(ready, 'private role health recovers');
        assert.equal((await http(selected, credential, { _id: TARGET, name: 'After PostgreSQL restart', roles: ['reader'] })).status, 200);
        const row = await admin.query('SELECT display_name FROM ' + t('tenant_authorization_subjects') + ' WHERE tenant_id=$1 AND subject_id=$2', [A, TARGET]);
        assert.deepEqual(row.rows, [{ display_name: 'After PostgreSQL restart' }]);
      } finally { admin = registryLab.admin; await stop(selected); }
    });
    it('closes actual CLI listeners and storage cleanly on SIGTERM', async function () {
      const worker = await start(); await stop(worker); assert.equal(worker.child.exitCode, 0);
    });
  });
