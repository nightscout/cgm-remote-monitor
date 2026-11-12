'use strict';

// covers: lib/server/serve/operation-cohort.js, lib/server/serve/operation-cohort-manifest.js, lib/tenant-lifecycle/maintenance-window.js, lib/server/internal-api/transport.js, deploy/multitenant/config.js

// Two api replicas in the restore census (MT-API-FIXED-ROSTER), on disposable
// PostgreSQL with the deployment plan's whole catalogue and grants (as
// admin-lifecycle-fit.integration.test.js applies them, without Vault). Each api
// replica is a lifecycle-participant peer on its own real HTTP listener that
// reports one real backend opened as the api database identity; realtime,
// evaluator and tenant-admin are peers on real Unix sockets. The real maintenance
// controller (maintenance-window.js) suspends, holds and reactivates tenant A
// under the real remote cohort census (operation-cohort.js createRemote,
// assertComplete, invalidate), which reads the real pg_stat_activity and
// catalogue. Controls: a replica left off the roster, a roster entry that names
// the api service destination (a round-robin proxy over both replicas) and a
// stopped replica must each refuse before A is suspended. Synthetic data only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { Client, Pool } = require('pg');
const { run } = require('../lib/migrations/postgres');
const plan = require('../deploy/multitenant/config');
const ipc = require('../lib/server/internal-api/transport');
const contracts = require('../lib/server/internal-api/contracts');
const manifest = require('../lib/server/serve/operation-cohort-manifest');
const cohorts = require('../lib/server/serve/operation-cohort');
const maintenance = require('../lib/tenant-lifecycle/maintenance-window');
const datastore = require('../lib/storage/postgres-datastore');
const scope = require('../lib/storage/tenant-scope');
const { optInSuite } = require('./support/opt-in');

const IMAGE = process.env.NS_API_ROSTER_PG_IMAGE || 'postgres@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97';
const { A, B } = plan;
const DIGEST = 'd'.repeat(64);
// participant id -> database identity of its one real backend
const PEERS = { 'api-1': 'api', 'api-2': 'api', realtime: 'realtime', evaluator: 'evaluator', 'tenant-admin': 'owner_writer' };
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

