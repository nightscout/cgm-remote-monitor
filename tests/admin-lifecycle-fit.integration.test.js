'use strict';

// covers: lib/server/serve/operation-cohort.js, lib/tenant-lifecycle/clinical-catalogue.js, lib/tenant-lifecycle/tenant-phase.js, lib/tenant-lifecycle/maintenance-window.js, lib/tenant-ownership/postgres.js, lib/server/serve/listeners.js, lib/server/serve/admin-preview.js, deploy/multitenant/config.js

// The admin role beside a tenant restore (16.0.0 decisions
// restore-census-and-ownership-phase and admin-plane-same-address-different-port),
// on disposable PostgreSQL with the deployment plan's whole catalogue and grants
// (deploy/multitenant/config.js, applied as bootstrap.js applies them, without
// Vault). A real `nightscout multitenant admin` process is connected as the
// ownership_operator identity while the real maintenance controller
// (maintenance-window.js) suspends, holds and reactivates tenant A under the real
// remote cohort census (operation-cohort.js createRemote/assertComplete) as the
// plan's maintenance operator identity. The four participants are synthetic
// lifecycle-participant peers on real Unix sockets, each reporting one real
// backend opened as that role's database identity; the census itself reads the
// real pg_stat_activity and catalogue. The restore body is a read under the
// claim, not a logical clinical reconciliation. Synthetic data only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { Client, Pool } = require('pg');
const { run } = require('../lib/migrations/postgres');
const plan = require('../deploy/multitenant/config');
const clients = require('../lib/server/internal-api/clients');
const ipc = require('../lib/server/internal-api/transport');
const contracts = require('../lib/server/internal-api/contracts');
const manifest = require('../lib/server/serve/operation-cohort-manifest');
const cohorts = require('../lib/server/serve/operation-cohort');
const maintenance = require('../lib/tenant-lifecycle/maintenance-window');
const datastore = require('../lib/storage/postgres-datastore');
const { catalogueDigest } = require('../lib/subject-admin/owner-policy');
const scope = require('../lib/storage/tenant-scope');
const { optInSuite } = require('./support/opt-in');

// postgres:16, pinned by digest. Override only with another digest.
const IMAGE = process.env.NS_ADMIN_LIFECYCLE_PG_IMAGE || 'postgres@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97';
const { A, B } = plan;
const ROOT = path.join(__dirname, '..');
const OPERATOR = { principal: 'synthetic_operator', consumer: 'operator_plane' };
const CONSUMER = 'tenant-admin';
const ref = principal => ({ principal, consumer: CONSUMER });
const PEERS = { api: 'api', realtime: 'realtime', evaluator: 'evaluator', 'tenant-admin': 'owner_writer' };
const DIGEST = 'c'.repeat(64);
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = host => new Promise(resolve => { const probe = net.createServer().listen(0, host, () => { const p = probe.address().port; probe.close(() => resolve(p)); }); });

