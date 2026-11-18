'use strict';

// Fresh, synthetic two-tenant PostgreSQL fixture; source of grants/migrations is
// multitenant-plan and the existing operation-window-epoch native fixture.
// This module does no I/O until start() is explicitly called by its opt-in suite.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFileSync, spawn } = require('node:child_process');
const { Pool } = require('pg');
const { run } = require('../../lib/migrations/postgres');
const plan = require('./multitenant-plan');
const windows = require('../../lib/tenant-lifecycle/operation-window');
const connect = require('../../lib/storage/postgres-connection');
const scope = require('../../lib/storage/tenant-scope');
const counterFactory = require('./operation-window-sql-counter');
const IMAGE = process.env.NS_OPERATION_WINDOW_PG_IMAGE || 'postgres@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97';
const { A, B } = plan;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// receiptPrefix keeps receipts of different suites that share this fixture
// distinct inside one NS_OPERATION_WINDOW_RECEIPT_DIRECTORY (exclusive create).
function create ({ receiptPrefix = '' } = {}) {
  if (!/^[a-z0-9-]{0,32}$/.test(receiptPrefix)) throw new TypeError('Receipt prefix must be a short lowercase name');
  const counter = counterFactory.create(), Client = counter.Client;
  const container = 'ns-window-minimum-' + crypto.randomBytes(6).toString('hex');
  const l = plan.layout('nswmin'), ns = l.namespaces, q = plan.quote;
  const control = name => q(ns.control) + '.' + q(name);
  const locks = [{ tenant: A, key: '830001' }, { tenant: B, key: '830002' }], urls = {};
  let previousMode, owned = false, containerID, bootstrapURI, lifetimePool, window, lower, releaseWindow;
  async function asBootstrap (fn) {
    const client = new Client({ connectionString: bootstrapURI }); await client.connect();
    try { return await fn(client); } finally { await client.end(); }
  }
  async function prestart() {
    const platform = require('../../lib/server/serve/platform-verification-lifecycle');
    const inspection = await platform.inspect({namespace:ns.control,poolOptions:{connectionString:urls.lifetime_api}}, counter.Client);
    await platform.withClient({connectionString:urls.api}, inspection.controlReads, counter.Client);
  }
  async function start () {
    assert.match(IMAGE, /^postgres@sha256:[a-f0-9]{64}$/, 'digest-pinned disposable image');
    previousMode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    console.log('MINIMUM_NATIVE_START ' + JSON.stringify({ pid: process.pid, container, image: IMAGE, boundSeconds: 180, tmpfs: true }));
    const password = crypto.randomBytes(24).toString('hex');
    containerID = execFileSync('docker', ['run', '--pull', 'never', '--tmpfs', '/var/lib/postgresql/data:rw,size=768m', '--name', container, '--label', 'nightscout.test=operation-window-minimum', '-d', '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_USER=bootstrap', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=nightscout_minimum_test', IMAGE],
    { env: { ...process.env, POSTGRES_PASSWORD: password }, timeout: 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    assert.match(containerID, /^[a-f0-9]{64}$/);
    owned = true;
    spawn('sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 2; done; docker rm -f -v "$2" >/dev/null 2>&1', 'reaper', String(process.pid), containerID],
      { detached: true, stdio: 'ignore' }).unref();
    if (process.env.NS_OPERATION_WINDOW_RECEIPT_DIRECTORY) fs.writeFileSync(process.env.NS_OPERATION_WINDOW_RECEIPT_DIRECTORY + '/' + receiptPrefix + 'custody.json', JSON.stringify({ pid: process.pid, container, containerID, image: IMAGE, boundSeconds: 180, tmpfs: true }), { flag: 'wx', mode: 0o600 });
    const port = docker(['port', container, '5432/tcp']).split(':').pop();
    bootstrapURI = 'postgres://bootstrap:' + password + '@127.0.0.1:' + port + '/nightscout_minimum_test';
    const deadline = Date.now() + 30000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'bootstrap']); await asBootstrap(async () => {}); ready = true; }
      catch { await sleep(200); }
    }
    assert.ok(ready, 'disposable PostgreSQL ready');
    await asBootstrap(async admin => {
      await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await admin.query('REVOKE CREATE ON DATABASE "nightscout_minimum_test" FROM PUBLIC');
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
      for (const statement of plan.grants(l)) await admin.query(statement);
      const streamRole = 'nswmin_stream', secret = crypto.randomBytes(24).toString('hex');
      await admin.query('CREATE ROLE ' + q(streamRole) + " LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE REPLICATION NOINHERIT CONNECTION LIMIT 4 PASSWORD '" + secret + "'");
      await admin.query('CREATE SCHEMA pgstream AUTHORIZATION ' + q(l.owner));
      await admin.query('REVOKE ALL ON SCHEMA pgstream FROM PUBLIC');
      await admin.query('GRANT USAGE,CREATE ON SCHEMA pgstream TO ' + q(streamRole));
      const streamURL = new URL(bootstrapURI); streamURL.username = streamRole; streamURL.password = secret; urls.stream = streamURL.toString();
      for (const row of locks) await admin.query('INSERT INTO ' + control('tenant_lifecycle_windows') + "(tenant_id,lock_key,phase,generation) VALUES($1,$2,'active',1)", [row.tenant, row.key]);
    });
    lifetimePool = new Pool({ connectionString: urls.lifetime_api, max: 1, Client: counter.Client, options: '-c search_path=pg_catalog' });
    await prestart();
    window = windows.create({ namespace: ns.control, locks, pool: lifetimePool });
    await window.ready();
    releaseWindow = connect.installOperationWindow(window);
    lower = await connect({ connectionString: urls.api, operationWindow: window, max: 1, Client: counter.Client });
  }
  async function close () {
    try {
      if (lower) await lower.end();
      if (releaseWindow) releaseWindow();
      if (window) await window.close();
      if (lifetimePool) await lifetimePool.end();
    } finally {
      if (previousMode !== undefined) scope.setTenancyMode(previousMode);
      if (owned) {
        assert.equal(docker(['inspect', '--format', '{{.Name}}', containerID]), '/' + container);
        docker(['rm', '-f', '-v', containerID]); owned = false;
        const absent = require('node:child_process').spawnSync('docker', ['inspect', containerID], { stdio: 'ignore', timeout: 10000 }).status !== 0;
        assert.equal(absent, true);
        if (process.env.NS_OPERATION_WINDOW_RECEIPT_DIRECTORY) fs.writeFileSync(process.env.NS_OPERATION_WINDOW_RECEIPT_DIRECTORY + '/' + receiptPrefix + 'cleanup.json', JSON.stringify({ pid: process.pid, container, containerID, absent, tmpfs: true }), { flag: 'wx', mode: 0o600 });
      }
    }
  }
  return { start: () => counter.phase('setup-admission', start), close, prestart, counter, A, B, l, ns, q, control, locks, urls,
    admin: fn => counter.phase('admin-control', () => asBootstrap(fn)),
    sql: (text, values) => counter.phase('admin-control', () => asBootstrap(c => c.query(text, values))),
    get window () { return window; }, get lower () { return lower; },
    operation: (tenant, fn = () => lower.query('SELECT 1 AS x')) => window.run(tenant, () => lower.withTenant(tenant, fn)),
    freshPool: kind => new Pool({ connectionString: urls[kind], max: 1, Client, options: '-c search_path=pg_catalog' }),
    openLower: () => connect({ connectionString: urls.api, operationWindow: window, max: 1, Client }) };
}
module.exports = { create };