optInSuite(process.env.NS_API_ROSTER_DOCKER_TEST === '1',
  'NS_API_ROSTER_DOCKER_TEST=1')('two api replicas in the restore census (disposable PostgreSQL, deployment grants)', function () {
  this.timeout(120000);
  const container = 'ns-roster-' + crypto.randomBytes(6).toString('hex');
  const l = plan.layout('nsroster'), ns = l.namespaces, q = plan.quote;
  const t = (name, table) => q(ns[name]) + '.' + q(table);
  const urls = {}, backends = {}, peers = {}, calls = {};
  let previousMode, owned = false, bootstrapURI, socketDir, operatorPool, proxy, entries, datastoreRow, remote;

  async function asBootstrap (fn) {
    const client = new Client({ connectionString: bootstrapURI }); await client.connect();
    try { return await fn(client); } finally { await client.end(); }
  }
  const phaseOf = tenant => asBootstrap(async client => (await client.query('SELECT phase FROM ' + t('control', 'tenant_lifecycle_windows') + ' WHERE tenant_id=$1', [tenant])).rows[0].phase);

  // One synthetic lifecycle participant: its own incarnation, reporting its one real backend.
  async function startPeer (entry) {
    const incarnation = crypto.randomUUID(), backend = backends[entry.id];
    const status = request => ({ version: 1, participant: entry.id, incarnation, namespace: ns.control, roles: [...entry.roles],
      tenants: [A, B].sort(), namespaces: [...entry.namespaces], identity: { namespaceOid: 1 }, datastore: { ...datastoreRow }, backends: [backend], request });
    calls[entry.id] = { getStatus: 0, invalidateTenant: 0 };
    peers[entry.id] = await ipc.open(entry.endpoint, contracts.lifecycleParticipant, () => ({
      getStatus: async (ctx, body) => { calls[entry.id].getStatus++; return status(body.request); },
      invalidateTenant: async (ctx, body) => { calls[entry.id].invalidateTenant++; return { ...status(body.request), tenant: body.tenant }; }
    }));
  }
  async function restore (participants, body = async () => 'restored') {
    const cohort = await cohorts.createRemote({ namespace: ns.control, tenants: [A, B], participants });
    const controller = maintenance.create({ namespace: ns.control, locks: remote.locks, pool: operatorPool, cohort, drainTimeoutMs: 5000 });
    try { return await controller.withRestore(A, { artifactDigest: DIGEST }, body); }
    finally { await controller.close(); await cohort.close(); }
  }
  const roster = (change = rows => rows) => manifest.validate(change(entries.map(row => ({ ...row, endpoint: { ...row.endpoint } }))));

  before(async function () {
    previousMode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    socketDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ns-roster-ipc-'))); fs.chmodSync(socketDir, 0o700);
    const password = crypto.randomBytes(24).toString('hex');
    execFileSync('docker', ['run', '--name', container, '--label', 'nightscout.test=api-fixed-roster', '-d', '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_USER=bootstrap', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=nightscout_roster_test', IMAGE],
    { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
    owned = true;
    spawn('sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 2; done; docker rm -f -v "$2" >/dev/null 2>&1', 'reaper', String(process.pid), container],
      { detached: true, stdio: 'ignore' }).unref();
    const port = docker(['port', container, '5432/tcp']).split(':').pop();
    bootstrapURI = 'postgres://bootstrap:' + password + '@127.0.0.1:' + port + '/nightscout_roster_test';
    const deadline = Date.now() + 30000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'bootstrap']); await asBootstrap(async () => {}); ready = true; }
      catch { await sleep(200); }
    }
    assert.ok(ready, 'disposable PostgreSQL ready');
    await asBootstrap(async admin => {
      await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await admin.query('REVOKE CREATE ON DATABASE "nightscout_roster_test" FROM PUBLIC');
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
        for (const row of (await admin.query('SELECT p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1', [namespace])).rows) {
          await admin.query('ALTER FUNCTION ' + q(namespace) + '.' + q(row.proname) + '(' + row.args + ') OWNER TO ' + q(l.owner));
        }
        await admin.query('ALTER SCHEMA ' + q(namespace) + ' OWNER TO ' + q(l.owner));
      }
      for (const sql of plan.grants(l)) await admin.query(sql);
      remote = plan.documents({ layout: l, urls: { evaluator: bootstrapURI }, tokens: ['x', 'y'], publicKeys: [], managementKeys: [], vaultAddress: 'https://vault:8200' });
      for (const [i, tenant] of [A, B].entries()) {
        await admin.query('INSERT INTO ' + t('control', 'tenant_lifecycle_windows') + "(tenant_id,lock_key,phase,generation) VALUES($1,$2,'active',1)", [tenant, remote.locks[i].key]);
      }
      await admin.query('INSERT INTO ' + t('control', 'tenant_lifecycle_restore_authority') + '(tenant_id,role_oid,active) VALUES($1,$2::regrole::oid,true)', [A, l.roles.operator]);
    });
    // One real backend per participant, as its role's database identity (two as api).
    datastoreRow = {};
    for (const [participant, identity] of Object.entries(PEERS)) {
      const client = new Client({ connectionString: urls[identity] }); await client.connect();
      const row = (await client.query('SELECT pg_backend_pid() AS pid,current_user AS role,extract(epoch from backend_start)::text AS birth,' + datastore.SQL +
        ' FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];
      Object.assign(datastoreRow, datastore.identity(row));
      backends[participant] = { pid: row.pid, role: row.role, birth: row.birth, client };
    }
    for (const row of Object.values(backends)) { const { client } = row; delete row.client; Object.defineProperty(row, 'client', { value: client, enumerable: false }); }
    // The plan's roster with the api row replaced by two replicas, each on its own HTTP address.
    const apiRow = remote.remote.find(row => row.id === 'api');
    const free = () => new Promise(resolve => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const address = { 'api-1': 'http://127.0.0.1:' + await free() + '/', 'api-2': 'http://127.0.0.1:' + await free() + '/' };
    entries = manifest.validate([
      ...['api-1', 'api-2'].map(id => ({ id, roles: apiRow.roles, namespaces: apiRow.namespaces, endpoint: { url: address[id], trust: 'network', maxBytes: 1048576, timeoutMs: 5000 } })),
      ...remote.remote.filter(row => row.id !== 'api').map(row => ({ id: row.id, roles: row.roles, namespaces: row.namespaces,
        endpoint: { socketPath: path.join(socketDir, row.id + '.sock'), maxBytes: 1048576, timeoutMs: 5000 } }))]);
    for (const entry of entries) await startPeer(entry);
    // The api service destination: a round-robin TCP-level HTTP proxy over both replicas.
    let next = 0;
    proxy = http.createServer((req, res) => {
      const target = new URL(address[next++ % 2 === 0 ? 'api-1' : 'api-2']);
      const upstream = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers, agent: false },
        reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
      upstream.on('error', () => res.destroy()); req.pipe(upstream);
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    this.service = 'http://127.0.0.1:' + proxy.address().port + '/';
    operatorPool = new Pool({ connectionString: urls.operator, max: 1 });
  });

  after(async function () {
    try {
      for (const peer of Object.values(peers)) await peer.close();
      for (const row of Object.values(backends)) await row.client.end();
      if (proxy) await new Promise(resolve => proxy.close(resolve));
      if (operatorPool) await operatorPool.end();
    } finally {
      scope.setTenancyMode(previousMode);
      if (owned) docker(['rm', '-f', '-v', container]);
      if (socketDir) fs.rmSync(socketDir, { recursive: true, force: true });
    }
  });

  it('restores A with both api replicas on the roster: each is pinned, counted and invalidated on its own address', async function () {
    for (const id of ['api-1', 'api-2']) calls[id].invalidateTenant = 0;
    const result = await restore(roster());
    assert.deepEqual({ tenant: result.tenant, state: result.state, result: result.result }, { tenant: A, state: 'activated', result: 'restored' });
    assert.equal(calls['api-1'].invalidateTenant, 1, 'api-1 invalidated A');
    assert.equal(calls['api-2'].invalidateTenant, 1, 'api-2 invalidated A');
    assert.equal(await phaseOf(A), 'active');
  });

  it('refuses before suspending A when an api replica is left off the roster (its backend is unknown to the census)', async function () {
    let entered = false;
    await assert.rejects(restore(roster(rows => rows.filter(row => row.id !== 'api-2')), async () => { entered = true; }), { code: 'RESTORE_COHORT_UNKNOWN_BACKEND' });
    assert.equal(entered, false); assert.equal(await phaseOf(A), 'active');
  });

  it('refuses a roster entry that names the api service destination rather than one instance', async function () {
    let entered = false;
    const aliased = roster(rows => rows.map(row => row.id === 'api-2' ? { ...row, endpoint: { ...row.endpoint, url: this.service } } : row));
    await assert.rejects(restore(aliased, async () => { entered = true; }),
      error => ['RESTORE_COHORT_PROTOCOL', 'RESTORE_COHORT_PARTICIPANT_CHANGED'].includes(error.code));
    assert.equal(entered, false); assert.equal(await phaseOf(A), 'active');
  });

  it('refuses before suspending A while one api replica is stopped, and restores again once it is replaced', async function () {
    const old = entries.find(row => row.id === 'api-2');
    await peers['api-2'].close();
    let entered = false;
    await assert.rejects(restore(roster(), async () => { entered = true; }), /SOCKET_IPC_UNAVAILABLE/);
    assert.equal(entered, false); assert.equal(await phaseOf(A), 'active');
    // Replacement: a new incarnation on the same address joins the next operation.
    await startPeer(old);
    assert.equal((await restore(roster())).state, 'activated');
  });
});
