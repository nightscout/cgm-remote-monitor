'use strict';

// covers: lib/server/serve/admin-preview.js, lib/server/serve/admin-config.js, lib/server/serve/index.js, lib/cli/commands/multitenant.js, lib/tenant-ownership/postgres.js, lib/tenant-ownership/service.js, deploy/multitenant/config.js

// Ownership operations through the composed multitenant `admin` role: a real
// `nightscout multitenant admin` process on disposable PostgreSQL, reached only
// on its ADMIN listener with the named ownership-operations client. The
// database identity and its grants are the deployment plan's own
// (deploy/multitenant/config.js `ownership_operator`). Synthetic tenants and
// identifiers only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { run } = require('../lib/migrations/postgres');
const catalogue = require('../lib/tenant-authorization/postgres-candidate.json');
const clients = require('../lib/server/internal-api/clients');
const { catalogueDigest } = require('../lib/subject-admin/owner-policy');
const plan = require('../deploy/multitenant/config');
const { optInSuite } = require('./support/opt-in');

// postgres:16, pinned by digest. Override only with another digest.
const IMAGE = process.env.NS_ADMIN_ROLE_PG_IMAGE || 'postgres@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const CONSUMER = 'tenant-admin';
const OPERATOR = { principal: 'synthetic_operator', consumer: 'operator_plane' };
const CEILING = ['api:*:read', 'api:entries:create'];
const ROOT = path.join(__dirname, '..');
const ref = principal => ({ principal, consumer: CONSUMER });
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// The plane rule keeps the admin listener off the consumer listener's address
// (HOSTNAME falls back to 127.0.0.1), so the role binds another loopback address.
const ADMIN_HOST = '127.0.0.2';
const freePort = () => new Promise(resolve => { const probe = net.createServer().listen(0, ADMIN_HOST, () => { const p = probe.address().port; probe.close(() => resolve(p)); }); });

