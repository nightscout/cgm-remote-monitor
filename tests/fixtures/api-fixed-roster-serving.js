'use strict';

// Two API CLI replicas with shared durable write clock and generation-fenced restore.
const assert = require('node:assert/strict');
const path = require('node:path'), http = require('node:http');
const { Client, Pool } = require('pg');
const scope = require('../../lib/storage/tenant-scope');
const maintenance = require('../../lib/tenant-lifecycle/maintenance-window');
const namespace = 'preview_control';
module.exports = function create ({ environment = {}, drainTimeoutMs = 10000 } = {}) {
  const base = require('./multitenant-preview-replicas')(), current = new Map(), environments = new Map(), calls = new Map();
  const controlledClock = String(Date.now());
  const locks = base.tenants.map(tenant => ({ tenant, key: require('../../lib/tenant-registry/rules').lockKey(tenant) }));
  let publicProxy, operatorPool, controller, resume, lifetimeURI, config, previousMode;
  async function withAdmin (fn) {
    const client = new Client({ connectionString: base.adminConnectionString }); await client.connect();
    try { return await fn(client); } finally { await client.end(); }
  }
  function serviceProxy () {
    let next = 0;
    return http.createServer((req, res) => {
      const id = next++ % 2 ? 'api-2' : 'api-1', worker = current.get(id);
      calls.set(id, (calls.get(id) || 0) + 1);
      if (!worker) { res.writeHead(503); res.end(); return; }
      const upstream = http.request({ hostname: '127.0.0.1', port: worker.port, path: req.url, method: req.method, headers: req.headers, agent: false },
        reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
      upstream.on('error', () => res.destroy()); req.pipe(upstream);
    });
  }
  async function start (id, { readinessTenant } = {}) {
    const extra = { NS_LIFETIME_PG: lifetimeURI,
      NODE_OPTIONS: '--require ' + path.join(__dirname, 'api-fixed-roster-controls.js'),
      NS_API_ROSTER_CONTROL_DIR: base.directory, NS_API_ROSTER_ID: id,
      NS_PREVIEW_REPLICA_CONTROL: 'history-clock', NS_PREVIEW_REPLICA_CLOCK_MS: controlledClock, NS_POOL_OPERATION_MAX: '2', NS_POOL_API_MAX: '2', ...environment };
    environments.set(id, extra);
    const worker = base.start(config, extra);
    await base.ready(worker, readinessTenant); current.set(id, worker); return worker;
  }
  async function setup () {
    await base.setup(); config = base.configuration(); previousMode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    const admin = base.admin;
    lifetimeURI = base.platform.urls.lifetime_api;
    const operatorURI = base.platform.urls.operator;
    for (const lock of locks) {
      const existing = (await admin.query('SELECT lock_key::text AS key FROM preview_control.tenant_lifecycle_windows WHERE tenant_id=$1', [lock.tenant])).rows;
      assert.equal(existing.length, 1, 'actual provisioning created the window');
      assert.equal(existing[0].key, lock.key, 'registry lock rule matches actual provisioned window');
      await admin.query("INSERT INTO preview_control.tenant_lifecycle_restore_authority VALUES($1,$2::regrole::oid,true)", [lock.tenant, base.platform.roles.operator]);
    }
    await start('api-1'); await start('api-2');
    publicProxy = serviceProxy(); await new Promise(resolve => publicProxy.listen(0, '127.0.0.1', resolve));
    operatorPool = new Pool({ connectionString: operatorURI, max: 1 });
    controller = maintenance.create({ namespace, locks, nativeSelection: base.platform.layout.native, pool: operatorPool, drainTimeoutMs });
    resume = require('../../lib/tenant-lifecycle/restore-resume').create({ namespace, locks, nativeSelection: base.platform.layout.native, pool: operatorPool });
  }
  async function cleanup () {
    for (const worker of current.values()) if (!worker.exit) worker.child.kill('SIGUSR2');
    if (controller) await controller.close(); if (resume) await resume.close();
    if (publicProxy) await new Promise(resolve => publicProxy.close(resolve));
    if (operatorPool) await operatorPool.end(); await base.cleanup(); if (previousMode) scope.setTenancyMode(previousMode);
  }
  return { setup, cleanup, start, withAdmin, base, current, calls, locks, namespace,
    async refusedWithoutClock (id) {
      const role = base.platform.roles.readiness;
      await base.admin.query('REVOKE SELECT ON preview_clock.schema_migrations FROM "' + role + '"');
      try { return await base.refused(config, environments.get(id)); }
      finally { await base.admin.query('GRANT SELECT ON preview_clock.schema_migrations TO "' + role + '"'); }
    },
    get lifetimeConnectionString () { return lifetimeURI; }, get operatorPool () { return operatorPool; },
    get serviceWorker () { return { port: publicProxy.address().port }; },
    restoreState: (tenant = base.tenants[0]) => withAdmin(async client => (await client.query(
      'SELECT phase,generation::text,claim_id,artifact_digest,' +
      '(SELECT count(*)::int FROM preview_control.tenant_lifecycle_restore_audit WHERE tenant_id=$1) AS audits,' +
      '(SELECT count(*)::int FROM preview_control.tenant_lifecycle_operations WHERE tenant_id=$1 AND finished=false) AS unfinished ' +
      'FROM preview_control.tenant_lifecycle_windows WHERE tenant_id=$1', [tenant])).rows[0]),
    unfinishedOperations: (tenant = base.tenants[0]) => withAdmin(async client => (await client.query(
      'SELECT operation_id FROM preview_control.tenant_lifecycle_operations WHERE tenant_id=$1 AND NOT finished ORDER BY operation_id', [tenant])).rows.map(row => row.operation_id)),
    restore: body => controller.withRestore(base.tenants[0], { artifactDigest: 'd'.repeat(64) }, body),
    resume: claimId => resume.resume(base.tenants[0], { claimId }),
    mark: (name, id) => path.join(base.directory, name + '-' + id) };
};