optInSuite(process.env.NS_ADMIN_LIFECYCLE_DOCKER_TEST === '1',
  'NS_ADMIN_LIFECYCLE_DOCKER_TEST=1')('admin role beside a tenant restore (disposable PostgreSQL, deployment grants)', function () {
  this.timeout(120000);
  const container = 'ns-fit-' + crypto.randomBytes(6).toString('hex');
  const l = plan.layout('nsfit'), ns = l.namespaces, q = plan.quote;
  const t = (name, table) => q(ns[name]) + '.' + q(table);
  const urls = {};
  let previousMode, owned = false, bootstrapURI, configDir, socketDir, role, consumerPort, participants = [], peers = [], operatorPool;

  // A short-lived superuser session: closed before any census, where it would be
  // an unregistered backend with every privilege.
  async function asBootstrap (fn) {
    const client = new Client({ connectionString: bootstrapURI }); await client.connect();
    try { return await fn(client); } finally { await client.end(); }
  }
  async function backendsOf (identity) {
    return asBootstrap(async client => (await client.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=$1', [identity])).rows[0].n);
  }
  async function startRole (env) {
    const file = path.join(configDir, crypto.randomBytes(4).toString('hex') + '.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, maxBytes: 65536, timeoutMs: 10000,
      ownership: { connectionEnv: 'NS_OWNERSHIP_PG', namespace: ns.authorization, lifecycleNamespace: ns.control, operator: OPERATOR, tenants: [A, B] } }), { mode: 0o600 });
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/nightscout.js'), 'multitenant', 'admin'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, MULTITENANT_STATIC_TENANTS: 'lab', MULTITENANT_ADMIN_CONFIG: file, NS_OWNERSHIP_PG: urls.ownership_operator, ...env }
    });
    const out = { stdout: '', stderr: '' };
    child.stdout.on('data', chunk => { out.stdout += chunk; });
    child.stderr.on('data', chunk => { out.stderr += chunk; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    const outcome = await Promise.race([
      exited.then(status => ({ status })),
      (async () => { while (!/Listening for role admin on /.test(out.stdout)) await sleep(50); return { listening: true }; })(),
      sleep(30000).then(() => ({ timeout: true }))
    ]);
    return { child, out, exited, outcome, async stop () { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); return exited; } };
  }

  before(async function () {
    previousMode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-fit-')); fs.chmodSync(configDir, 0o700);
    socketDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ns-fit-ipc-'))); fs.chmodSync(socketDir, 0o700);
    const password = crypto.randomBytes(24).toString('hex');
    execFileSync('docker', ['run', '--name', container, '--label', 'nightscout.test=admin-lifecycle-fit', '-d', '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_USER=bootstrap', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=nightscout_fit_test', IMAGE],
    { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
    owned = true;
    spawn('sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 2; done; docker rm -f -v "$2" >/dev/null 2>&1', 'reaper', String(process.pid), container],
      { detached: true, stdio: 'ignore' }).unref();
    const port = docker(['port', container, '5432/tcp']).split(':').pop();
    bootstrapURI = 'postgres://bootstrap:' + password + '@127.0.0.1:' + port + '/nightscout_fit_test';
    const deadline = Date.now() + 30000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'bootstrap']); await asBootstrap(async () => {}); ready = true; }
      catch { await sleep(200); }
    }
    assert.ok(ready, 'disposable PostgreSQL ready');
    // bootstrap.js's PostgreSQL steps: roles, every catalogue owned by a NOLOGIN
    // owner, then exactly plan.grants(l).
    await asBootstrap(async admin => {
      await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await admin.query('REVOKE CREATE ON DATABASE "nightscout_fit_test" FROM PUBLIC');
      await admin.query('CREATE ROLE ' + q(l.owner) + ' NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION');
      for (const [kind, name] of Object.entries(l.roles)) {
        const secret = crypto.randomBytes(24).toString('hex');
        await admin.query('CREATE ROLE ' + q(name) + " LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '" + secret + "'");
        const url = new URL(bootstrapURI); url.username = name; url.password = secret; urls[kind] = url.toString();
      }
      for (const [kind, catalogue] of Object.entries(plan.catalogues())) {
        const namespace = ns[kind]; await admin.query('CREATE SCHEMA ' + q(namespace));
        await run('up', { direct: true, connectionString: bootstrapURI, namespace, catalogue, statementTimeoutMs: 10000 });
        for (const row of (await admin.query('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname=$1', [namespace])).rows) {
          await admin.query('ALTER TABLE ' + q(namespace) + '.' + q(row.tablename) + ' OWNER TO ' + q(l.owner));
        }
        // Every function with its own signature (the change-stamp function takes uuid[]).
        for (const row of (await admin.query('SELECT p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1', [namespace])).rows) {
          await admin.query('ALTER FUNCTION ' + q(namespace) + '.' + q(row.proname) + '(' + row.args + ') OWNER TO ' + q(l.owner));
        }
        await admin.query('ALTER SCHEMA ' + q(namespace) + ' OWNER TO ' + q(l.owner));
      }
      for (const sql of plan.grants(l)) await admin.query(sql);
      const docs = plan.documents({ layout: l, urls: { evaluator: bootstrapURI }, tokens: ['x', 'y'], publicKeys: [], managementKeys: [], vaultAddress: 'https://vault:8200' });
      for (const [i, tenant] of [A, B].entries()) {
        await admin.query('INSERT INTO ' + t('control', 'tenant_lifecycle_windows') + "(tenant_id,lock_key,phase,generation) VALUES($1,$2,'active',1)", [tenant, docs.locks[i].key]);
      }
      await admin.query('INSERT INTO ' + t('control', 'tenant_lifecycle_restore_authority') + '(tenant_id,role_oid,active) VALUES($1,$2::regrole::oid,true)', [A, l.roles.operator]);
      for (const tenant of [A, B]) {
        await admin.query('INSERT INTO ' + t('authorization', 'tenant_authorization_config') + " (tenant_id, anonymous_roles) VALUES ($1, ARRAY['denied'])", [tenant]);
        await admin.query('INSERT INTO ' + t('authorization', 'tenant_owner_policy') + ' (tenant_id, catalogue_digest, ceiling) VALUES ($1,$2,$3)', [tenant, catalogueDigest(['*']), ['api:*:read']]);
        await admin.query('INSERT INTO ' + t('authorization', 'tenant_authorization_subjects') + " (tenant_id, subject_id) VALUES ($1,'s_owner1'),($1,'s_owner2')", [tenant]);
        await admin.query('INSERT INTO ' + t('authorization', 'tenant_owner_actors') + " (tenant_id,principal,consumer,active,can_update,delegable) VALUES ($1,'s_owner1',$2,true,true,ARRAY['api:*:read'])", [tenant, CONSUMER]);
      }
      this.locks = docs.locks; this.remote = docs.remote;
    });
    // One real backend per participant role, as that role's database identity.
    const datastoreRow = {};
    for (const [participant, identity] of Object.entries(PEERS)) {
      const client = new Client({ connectionString: urls[identity] }); await client.connect();
      const row = (await client.query('SELECT pg_backend_pid() AS pid,current_user AS role,extract(epoch from backend_start)::text AS birth,' + datastore.SQL +
        ' FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];
      Object.assign(datastoreRow, datastore.identity(row));
      participants.push({ participant, client, backend: { pid: row.pid, role: row.role, birth: row.birth } });
    }
    // Synthetic lifecycle-participant peers on real Unix sockets.
    const entries = manifest.validate(this.remote.map(peer => ({ id: peer.id, roles: peer.roles, namespaces: peer.namespaces,
      endpoint: { socketPath: path.join(socketDir, peer.id + '.sock'), maxBytes: 1048576, timeoutMs: 5000 } })));
    for (const entry of entries) {
      const incarnation = crypto.randomUUID(), backend = participants.find(row => row.participant === entry.roles[0]).backend;
      const status = request => ({ version: 1, participant: entry.id, incarnation, namespace: ns.control, roles: [...entry.roles],
        tenants: [A, B].sort(), namespaces: [...entry.namespaces], identity: { namespaceOid: 1 }, datastore: { ...datastoreRow }, backends: [backend], request });
      peers.push(await ipc.open(entry.endpoint, contracts.lifecycleParticipant, () => ({
        getStatus: async (ctx, body) => status(body.request),
        invalidateTenant: async (ctx, body) => ({ ...status(body.request), tenant: body.tenant })
      })));
    }
    this.entries = entries;
    // One operator backend: the census excludes only its own connection.
    operatorPool = new Pool({ connectionString: urls.operator, max: 1 });
    // The admin role on the consumer listener's address (HOSTNAME=127.0.0.1) at
    // another port: refused before decision admin-plane-same-address-different-port.
    consumerPort = await freePort('127.0.0.1');
    role = await startRole({ HOSTNAME: '127.0.0.1', PORT: String(consumerPort), ADMIN_PORT: String(await freePort('127.0.0.1')) });
    assert.ok(role.outcome.listening, 'admin role listening; stderr: ' + role.out.stderr + ' exit: ' + JSON.stringify(role.outcome.status));
    const address = /Listening for role admin on ([0-9.]+):([0-9]+)/.exec(role.out.stdout);
    this.ownership = clients.ownershipOperations({ url: 'http://' + address[1] + ':' + address[2] + '/', trust: 'network', maxBytes: 65536, timeoutMs: 10000 });
    this.adminAddress = address[1];
  });

  after(async function () {
    try {
      if (role) await role.stop();
      for (const peer of peers) await peer.close();
      for (const row of participants) await row.client.end();
      if (operatorPool) await operatorPool.end();
    } finally {
      scope.setTenancyMode(previousMode);
      if (owned) docker(['rm', '-f', '-v', container]);
      for (const dir of [configDir, socketDir]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function restore (body, digest = DIGEST) {
    const cohort = await cohorts.createRemote({ namespace: ns.control, tenants: [A, B], participants: this.entries });
    const controller = maintenance.create({ namespace: ns.control, locks: this.locks, pool: operatorPool, cohort, drainTimeoutMs: 5000 });
    try { return await controller.withRestore(A, { artifactDigest: digest }, body); }
    finally { await controller.close(); await cohort.close(); }
  }
  async function phaseOf (tenant) {
    return asBootstrap(async client => (await client.query('SELECT phase FROM ' + t('control', 'tenant_lifecycle_windows') + ' WHERE tenant_id=$1', [tenant])).rows[0].phase);
  }
  async function ownershipRows (tenant) {
    return asBootstrap(async client => ({
      actors: (await client.query('SELECT principal,active,can_update FROM ' + t('authorization', 'tenant_owner_actors') + ' WHERE tenant_id=$1 ORDER BY principal', [tenant])).rows,
      audit: (await client.query('SELECT operation,outcome,detail FROM ' + t('authorization', 'tenant_subject_admin_audit') + ' WHERE tenant_id=$1 ORDER BY event_time,event_id', [tenant])).rows
    }));
  }

  it('starts the admin role on the consumer listener\'s address at another port, and refuses its port', async function () {
    assert.equal(this.adminAddress, '127.0.0.1');
    const same = await startRole({ HOSTNAME: '127.0.0.1', PORT: String(consumerPort), ADMIN_PORT: String(consumerPort) });
    assert.deepEqual(same.outcome, { status: { code: 78, signal: null } });
    assert.match(same.out.stderr, /would share the consumer listener/);
    const wildcard = await startRole({ ADMIN_HOSTNAME: '0.0.0.0', ADMIN_INSECURE_BIND_ACKNOWLEDGED: 'true', ADMIN_PORT: String(await freePort('127.0.0.1')) });
    assert.equal(wildcard.outcome.status?.code, 78); assert.match(wildcard.out.stderr, /every interface/);
    const exposed = await startRole({ ADMIN_HOSTNAME: '192.0.2.10', ADMIN_PORT: String(await freePort('127.0.0.1')) });
    assert.equal(exposed.outcome.status?.code, 78); assert.match(exposed.out.stderr, /ADMIN_INSECURE_BIND_ACKNOWLEDGED=true/);
  });

  it('restores tenant A with the admin role connected; ownership changes on A refuse while it is held', async function () {
    const before = await ownershipRows(A), beforeB = await ownershipRows(B);
    assert.deepEqual((await this.ownership.listOwners({ tenant: A })).owners, [ref('s_owner1')]);
    assert.ok(await backendsOf(l.roles.ownership_operator) >= 1, 'admin role connected before the restore');
    const during = {};
    const result = await restore.call(this, async ({ connection }) => {
      during.rows = (await connection.query('SELECT count(*)::int AS n FROM ' + t('entries', 'entries') + ' WHERE tenant_id=$1', [A])).rows[0].n;
      during.add = await this.ownership.addOwner({ tenant: A, owner: ref('s_owner2'), delegable: [], expectedOwners: [ref('s_owner1')] });
      during.transfer = await this.ownership.transferOwner({ tenant: A, from: ref('s_owner1'), to: ref('s_owner2'), expectedOwners: [ref('s_owner1')] });
      during.other = await this.ownership.addOwner({ tenant: B, owner: ref('s_owner2'), delegable: [], expectedOwners: [ref('s_owner1')] });
      return 'restored';
    });
    assert.deepEqual({ tenant: result.tenant, state: result.state, result: result.result }, { tenant: A, state: 'activated', result: 'restored' });
    assert.equal(during.rows, 0);
    for (const refused of [during.add, during.transfer]) {
      assert.deepEqual({ outcome: refused.outcome, code: refused.code, owners: refused.owners }, { outcome: 'refused', code: 'OWNERSHIP_TENANT_INACTIVE', owners: [ref('s_owner1')] });
    }
    assert.equal(during.other.outcome, 'applied', 'tenant B is not held by A\'s restore');
    const after = await ownershipRows(A);
    assert.deepEqual(after.actors, before.actors, 'no ownership effect on A during its restore');
    assert.deepEqual(after.audit.slice(before.audit.length).map(row => [row.operation, row.outcome, row.detail.code, row.detail.lifecycle]),
      [['owner-add', 'refused', 'OWNERSHIP_TENANT_INACTIVE', 'held'], ['owner-transfer', 'refused', 'OWNERSHIP_TENANT_INACTIVE', 'held']]);
    assert.equal((await ownershipRows(B)).audit.length, beforeB.audit.length + 1);
    assert.equal(await phaseOf(A), 'active');
    // Active again: the same add applies.
    assert.equal((await this.ownership.addOwner({ tenant: A, owner: ref('s_owner2'), delegable: [], expectedOwners: [ref('s_owner1')] })).outcome, 'applied');
  });

  it('refuses the restore, before suspending A, when the ownership identity holds one clinical table at census time', async function () {
    await asBootstrap(client => client.query('GRANT SELECT ON ' + t('entries', 'entries') + ' TO ' + q(l.roles.ownership_operator)));
    try {
      await this.ownership.listOwners({ tenant: A });
      assert.ok(await backendsOf(l.roles.ownership_operator) >= 1, 'admin role connected');
      let entered = false;
      await assert.rejects(restore.call(this, async () => { entered = true; }), { code: 'RESTORE_COHORT_UNKNOWN_BACKEND' });
      assert.equal(entered, false);
      assert.equal(await phaseOf(A), 'active');
    } finally {
      await asBootstrap(client => client.query('REVOKE SELECT ON ' + t('entries', 'entries') + ' FROM ' + q(l.roles.ownership_operator)));
    }
    await this.ownership.listOwners({ tenant: A });
    assert.equal((await restore.call(this, async () => 'again')).state, 'activated', 'grant revoked: the census accepts the role again');
  });

  // Decision restore-census-counter-writers: a non-participant that can WRITE the
  // insertion-order or write-clock counters refuses; one that can only read them
  // (like the plan's readiness identity) does not.
  it('refuses a non-participant that can write the write clock or the insertion order, and proceeds when it can only read them', async function () {
    const probe = l.prefix + '_counter_probe', secret = crypto.randomBytes(24).toString('hex');
    const url = new URL(bootstrapURI); url.username = probe; url.password = secret;
    await asBootstrap(async client => {
      await client.query('CREATE ROLE ' + q(probe) + " LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '" + secret + "'");
      await client.query('GRANT USAGE ON SCHEMA ' + q(ns.clock) + ' TO ' + q(probe));
      await client.query('GRANT INSERT ON ' + t('clock', 'tenant_write_clock') + ' TO ' + q(probe));
    });
    const connect = async uri => { const c = new Client({ connectionString: uri }); await c.connect(); return c; };
    let writer = await connect(url.toString());
    try {
      await this.ownership.listOwners({ tenant: A });
      let entered = false;
      await assert.rejects(restore.call(this, async () => { entered = true; }), { code: 'RESTORE_COHORT_UNKNOWN_BACKEND' });
      assert.equal(entered, false); assert.equal(await phaseOf(A), 'active');
    } finally { await writer.end(); }
    await asBootstrap(async client => {
      await client.query('REVOKE INSERT ON ' + t('clock', 'tenant_write_clock') + ' FROM ' + q(probe));
      await client.query('GRANT SELECT ON ' + t('clock', 'tenant_write_clock') + ' TO ' + q(probe));
    });
    writer = await connect(url.toString());
    const readiness = await connect(urls.readiness);
    try {
      await this.ownership.listOwners({ tenant: A });
      assert.ok(await backendsOf(l.roles.ownership_operator) >= 1, 'admin role connected');
      assert.equal((await restore.call(this, async () => 'read-only')).state, 'activated');
    } finally { await writer.end(); await readiness.end(); }
    // The insertion-order counter: UPDATE on entries' ordinal table refuses the same way.
    await asBootstrap(async client => {
      await client.query('GRANT USAGE ON SCHEMA ' + q(ns.entries) + ' TO ' + q(probe));
      await client.query('GRANT UPDATE ON ' + t('entries', 'tenant_insertion_ordinal') + ' TO ' + q(probe));
    });
    writer = await connect(url.toString());
    try {
      await assert.rejects(restore.call(this, async () => {}), { code: 'RESTORE_COHORT_UNKNOWN_BACKEND' });
      assert.equal(await phaseOf(A), 'active');
    } finally { await writer.end(); }
    await asBootstrap(client => client.query('REVOKE UPDATE ON ' + t('entries', 'tenant_insertion_ordinal') + ' FROM ' + q(probe)));
  });

  // Synthetic entries written as the bootstrap superuser under the tenant binding
  // (the insertion-order trigger requires it), with a live write-clock floor.
  async function inTenant (tenant, fn) {
    return asBootstrap(async client => {
      await client.query('BEGIN'); await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
      try { const value = await fn(client); await client.query('COMMIT'); return value; } catch (error) { await client.query('ROLLBACK'); throw error; }
    });
  }
  const entry = (id, sgv, stamp) => JSON.stringify({ _id: id, identifier: id, type: 'sgv', sgv, date: 1700000000000 + stamp, srvModified: stamp, srvCreated: stamp });
  async function seed () {
    for (const [tenant, id] of [[A, 'seed-a1'], [B, 'seed-b1']]) {
      await inTenant(tenant, async client => {
        await client.query('INSERT INTO ' + t('clock', 'tenant_write_clock') + ' (tenant_id,last_stamp) VALUES ($1,1000) ON CONFLICT (tenant_id) DO UPDATE SET last_stamp=1000', [tenant]);
        await client.query('INSERT INTO ' + t('entries', 'entries') + " (tenant_id,id_kind,doc) VALUES ($1,'string',$2::jsonb)", [tenant, entry(id, 100, 500)]);
      });
    }
    return observe(A);
  }
  async function alter () {
    await inTenant(A, async client => {
      await client.query('UPDATE ' + t('entries', 'entries') + " SET doc=jsonb_set(doc,'{sgv}','200') WHERE tenant_id=$1 AND doc->>'_id'='seed-a1'", [A]);
      await client.query('INSERT INTO ' + t('entries', 'entries') + " (tenant_id,id_kind,doc) VALUES ($1,'string',$2::jsonb)", [A, entry('seed-a2', 150, 600)]);
    });
    assert.deepEqual((await observe(A)).map(row => row.sgv), [200, 150]);
  }
  // Rows that read as current: _id and sgv, ordered by insertion.
  async function observe (tenant) {
    return inTenant(tenant, async client => (await client.query('SELECT doc FROM ' + t('entries', 'entries') +
      " WHERE tenant_id=$1 AND COALESCE(doc->>'isValid','true')<>'false' ORDER BY insertion_ordinal", [tenant])).rows.map(row => ({ _id: row.doc._id, sgv: row.doc.sgv })));
  }

  // BF-230 regression: the clinical logical restore (logical-restore.js) through
  // the shipped Compose driver (deploy/multitenant/restore.js capture/restore),
  // under the deployment plan's grants, with the admin role connected. A carries a
  // retained key-retention record (a deletion inside its 30-day window), so the
  // restore's retention gate reads and updates the ledger as the plan's operator.
  it('captures A, alters A, and restores A logically through the shipped driver with the admin role connected', async function () {
    const config = { tenants: [{ id: A }, { id: B }], drainTimeoutMs: 5000,
      control: { namespace: ns.control, locks: this.locks, participants: this.entries }, ...plan.lifecycle(l) };
    const env = { NS_OPERATOR_PG: urls.operator, NS_SOURCE_COMMIT: 'f'.repeat(40) };
    const operator = require('../deploy/multitenant/restore');
    const seeded = await seed();
    const beforeB = await observe(B);
    const artifact = await operator.capture(config, A, env);
    await alter();
    const request = crypto.randomUUID(), now = Date.now();
    await inTenant(A, async client => {
      await client.query('INSERT INTO ' + t('control', 'tenant_lifecycle_requests') + " (request_id,tenant_id,artifact_digest,phase,requested_at,executed_at) VALUES ($1,$2,$3,'executed',$4,$4)", [request, A, artifact.digest, now - 2000]);
      await client.query('INSERT INTO ' + t('control', 'tenant_lifecycle_key_retention') + " (request_id,tenant_id,artifact_digest,key_names,key_references,phase,retained_at,retain_until) VALUES ($1,$2,$3,'[\"tenant-0-data\"]'::jsonb,1,'retained',$4,$5)",
        [request, A, artifact.digest, now - 1000, now + 30 * 86400000]);
    });
    await this.ownership.listOwners({ tenant: A });
    assert.ok(await backendsOf(l.roles.ownership_operator) >= 1, 'admin role connected');
    const summaries = [];
    const result = await operator.restore(config, artifact, env, { onCommitted: summary => { summaries.push(summary); } });
    assert.equal(result.state, 'activated');
    assert.equal(summaries.length, 1);
    assert.deepEqual({ created: summaries[0].created, replaced: summaries[0].replaced, deleted: summaries[0].deleted },
      { created: 0, replaced: 1, deleted: 1 }, 'seed-a1 replaced back, seed-a2 marked deleted');
    assert.deepEqual(await observe(A), seeded, 'A as captured');
    assert.deepEqual(await observe(B), beforeB, 'B unchanged');
    assert.equal(await phaseOf(A), 'active');
    assert.equal(await inTenant(A, async client => (await client.query('SELECT phase FROM ' + t('control', 'tenant_lifecycle_key_retention') + ' WHERE request_id=$1', [request])).rows[0].phase), 'restored');
  });

  it('still refuses an unregistered backend whose identity holds clinical grants', async function () {
    const stranger = new Client({ connectionString: urls.realtime }); await stranger.connect();
    try {
      await assert.rejects(restore.call(this, async () => {}), { code: 'RESTORE_COHORT_UNKNOWN_BACKEND' });
      assert.equal(await phaseOf(A), 'active');
    } finally { await stranger.end(); }
  });
});
