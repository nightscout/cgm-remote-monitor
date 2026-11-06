'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Client } = require('pg');
const express = require('express');
const request = require('supertest');
const { run } = require('../lib/migrations/postgres');
const { catalogueDigest } = require('../lib/subject-admin/owner-policy');
const { createTenantApp } = require('../lib/server/tenant-app');
const createResolver = require('../lib/tenant-resolution');
const { optInSuite } = require('./support/opt-in');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const TARGET = 'target', MANAGER = 'manager';
const endpoint = '/api/v2/authorization/subjects';
const catalogue = ['api:entries:read', 'api:entries:create'];

// Prepared real CLI/HTTP laboratory. Operator provisioning and Ed25519 signing
// happen here only; the product has neither an issuer nor a refresh endpoint.
optInSuite(process.env.NS_OWNER_PREVIEW_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_OWNER_PREVIEW_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')('explicit headless owner executable composition', function () {
    this.timeout(60000);
    const suffix = crypto.randomBytes(8).toString('hex');
    const namespaces = { authorization: 'owner_auth_' + suffix, credentials: 'owner_creds_' + suffix, access: 'owner_access_' + suffix };
    const writerRole = 'owner_writer_' + suffix, readerRole = 'owner_reader_' + suffix;
    const keys = [A, B].map(tenant => ({ tenant, ...crypto.generateKeyPairSync('ed25519') }));
    const children = new Set(), workers = [];
    let admin, directory, writerURI, readerURI, file;
    const t = table => '"' + namespaces.authorization + '".' + table;
    const a = table => '"' + namespaces.access + '".access_' + table;
    const c = '"' + namespaces.credentials + '".legacy_credential_subjects';
    const config = () => ({ version: 1, postgres: { writerConnectionEnv: 'OWNER_WRITER', accessConnectionEnv: 'OWNER_READER', namespaces },
      resolution: { mode: 'direct-alias' }, tenants: [{ id: A, aliases: ['one.example.test'] }, { id: B, aliases: ['two.example.test'] }],
      ownerPolicy: { catalogue }, management: { issuer: 'synthetic-private-operator', audience: 'synthetic-owner', purpose: 'management', consumer: 'owner-preview',
        keys: keys.map(key => ({ tenant: key.tenant, kid: 'management-key', publicKey: Buffer.from(key.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64') })) } });
    function token (tenant = A, override = {}, header = {}) {
      const now = Math.floor(Date.now() / 1000), key = keys.find(key => key.tenant === tenant);
      const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const input = encode({ alg: 'EdDSA', typ: 'ns-access+jwt', kid: 'management-key', ...header }) + '.' +
        encode({ iss: 'synthetic-private-operator', aud: 'synthetic-owner', tid: tenant, purpose: 'management', sub: MANAGER, sid: 'session', cv: 1,
          iat: now, nbf: now, exp: now + 600, ...override });
      return input + '.' + crypto.sign(null, Buffer.from(input), key.privateKey).toString('base64url');
    }
    async function start (configuration = config(), overrides = {}, expectReady = true) {
      const filename = path.join(directory, 'config-' + crypto.randomBytes(6).toString('hex') + '.json');
      fs.writeFileSync(filename, JSON.stringify(configuration), { mode: 0o600 });
      const worker = { stdout: '', stderr: '' };
      const child = spawn(process.execPath, [path.resolve(__dirname, '../bin/nightscout.js'), 'multitenant', 'tenant-admin'],
        { cwd: path.dirname(filename), env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', TZ: 'UTC',
          MULTITENANT_OWNER_PREVIEW_CONFIG: filename, OWNER_WRITER: writerURI, OWNER_READER: readerURI,
          TENANT_ADMIN_HOSTNAME: '127.0.0.1', TENANT_ADMIN_PORT: '0', ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
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
      assert(!worker.stdout.includes(writerURI) && !worker.stderr.includes(writerURI), 'no database credentials in diagnostics');
      return worker;
    }
    async function stop (worker) {
      if (worker.child.exitCode === null) worker.child.kill('SIGTERM');
      await worker.closed; children.delete(worker);
    }
    async function http (worker, credential = token(), body = { _id: TARGET, name: 'Updated', roles: ['reader'] }, host = 'one.example.test', method = 'PUT') {
      const response = await fetch('http://127.0.0.1:' + worker.port + endpoint, { method,
        headers: { Host: host, Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      return { status: response.status, body: await response.json() };
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
      assert.match(new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI).pathname, /test/i);
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-headless-owner-')); file = path.join(directory, 'owner.json');
      admin = new Client({ connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI }); await admin.connect();
      for (const [name, candidate] of [['authorization', require('../lib/tenant-authorization/postgres-candidate.json')],
        ['credentials', require('../lib/secrets/legacy-credentials-candidate.json')], ['access', require('../lib/tenant-authorization/access-candidate.json')]]) {
        await run('up', { direct: true, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI, namespace: namespaces[name], catalogue: candidate });
      }
      for (const role of [writerRole, readerRole]) {
        const password = crypto.randomBytes(24).toString('hex');
        await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
        await admin.query(`GRANT USAGE ON SCHEMA "${namespaces.authorization}","${namespaces.credentials}","${namespaces.access}" TO "${role}"`);
        const uri = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI); uri.username = role; uri.password = password;
        if (role === writerRole) writerURI = uri.toString(); else readerURI = uri.toString();
      }
      await admin.query(`GRANT SELECT,UPDATE,DELETE ON ${t('tenant_authorization_subjects')},${c} TO "${writerRole}"`);
      await admin.query(`GRANT SELECT ON ${t('tenant_authorization_roles')} TO "${writerRole}"`);
      await admin.query(`GRANT SELECT,INSERT,DELETE ON ${t('tenant_authorization_subject_roles')} TO "${writerRole}"`);
      await admin.query(`GRANT INSERT ON ${t('tenant_subject_admin_audit')} TO "${writerRole}"`);
      for (const table of ['tenant_authorization_config', 'tenant_authorization_roles', 'tenant_owner_policy', 'tenant_owner_actors']) {
        await admin.query(`GRANT SELECT,UPDATE(owner_fence) ON ${t(table)} TO "${writerRole}"`);
      }
      for (const namespace of Object.values(namespaces)) await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${namespace}" TO "${readerRole}"`);
      for (const tenant of [A, B]) {
        await admin.query(`INSERT INTO ${t('tenant_authorization_config')} (tenant_id,anonymous_roles) VALUES($1,ARRAY['denied'])`, [tenant]);
        await admin.query(`INSERT INTO "${namespaces.credentials}".legacy_credential_config VALUES($1,'synthetic-root-reference')`, [tenant]);
        for (const subject of [TARGET, MANAGER]) {
          await admin.query(`INSERT INTO ${t('tenant_authorization_subjects')}(tenant_id,subject_id,display_name) VALUES($1,$2,$2)`, [tenant, subject]);
          await admin.query(`INSERT INTO ${c}(tenant_id,subject_id,token_prefix) VALUES($1,$2,$2)`, [tenant, subject]);
        }
        for (const [name, grants] of [['reader', ['api:entries:read']], ['uploader', ['api:entries:create']]]) {
          await admin.query(`INSERT INTO ${t('tenant_authorization_roles')} VALUES($1,$2,$3,false)`, [tenant, name, grants]);
        }
        await admin.query(`INSERT INTO ${t('tenant_owner_policy')}(tenant_id,catalogue_digest,ceiling) VALUES($1,$2,$3)`, [tenant, catalogueDigest(catalogue), catalogue]);
        await admin.query(`INSERT INTO ${t('tenant_owner_actors')}(tenant_id,principal,consumer,active,can_update,delegable) VALUES($1,$2,'owner-preview',true,true,$3)`, [tenant, MANAGER, catalogue]);
        await admin.query(`INSERT INTO ${a('tenants')} VALUES($1,true)`, [tenant]);
        await admin.query(`INSERT INTO ${a('credentials')} VALUES($1,'management-credential',$2,1,true)`, [tenant, MANAGER]);
        await admin.query(`INSERT INTO ${a('sessions')} VALUES($1,'session',$2,'management-credential',1,$3,true,'management')`, [tenant, MANAGER, Math.floor(Date.now() / 1000) + 3600]);
        await admin.query(`INSERT INTO ${a('keys')} VALUES($1,'management-key','management',true)`, [tenant]);
      }
      fs.writeFileSync(file, JSON.stringify(config()), { mode: 0o600 });
      workers.push(await start(), await start());
    });
    after(async function () {
      try { for (const worker of children) await stop(worker);
        if (admin) {
          for (const namespace of Object.values(namespaces)) await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
          for (const role of [writerRole, readerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
          assert.equal((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=ANY($1::text[])', [Object.values(namespaces)])).rowCount, 0);
        }
      } finally { if (admin) await admin.end(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); }
    });
    it('commits an own-tenant update through the actual CLI listener and stable configured actor', async function () {
      const response = await http(workers[0]); assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal((await admin.query(`SELECT display_name FROM ${t('tenant_authorization_subjects')} WHERE tenant_id=$1 AND subject_id=$2`, [A, TARGET])).rows[0].display_name, 'Updated');
      const audit = (await admin.query(`SELECT principal,consumer FROM ${t('tenant_subject_admin_audit')}`)).rows;
      assert.deepEqual(audit, [{ principal: MANAGER, consumer: 'owner-preview' }]);
    });
    it('refuses root/data/wrong-purpose/foreign/unknown-key credentials without persistent effects', async function () {
      for (const credential of ['synthetic-root', 'synthetic-legacy-subject', token(A, { purpose: 'data' }), token(B), token(A, {}, { kid: 'unknown' })]) {
        await refused(workers[0], credential);
      }
    });
    it('observes current credential/session/key/tenant revocation on the next operation across two independent workers', async function () {
      const credential = token();
      for (const [table, column, disabled, restored] of [['credentials', 'enabled', false, true], ['credentials', 'generation', 2, 1],
        ['sessions', 'active', false, true], ['sessions', 'generation', 2, 1], ['sessions', 'expires_at', 1, Math.floor(Date.now() / 1000) + 3600],
        ['keys', 'active', false, true], ['tenants', 'active', false, true]]) {
        await admin.query(`UPDATE ${a(table)} SET "${column}"=$2 WHERE tenant_id=$1`, [A, disabled]);
        try { for (const worker of workers) await refused(worker, credential); }
        finally { await admin.query(`UPDATE ${a(table)} SET "${column}"=$2 WHERE tenant_id=$1`, [A, restored]); }
      }
    });
    it('retains transactional operator ceiling and current actor delegation fences', async function () {
      await admin.query(`UPDATE ${t('tenant_owner_policy')} SET ceiling=ARRAY['api:entries:read'] WHERE tenant_id=$1`, [A]);
      try { await refused(workers[0], token(), 403, { _id: TARGET, name: 'Refused', roles: ['uploader'] }); }
      finally { await admin.query(`UPDATE ${t('tenant_owner_policy')} SET ceiling=$2 WHERE tenant_id=$1`, [A, catalogue]); }
      await admin.query(`UPDATE ${t('tenant_owner_actors')} SET active=false WHERE tenant_id=$1`, [A]);
      try { await refused(workers[1], token(), 403); }
      finally { await admin.query(`UPDATE ${t('tenant_owner_actors')} SET active=true WHERE tenant_id=$1`, [A]); }
    });
    it('refuses missing schema or unsafe reader privileges before binding the owner listener', async function () {
      const missing = config(); missing.postgres.namespaces = { ...namespaces, access: 'missing_' + suffix };
      await stop(await start(missing, {}, false));
      await stop(await start(config(), { OWNER_READER: process.env.NS_TEST_POSTGRES_ADMIN_URI }, false));
    });
    it('keeps management routes off the actual data app and refuses DELETE under selected policy', async function () {
      const resolver = createResolver({ aliases: [{ host: 'one.example.test', tenant: A }] });
      const dataRouter = express.Router(); dataRouter.get('/entries', (req, res) => res.json([]));
      const app = createTenantApp({ resolver, dataRouter, verifyCredential: async () => null,
        authorizeRequest: async () => false, tenantSettings: { read () {}, replace () {}, rollback () {} },
        subjectPolicy: { read () {}, replace () {} }, dataAccess: async () => { throw new Error('management must not acquire data authority'); } });
      const before = await snapshot();
      const response = await request(app).put(endpoint).set('Host', 'one.example.test').set('Authorization', 'Bearer ' + token()).send({ _id: TARGET, name: 'Refused' });
      assert([401, 403, 404, 405].includes(response.status), 'data app must not expose owner handler: ' + response.status); assert.deepEqual(await snapshot(), before);
      const removed = await fetch('http://127.0.0.1:' + workers[0].port + endpoint + '/' + TARGET,
        { method: 'DELETE', headers: { Host: 'one.example.test', Authorization: 'Bearer ' + token() } });
      assert.equal(removed.status, 403); assert.deepEqual(await snapshot(), before);
    });
    it('uses separate actual API and owner listeners in one CLI process with real PostgreSQL and Vault', async function () {
      // Reuse the real data-preview provider fixture, including its private
      // restricted connections, Vault transit and persisted data-token state.
      // The owner writer/reader remain the distinct operator-provisioned roles
      // above. No fake boot, app injection or credential translation is used.
      const data = require('./fixtures/multitenant-preview-replicas')();
      let combined, ownerPort;
      try {
        await data.setup();
        const ownerFile = path.join(directory, 'combined-owner.json');
        fs.writeFileSync(ownerFile, JSON.stringify(config()), { mode: 0o600 });
        combined = data.start(data.configuration(), {
          MULTITENANT_OWNER_PREVIEW_CONFIG: ownerFile, OWNER_WRITER: writerURI, OWNER_READER: readerURI,
          TENANT_ADMIN_HOSTNAME: '127.0.0.1', TENANT_ADMIN_PORT: '0'
        }, { roles: 'tenant-admin,api' });
        await data.until(async () => {
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
        const response = await http({ port: combined.port }, token(), { _id: TARGET, name: 'Wrong Plane', roles: ['reader'] });
        assert([401, 403, 404, 405].includes(response.status), 'data listener must not expose management route: ' + response.status);
        assert.deepEqual(await snapshot(), before, 'data listener refusal must not mutate owner rows or audit');
        const dataToken = await data.localToken(A);
        const seed = await data.http(combined, A, 'POST', '/api/v3/entries', dataToken,
          { identifier: 'owner-plane-data-canary', type: 'sgv', date: 1793664000000, utcOffset: 0,
            app: 'synthetic-owner-plane', sgv: 145 });
        assert.equal(seed.status, 201, 'real data provider must independently persist a canary');
        const beforeData = (await data.admin.query('SELECT tenant_id,doc FROM preview_data.entries ORDER BY tenant_id,doc::text')).rows;
        assert.equal(beforeData.length, 1); assert.equal(beforeData[0].doc.sgv, 145);
        const accepted = await http({ port: ownerPort }, token(), { _id: TARGET, name: 'Owner Plane', roles: ['reader'] });
        assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
        const target = (await admin.query(`SELECT display_name FROM ${t('tenant_authorization_subjects')} WHERE tenant_id=$1 AND subject_id=$2`, [A, TARGET])).rows;
        assert.deepEqual(target, [{ display_name: 'Owner Plane' }]);
        assert.equal((await admin.query(`SELECT count(*)::int AS count FROM ${t('tenant_subject_admin_audit')}`)).rows[0].count,
          before[t('tenant_subject_admin_audit')].length + 1, 'owner plane must persist exactly one audit event');
        assert.deepEqual((await data.admin.query('SELECT tenant_id,doc FROM preview_data.entries ORDER BY tenant_id,doc::text')).rows, beforeData,
          'management update must not mutate the independently provisioned data plane');
        console.log('OWNER_PREVIEW_COMBINED_LISTENERS ' + JSON.stringify({ sameProcess: true, distinctSockets: true,
          realProviders: ['PostgreSQL', 'Vault'], dataManagementStatus: response.status, ownerManagementStatus: accepted.status,
          independentOwnerAuditDelta: 1, independentDataUnchanged: true }));
        await data.stop(combined);
        await assert.rejects(fetch('http://127.0.0.1:' + ownerPort + '/', { signal: AbortSignal.timeout(1000) }),
          'same process shutdown must also close the owner socket');
      } finally { await data.cleanup(); }
    });
    it('sanitizes an exact-owned reader SQL refusal as 503 without mutation and recovers after restoration', async function () {
      const credential = token();
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
    it('closes actual CLI listeners and storage cleanly on SIGTERM', async function () {
      const worker = await start(); await stop(worker); assert.equal(worker.child.exitCode, 0);
    });
  });