optInSuite(process.env.NS_ADMIN_ROLE_DOCKER_TEST === '1',
  'NS_ADMIN_ROLE_DOCKER_TEST=1')('admin role: ownership operations through `nightscout multitenant admin` (disposable PostgreSQL)', function () {
  this.timeout(90000);
  const container = 'ns-adm-' + crypto.randomBytes(6).toString('hex');
  const layout = plan.layout('nsadm');
  const NS = layout.namespaces.authorization, IDENTITY = layout.roles.ownership_operator;
  const t = name => '"' + NS + '".' + name;
  let owned = false, admin, adminURI, identityURI, configDir, reaper, role;

  async function startRole ({ tenants = [A] } = {}) {
    const port = await freePort();
    const file = path.join(configDir, crypto.randomBytes(4).toString('hex') + '.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, maxBytes: 65536, timeoutMs: 10000,
      ownership: { connectionEnv: 'NS_OWNERSHIP_PG', namespace: NS, operator: OPERATOR, tenants } }), { mode: 0o600 });
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/nightscout.js'), 'multitenant', 'admin'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, ADMIN_HOSTNAME: ADMIN_HOST, ADMIN_PORT: String(port),
        MULTITENANT_ADMIN_CONFIG: file, NS_OWNERSHIP_PG: identityURI }
    });
    const out = { stdout: '', stderr: '' };
    child.stdout.on('data', chunk => { out.stdout += chunk; });
    child.stderr.on('data', chunk => { out.stderr += chunk; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    const outcome = await Promise.race([
      exited.then(status => ({ status })),
      (async () => { while (!/Listening for role admin on 127\.0\.0\.2:/.test(out.stdout)) await sleep(50); return { listening: true }; })(),
      sleep(30000).then(() => ({ timeout: true }))
    ]);
    const endpoint = { url: 'http://' + ADMIN_HOST + ':' + port + '/', trust: 'network', maxBytes: 65536, timeoutMs: 10000 };
    const started = { child, port, out, exited, endpoint, client: clients.ownershipOperations(endpoint), outcome,
      async stop () {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        return exited;
      } };
    return started;
  }
  async function rows (tenant) {
    const actors = (await admin.query(`SELECT principal,consumer,active,can_update,delegable FROM ${t('tenant_owner_actors')}
      WHERE tenant_id=$1 ORDER BY principal,consumer`, [tenant])).rows;
    const audit = (await admin.query(`SELECT principal,consumer,subject_id,operation,outcome,detail FROM ${t('tenant_subject_admin_audit')}
      WHERE tenant_id=$1 ORDER BY event_time,event_id`, [tenant])).rows;
    return { actors, audit };
  }
  async function owners (tenant) {
    return (await rows(tenant)).actors.filter(row => row.active && row.can_update).map(row => row.principal).sort();
  }
  function raw (port, { path: route = '/ownership/list', headers = {}, body = '{}' } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: ADMIN_HOST, port, method: 'POST', path: route, headers: { 'content-type': 'application/json', ...headers } }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: text }));
      });
      req.on('error', reject); req.end(body);
    });
  }
  const serviceHeaders = { 'x-nightscout-internal-service': 'ownership-operations', 'x-nightscout-internal-version': '1' };

  before(async function () {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-adm-'));
    fs.chmodSync(configDir, 0o700);
    const password = crypto.randomBytes(24).toString('hex');
    execFileSync('docker', ['run', '--name', container, '--label', 'nightscout.test=admin-role-ownership', '-d', '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_USER=bootstrap', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=nightscout_admin_role_test', IMAGE],
    { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
    owned = true;
    // Reaper: removes the container if this process dies before `after` runs.
    reaper = spawn('sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 2; done; docker rm -f -v "$2" >/dev/null 2>&1', 'reaper', String(process.pid), container],
      { detached: true, stdio: 'ignore' });
    reaper.unref();
    const port = docker(['port', container, '5432/tcp']).split(':').pop();
    adminURI = 'postgres://bootstrap:' + password + '@127.0.0.1:' + port + '/nightscout_admin_role_test';
    const deadline = Date.now() + 30000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'bootstrap']); admin = new Client({ connectionString: adminURI }); await admin.connect(); ready = true; }
      catch { if (admin) await admin.end().catch(() => {}); admin = null; await sleep(200); }
    }
    assert.ok(ready, 'disposable PostgreSQL ready');
    // The deployment bootstrap's shape: a NOLOGIN catalogue owner, the authorization
    // catalogue in its namespace, then exactly the plan's grants for the identity.
    await admin.query(`CREATE ROLE "${layout.owner}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);
    const rolePassword = crypto.randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE "${IDENTITY}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${rolePassword}'`);
    await admin.query(`CREATE SCHEMA "${NS}"`);
    await run('up', { direct: true, connectionString: adminURI, namespace: NS, catalogue });
    assert.equal((await run('check', { direct: true, connectionString: adminURI, namespace: NS, catalogue })).current, true);
    for (const row of (await admin.query('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname=$1', [NS])).rows) {
      await admin.query(`ALTER TABLE "${NS}"."${row.tablename}" OWNER TO "${layout.owner}"`);
    }
    await admin.query(`ALTER SCHEMA "${NS}" OWNER TO "${layout.owner}"`);
    const grants = plan.grants(layout).filter(sql => sql.endsWith(' TO "' + IDENTITY + '"'));
    assert.ok(grants.length > 0, 'deployment plan grants the ownership identity');
    for (const sql of grants) await admin.query(sql);
    const url = new URL(adminURI); url.username = IDENTITY; url.password = rolePassword; identityURI = url.toString();
  });

  beforeEach(async function () {
    for (const table of ['tenant_subject_admin_audit', 'tenant_owner_actors', 'tenant_owner_policy', 'tenant_authorization_subjects', 'tenant_authorization_config']) {
      await admin.query('DELETE FROM ' + t(table));
    }
    await admin.query(`INSERT INTO ${t('tenant_authorization_config')} (tenant_id, anonymous_roles) VALUES ($1, ARRAY['denied']), ($2, ARRAY['denied'])`, [A, B]);
    await admin.query(`INSERT INTO ${t('tenant_owner_policy')} (tenant_id, catalogue_digest, ceiling) VALUES ($1,$3,$4), ($2,$3,$4)`, [A, B, catalogueDigest(['*']), CEILING]);
    await admin.query(`INSERT INTO ${t('tenant_authorization_subjects')} (tenant_id, subject_id) VALUES
      ($1,'s_owner1'),($1,'s_owner2'),($1,'s_new'),($1,'s_new2'),($2,'s_bowner'),($2,'s_new')`, [A, B]);
    await admin.query(`INSERT INTO ${t('tenant_owner_actors')} (tenant_id,principal,consumer,active,can_update,delegable) VALUES
      ($1,'s_owner1',$3,true,true,ARRAY['api:*:read']), ($2,'s_bowner',$3,true,true,ARRAY['api:*:read'])`, [A, B, CONSUMER]);
  });

  after(async function () {
    try {
      if (role) await role.stop();
      if (admin) await admin.end();
    } finally {
      if (owned) docker(['rm', '-f', '-v', container]);
      if (configDir) fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  describe('the ownership identity, as the deployment plan grants it', function () {
    it('holds exactly the ownership tables and cannot write any other authorization table', async function () {
      const identity = new Client({ connectionString: identityURI });
      await identity.connect();
      try {
        const privileges = (await identity.query(`SELECT c.relname AS name,
            has_table_privilege(c.oid,'SELECT') AS reads, has_table_privilege(c.oid,'INSERT') AS inserts,
            has_table_privilege(c.oid,'UPDATE') AS updates, has_table_privilege(c.oid,'DELETE') AS deletes,
            has_table_privilege(c.oid,'TRUNCATE,REFERENCES,TRIGGER') AS other,
            ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
              AND has_column_privilege(c.oid,a.attnum,'UPDATE') ORDER BY a.attname) AS update_columns
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p') ORDER BY c.relname`, [NS])).rows;
        const held = Object.fromEntries(privileges.filter(row => row.reads || row.inserts || row.updates || row.deletes || row.other || row.update_columns.length)
          .map(row => [row.name, { reads: row.reads, inserts: row.inserts, updates: row.updates, deletes: row.deletes, other: row.other, columns: row.update_columns }]));
        assert.deepEqual(held, {
          tenant_authorization_config: { reads: true, inserts: false, updates: false, deletes: false, other: false, columns: ['owner_fence'] },
          tenant_authorization_subjects: { reads: true, inserts: false, updates: false, deletes: false, other: false, columns: [] },
          tenant_owner_actors: { reads: true, inserts: true, updates: false, deletes: false, other: false, columns: ['active', 'can_update', 'delegable'] },
          tenant_owner_policy: { reads: true, inserts: false, updates: false, deletes: false, other: false, columns: ['owner_fence'] },
          tenant_subject_admin_audit: { reads: false, inserts: true, updates: false, deletes: false, other: false, columns: [] }
        });
        const attempts = [
          `DELETE FROM ${t('tenant_owner_actors')}`,
          `UPDATE ${t('tenant_owner_policy')} SET ceiling=ARRAY['*']`,
          `UPDATE ${t('tenant_owner_actors')} SET consumer='x'`,
          `INSERT INTO ${t('tenant_authorization_roles')} (tenant_id, name, permissions) VALUES ('${A}', 'r', ARRAY['*'])`,
          `INSERT INTO ${t('tenant_authorization_subjects')} (tenant_id, subject_id) VALUES ('${A}', 's_x')`,
          `DELETE FROM ${t('tenant_authorization_subject_roles')}`,
          `SELECT * FROM ${t('tenant_subject_admin_audit')}`,
          `SELECT * FROM ${t('schema_migrations')}`,
          `CREATE TABLE "${NS}".planted (x int)`
        ];
        for (const sql of attempts) {
          await assert.rejects(identity.query(sql), error => error.code === '42501', sql);
        }
      } finally { await identity.end(); }
    });
  });

  describe('a running `nightscout multitenant admin` process', function () {
    before(async function () {
      role = await startRole();
      assert.ok(role.outcome.listening, 'admin role listening; stderr: ' + role.out.stderr + ' exit: ' + JSON.stringify(role.outcome.status));
    });
    after(async function () {
      if (role) {
        const status = await role.stop();
        role = null;
        assert.equal(status.code, 0, 'admin role exits 0 on SIGTERM');
      }
    });

    it('serves the ownership-operations contract on the admin listener and nothing else', async function () {
      assert.deepEqual(await role.client.listOwners({ tenant: A }), { outcome: 'listed', owners: [ref('s_owner1')] });
      const unknownRoute = await raw(role.port, { path: '/api/v3/version', headers: serviceHeaders });
      assert.equal(unknownRoute.status, 503);
      const unlabelled = await raw(role.port, { body: JSON.stringify({ tenant: A }) });
      assert.equal(unlabelled.status, 503, 'a request without the service contract headers is refused');
      const smuggled = await raw(role.port, { path: '/ownership/add', headers: serviceHeaders,
        body: JSON.stringify({ tenant: A, owner: ref('s_new'), delegable: [], expectedOwners: [ref('s_owner1')], credential: 'synthetic' }) });
      assert.equal(smuggled.status, 503, 'a request outside the schema is refused');
      assert.deepEqual((await rows(A)).audit, [], 'refused requests leave no audit row');
    });

    it('adds a co-owner, transfers and refuses a stale owner set, each audited', async function () {
      const added = await role.client.addOwner({ tenant: A, owner: ref('s_owner2'), delegable: ['api:*:read'], expectedOwners: [ref('s_owner1')] });
      assert.equal(added.outcome, 'applied');
      assert.deepEqual(await owners(A), ['s_owner1', 's_owner2']);
      const stale = await role.client.addOwner({ tenant: A, owner: ref('s_new'), delegable: [], expectedOwners: [ref('s_owner1')] });
      assert.equal(stale.outcome, 'refused'); assert.equal(stale.code, 'OWNERSHIP_CONFLICT');
      const transferred = await role.client.transferOwner({ tenant: A, from: ref('s_owner2'), to: ref('s_new'),
        expectedOwners: [ref('s_owner1'), ref('s_owner2')] });
      assert.equal(transferred.outcome, 'applied');
      assert.deepEqual(await owners(A), ['s_new', 's_owner1']);
      const audit = (await rows(A)).audit;
      assert.deepEqual(audit.map(row => [row.operation, row.outcome, row.subject_id, row.principal, row.consumer]), [
        ['owner-add', 'applied', 's_owner2', OPERATOR.principal, OPERATOR.consumer],
        ['owner-add', 'refused', 's_new', OPERATOR.principal, OPERATOR.consumer],
        ['owner-transfer', 'applied', 's_new', OPERATOR.principal, OPERATOR.consumer]
      ]);
    });

    it('recovers a tenant whose owner subjects were deleted, returning identifiers only', async function () {
      await admin.query(`DELETE FROM ${t('tenant_authorization_subjects')} WHERE tenant_id=$1 AND subject_id='s_owner1'`, [A]);
      assert.deepEqual((await role.client.listOwners({ tenant: A })).owners, []);
      const recovered = await role.client.recoverOwner({ tenant: A, owner: ref('s_new'), delegable: ['api:*:read'], expectedOwners: [] });
      assert.equal(recovered.outcome, 'applied');
      assert.deepEqual(Object.keys(recovered).sort(), ['code', 'event', 'outcome', 'owners']);
      assert.deepEqual(recovered.owners, [ref('s_new')]);
      assert.deepEqual(await owners(A), ['s_new']);
    });

    it('acts only for its configured tenants: tenant B is denied with no effect in either tenant', async function () {
      const before = [await rows(A), await rows(B)];
      for (const [method, body] of [
        ['listOwners', { tenant: B }],
        ['addOwner', { tenant: B, owner: ref('s_new'), delegable: [], expectedOwners: [ref('s_bowner')] }],
        ['transferOwner', { tenant: B, from: ref('s_bowner'), to: ref('s_new'), expectedOwners: [ref('s_bowner')] }],
        ['recoverOwner', { tenant: B, owner: ref('s_new'), delegable: [], expectedOwners: [ref('s_bowner')] }]
      ]) {
        assert.deepEqual(await role.client[method](body), { outcome: 'denied', code: 'OWNERSHIP_FORBIDDEN', event: null }, method);
      }
      assert.deepEqual([await rows(A), await rows(B)], before);
    });

    it('race: two concurrent transfers through the role, exactly one applies', async function () {
      const holder = new Client({ connectionString: adminURI });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT * FROM ${t('tenant_owner_actors')} WHERE tenant_id=$1 FOR UPDATE`, [A]);
        const first = role.client.transferOwner({ tenant: A, from: ref('s_owner1'), to: ref('s_new'), expectedOwners: [ref('s_owner1')] });
        const second = role.client.transferOwner({ tenant: A, from: ref('s_owner1'), to: ref('s_new2'), expectedOwners: [ref('s_owner1')] });
        const deadline = Date.now() + 15000;
        let waiting = 0;
        while (Date.now() < deadline) {
          waiting = Number((await admin.query(`SELECT count(*) AS n FROM pg_stat_activity
            WHERE application_name='nightscout-ownership-ops' AND wait_event_type='Lock'`)).rows[0].n);
          if (waiting === 2) break;
          await sleep(25);
        }
        assert.equal(waiting, 2, 'both role transactions wait on the held row');
        await holder.query('COMMIT');
        const results = await Promise.all([first, second]);
        assert.deepEqual(results.map(result => result.outcome).sort(), ['applied', 'refused']);
        assert.equal(results.find(result => result.outcome === 'refused').code, 'OWNERSHIP_CONFLICT');
        const winner = results.find(result => result.outcome === 'applied').owners.map(owner => owner.principal);
        assert.deepEqual(await owners(A), winner);
        assert.equal(winner.length, 1);
      } finally { await holder.end(); }
    });

    it('fails closed when a required grant is revoked under the running role: permission error, no partial write', async function () {
      const audit = t('tenant_subject_admin_audit');
      const before = await rows(A);
      await admin.query(`REVOKE INSERT ON ${audit} FROM "${IDENTITY}"`);
      try {
        await assert.rejects(role.client.addOwner({ tenant: A, owner: ref('s_owner2'), delegable: [], expectedOwners: [ref('s_owner1')] }),
          { message: 'SOCKET_IPC_UNAVAILABLE' });
        assert.deepEqual(await rows(A), before, 'the transaction rolled back');
        const logs = spawnSync('docker', ['logs', container], { encoding: 'utf8' });
        assert.match(logs.stdout + logs.stderr, /permission denied for table tenant_subject_admin_audit/);
      } finally {
        await admin.query(`GRANT INSERT ON ${audit} TO "${IDENTITY}"`);
      }
      assert.equal((await role.client.addOwner({ tenant: A, owner: ref('s_owner2'), delegable: [], expectedOwners: [ref('s_owner1')] })).outcome, 'applied');
    });
  });

  describe('startup refusals', function () {
    async function refused (mutate, restore) {
      await admin.query(mutate);
      let started;
      try {
        started = await startRole();
        assert.ok(started.outcome.status, 'role exits instead of listening; stdout: ' + started.out.stdout);
        assert.equal(started.outcome.status.code, 1);
        assert.match(started.out.stderr, /could not start: preview startup failed/);
        assert.doesNotMatch(started.out.stdout, /Listening for role admin/);
      } finally {
        if (started) await started.stop();
        await admin.query(restore);
      }
    }
    it('refuses an identity with DELETE on owner actors (privilege screen)', async function () {
      await refused(`GRANT DELETE ON ${t('tenant_owner_actors')} TO "${IDENTITY}"`, `REVOKE DELETE ON ${t('tenant_owner_actors')} FROM "${IDENTITY}"`);
    });
    it('refuses an identity missing a required grant (privilege screen)', async function () {
      await refused(`REVOKE SELECT ON ${t('tenant_authorization_subjects')} FROM "${IDENTITY}"`, `GRANT SELECT ON ${t('tenant_authorization_subjects')} TO "${IDENTITY}"`);
    });
    it('refuses a BYPASSRLS identity', async function () {
      await refused(`ALTER ROLE "${IDENTITY}" BYPASSRLS`, `ALTER ROLE "${IDENTITY}" NOBYPASSRLS`);
    });
  });
});
