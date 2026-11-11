'use strict';
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const request = require('supertest');
const { run } = require('../../lib/migrations/postgres');
const scope = require('../../lib/storage/tenant-scope');
const createStore = require('../../lib/subject-admin/postgres');
const { createSubjectAdmin } = require('../../lib/subject-admin/component');
const { createSubjectManagementApp } = require('../../lib/server/subject-management-app');
const createResolver = require('../../lib/tenant-resolution');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const TARGET = '000000000000000000000001', NS = 'owner_policy_test', CREDENTIAL_NS = 'owner_identity_test';
const tables = Object.freeze({ subjects: NS + '.tenant_authorization_subjects', roles: NS + '.tenant_authorization_roles',
  links: NS + '.tenant_authorization_subject_roles', config: NS + '.tenant_authorization_config',
  audit: NS + '.tenant_subject_admin_audit', credentials: CREDENTIAL_NS + '.legacy_credential_subjects',
  policy: NS + '.tenant_owner_policy', actors: NS + '.tenant_owner_actors' });
const CATALOGUE = Object.freeze(['api:entries:read', 'api:entries:create']);
const digest = catalogue => crypto.createHash('sha256').update(JSON.stringify(catalogue.slice().sort())).digest('hex');
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const actor = Object.freeze({ tenant: A, principal: 'manager', consumer: 'admin' });
function rootWriterGrants (role) {
  return [`GRANT SELECT,INSERT,UPDATE,DELETE ON ${tables.subjects},${tables.credentials} TO ${role}`,
    // Root alone edits role permissions and deletes unheld roles (decision root-role-edit-delete).
    `GRANT SELECT,INSERT,DELETE,UPDATE(permissions,owner_fence) ON ${tables.roles} TO ${role}`,
    `GRANT SELECT,INSERT,DELETE ON ${tables.links} TO ${role}`,
    `GRANT INSERT ON ${tables.audit} TO ${role}`,
    `GRANT SELECT,UPDATE(owner_fence) ON ${tables.config},${tables.policy} TO ${role}`,
    `GRANT SELECT ON ${tables.actors} TO ${role}`];
}
async function createFixture () {
  const suffix = crypto.randomBytes(8).toString('hex'), name = 'ns-owner-policy-test-' + suffix, database = 'owner_policy_test_' + suffix;
  const previousMode = scope.getTenancyMode(), stores = [], clients = [], state = {};
  let owned = false, admin;
  const f = { A, B, TARGET, NS, CREDENTIAL_NS, tables, actor, catalogue: CATALOGUE, digest, state };
  async function cleanup () {
    let firstError;
    for (const store of stores) { try { await store.close(); } catch (error) { if (!firstError) firstError = error; } }
    for (const client of clients) { try { await client.end(); } catch (error) { if (!firstError) firstError = error; } }
    if (admin) { try { await admin.end(); } catch (error) { if (!firstError) firstError = error; } admin = null; }
    scope.setTenancyMode(previousMode);
    if (owned) {
      docker(['rm', '-f', '-v', name]); owned = false;
      for (const volume of f.ownedVolumes || []) {
        let exists = true;
        try { docker(['volume', 'inspect', volume]); } catch (error) {
          const message = String(error.stderr || '').trim();
          if (error.status !== 1 || ![
            'Error response from daemon: get ' + volume + ': no such volume',
            'Error: No such volume: ' + volume
          ].includes(message)) throw error;
          exists = false;
        }
        if (exists) throw new Error('Owned PostgreSQL volume survived explicit owned-container cleanup');
      }
    }
    if (firstError) throw firstError;
  }

  try {
    scope.setTenancyMode('multi');
    const password = crypto.randomBytes(24).toString('hex');
    const createdContainer = execFileSync('docker', ['create', '--name', name, '-p', '127.0.0.1::5432', '-e', 'POSTGRES_USER=operator',
      '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=' + database, 'postgres:16'],
    { encoding: 'utf8', env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    owned = true;
    f.ownedContainer = docker(['inspect', '--format', '{{.Id}}', name]);
    if (createdContainer.trim() !== f.ownedContainer) throw new Error('Owned PostgreSQL container identity mismatch');
    f.ownedVolumes = docker(['inspect', '--format', '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}', name]).split(' ').filter(Boolean);
    docker(['start', name]);
    const port = docker(['port', name, '5432/tcp']).split(':').pop();
    const adminURI = 'postgres://operator:' + password + '@127.0.0.1:' + port + '/' + database;
    const deadline = Date.now() + 20000;
    for (;;) {
      const probe = new Client({ connectionString: adminURI, connectionTimeoutMillis: 1000 });
      try { await probe.connect(); await probe.query('SELECT 1'); admin = probe; break; }
      catch (error) { await probe.end().catch(() => {}); if (Date.now() > deadline) throw error; await sleep(100); }
    }
    f.admin = admin;
    f.versions = { postgres: (await admin.query('SHOW server_version')).rows[0].server_version, node: process.version };
    console.log('Owner policy fixture evidence ' + JSON.stringify({ ...f.versions, ownershipVerified: true, ownedVolumeCount: f.ownedVolumes.length }));
    await run('up', { direct: true, connectionString: adminURI, namespace: NS, catalogue: require('../../lib/tenant-authorization/postgres-candidate.json') });
    await run('check', { direct: true, connectionString: adminURI, namespace: NS, catalogue: require('../../lib/tenant-authorization/postgres-candidate.json') });
    await run('up', { direct: true, connectionString: adminURI, namespace: CREDENTIAL_NS, catalogue: require('../../lib/secrets/legacy-credentials-candidate.json') });
    const uris = {};
    for (const role of ['owner_writer', 'legacy_writer', 'owner_reader', 'root_writer']) {
      const pw = crypto.randomBytes(24).toString('hex');
      await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${pw}'`);
      await admin.query(`GRANT USAGE ON SCHEMA ${NS},${CREDENTIAL_NS} TO ${role}`);
      const url = new URL(adminURI); url.username = role; url.password = pw; uris[role] = url.toString();
    }
    for (const role of ['owner_writer', 'legacy_writer']) {
      await admin.query(`GRANT SELECT,UPDATE,DELETE ON ${tables.subjects},${tables.credentials} TO ${role}`);
      await admin.query(`GRANT SELECT ON ${tables.roles} TO ${role}`);
      await admin.query(`GRANT SELECT,INSERT,DELETE ON ${tables.links} TO ${role}`);
      await admin.query(`GRANT INSERT ON ${tables.audit} TO ${role}`);
    }
    // Adopted owner create/role capability extends the writer's insert shape.
    await admin.query(`GRANT INSERT ON ${tables.subjects},${tables.credentials},${tables.roles} TO owner_writer`);
    for (const table of [tables.config, tables.roles, tables.policy, tables.actors]) await admin.query(`GRANT SELECT,UPDATE(owner_fence) ON ${table} TO owner_writer`);
    await admin.query(`GRANT SELECT ON ${tables.subjects},${tables.roles},${tables.links},${tables.config},${tables.credentials} TO owner_reader`);
    // Root plane (tenant API_SECRET): the owner writer's shape, except that it
    // only reads owner actor rows (last-owner guard) and never locks them.
    for (const statement of rootWriterGrants('root_writer')) await admin.query(statement);
    f.writerURI = uris.owner_writer; f.legacyURI = uris.legacy_writer; f.readerURI = uris.owner_reader; f.rootURI = uris.root_writer;
    f.newStore = async (options = {}) => {
      const store = await createStore({ connectionString: uris.owner_writer, namespace: NS, credentialNamespace: CREDENTIAL_NS,
        ownerPolicy: { catalogue: CATALOGUE.slice() }, ...options });
      stores.push(store); return store;
    };
    f.ownerStore = await f.newStore();
    f.rootStore = await f.newStore({ connectionString: uris.root_writer, plane: 'root' });
    const coarse = async current => { if (state.authorityError) throw new Error('synthetic authority unavailable'); return current.principal === 'manager'; };
    f.service = createSubjectAdmin({ store: f.ownerStore, authorizeManagement: coarse });
    const resolver = createResolver({ aliases: [{ host: 'one.example.test', tenant: A }, { host: 'two.example.test', tenant: B }] });
    const authenticateManagement = async ({ tenant, credential }) => {
      if (state.authError) throw new Error('synthetic identity unavailable');
      if (credential === 'synthetic-cross-tenant') return { ...actor, tenant: B };
      if (credential === 'synthetic-wrong-consumer') return { tenant, principal: 'manager', consumer: 'data' };
      return credential === 'synthetic-management-' + tenant ? { tenant, principal: 'manager', consumer: 'admin' } : null;
    };
    f.app = createSubjectManagementApp({ resolver, authenticateManagement, subjectAdmin: f.service });
    f.resolver = resolver;
    f.http = async (body, options = {}) => {
      const method = options.method || 'put', target = '/api/v2/authorization/subjects' + (method === 'delete' ? '/' + TARGET : '');
      let pending = request(options.app || f.app)[method](target).set('Host', options.host || 'one.example.test').timeout({ response: 20000 });
      const credential = options.credential === undefined ? 'synthetic-management-' + A : options.credential;
      if (credential !== null) pending = pending.set('Authorization', 'Bearer ' + credential);
      return body === undefined ? pending : pending.send(body);
    };
    f.proposal = (roles = ['reader']) => ({ _id: TARGET, name: 'Allowed Owner', roles });
    f.snapshot = async tenant => {
      const result = {};
      for (const table of [tables.subjects, tables.links, tables.credentials, tables.audit]) {
        result[table] = (await admin.query('SELECT * FROM ' + table + (tenant ? ' WHERE tenant_id=$1' : '') +
          ' ORDER BY tenant_id,' + (table === tables.audit ? 'event_id' : 'subject_id') + (table === tables.links ? ',role_name' : ''), tenant ? [tenant] : [])).rows;
      }
      return result;
    };
    f.reset = async () => {
      Object.assign(state, { authorityError: false, authError: false });
      for (const table of [tables.links, tables.credentials, tables.subjects, tables.audit, tables.actors, tables.policy, tables.roles, tables.config]) await admin.query('DELETE FROM ' + table);
      await admin.query(`INSERT INTO ${CREDENTIAL_NS}.legacy_credential_config (tenant_id,root_reference_id)
        VALUES ($1,'synthetic-root-a'),($2,'synthetic-root-b') ON CONFLICT DO NOTHING`, [A, B]);
      for (const [tenant, title] of [[A, 'Original'], [B, 'Foreign']]) {
        await admin.query(`INSERT INTO ${tables.config} (tenant_id,anonymous_roles) VALUES ($1,ARRAY['denied'])`, [tenant]);
        await admin.query(`INSERT INTO ${tables.subjects} (tenant_id,subject_id,display_name,notes,created_at) VALUES ($1,$2,$3,'preserved','2026-01-01T00:00:00.000Z')`, [tenant, TARGET, title]);
        await admin.query(`INSERT INTO ${tables.credentials} (tenant_id,subject_id,token_prefix) VALUES ($1,$2,$3)`, [tenant, TARGET, title.toLowerCase()]);
        for (const [role, permissions] of [['reader', ['api:entries:read']], ['uploader', ['api:entries:create']], ['outside', ['api:settings:admin']], ['wildcard', ['*']]]) {
          await admin.query(`INSERT INTO ${tables.roles} (tenant_id,name,permissions) VALUES ($1,$2,$3)`, [tenant, role, permissions]);
        }
        if (tenant === B) await admin.query(`INSERT INTO ${tables.roles} (tenant_id,name,permissions) VALUES ($1,'foreign-only',ARRAY['api:entries:read'])`, [B]);
        await admin.query(`INSERT INTO ${tables.links} (tenant_id,subject_id,role_name) VALUES ($1,$2,'reader')`, [tenant, TARGET]);
        await admin.query(`INSERT INTO ${tables.policy} (tenant_id,catalogue_digest,ceiling) VALUES ($1,$2,$3)`, [tenant, digest(CATALOGUE), CATALOGUE]);
        await admin.query(`INSERT INTO ${tables.actors} (tenant_id,principal,consumer,active,can_update,delegable) VALUES ($1,'manager','admin',true,true,$2)`, [tenant, CATALOGUE]);
      }
    };
    f.open = async (role = 'operator') => {
      const client = new Client({ connectionString: role === 'operator' ? adminURI : uris[role], application_name: 'owner-policy-independent-' + role });
      await client.connect(); clients.push(client); return client;
    };
    f.bound = async (client, tenant, fn) => {
      await client.query('BEGIN');
      try { await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]); const result = await fn(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
    };
    f.blockedBy = async pid => {
      const limit = Date.now() + 15000;
      for (;;) {
        const result = await admin.query('SELECT pid,query FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND pid<>pg_backend_pid()', [pid]);
        if (result.rows.length) return result.rows;
        if (Date.now() > limit) throw new Error('Expected real PostgreSQL lock waiter was not observed');
        await sleep(20);
      }
    };
    f.pause = () => docker(['pause', name]); f.unpause = () => docker(['unpause', name]); f.close = cleanup;
    await f.reset(); return f;
  } catch (error) { await cleanup(); throw error; }
}
module.exports = { createFixture, A, B, TARGET, CATALOGUE };
