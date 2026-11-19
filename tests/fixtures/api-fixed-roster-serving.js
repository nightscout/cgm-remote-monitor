'use strict';

// Two API CLI replicas with shared durable write clock and generation-fenced restore.
const assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { Client, Pool } = require('pg');
const scope = require('../../lib/storage/tenant-scope');
const { run } = require('../../lib/migrations/postgres');
const manifests = require('../../lib/server/serve/operation-cohort-manifest');
const maintenance = require('../../lib/tenant-lifecycle/maintenance-window');
const namespace = 'preview_control', q = name => '"' + name + '"';
const freePort = () => new Promise(resolve => { const s = http.createServer().listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
module.exports = function create ({ environment = {}, leaseSessions, drainTimeoutMs = 10000 } = {}) {
  const base = require('./multitenant-preview-replicas')({ writeClock: true, namespaceNames: { control: 'preview_control', registry: 'preview_registry' } }), current = new Map(), environments = new Map(), calls = new Map();
  const controlledClock = String(Date.now());
  const locks = base.tenants.map(tenant => ({ tenant, key: require('../../lib/tenant-registry/rules').lockKey(tenant) }));
  let port, publicProxy, privateProxy, participants, operatorPool, controller, resume, lifetimeURI, config, previousMode, proofWriter;
  const url = host => 'http://' + host + ':' + port + '/';
  const endpoint = host => ({ url: url(host), trust: 'network', maxBytes: 1048576, timeoutMs: 5000 });
  async function withAdmin (fn) {
    const client = new Client({ connectionString: base.adminConnectionString }); await client.connect();
    try { return await fn(client); } finally { await client.end(); }
  }
  function serviceProxy (privateRoute) {
    let next = 0;
    return http.createServer((req, res) => {
      const id = next++ % 2 ? 'api-2' : 'api-1', worker = current.get(id);
      calls.set(id, (calls.get(id) || 0) + 1);
      if (!worker) { res.writeHead(503); res.end(); return; }
      const target = privateRoute ? new URL(url(id === 'api-1' ? '127.0.0.2' : '127.0.0.3')) : { hostname: '127.0.0.1', port: worker.port };
      const upstream = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers, agent: false },
        reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
      upstream.on('error', () => res.destroy()); req.pipe(upstream);
    });
  }
  async function start (id, { readinessTenant } = {}) {
    const file = path.join(base.directory, id + '-operation.json');
    const rows = participants.map(peer => ({ id: peer.id, roles: [...peer.roles], namespaces: [...peer.namespaces],
      maxMessageBytes: peer.endpoint.maxBytes, timeoutMs: peer.endpoint.timeoutMs, ...(peer.roles.includes('api') ? { address: { url: peer.endpoint.url } } : {}) }));
    fs.writeFileSync(file, JSON.stringify({ version: 2, namespace, connectionEnv: 'NS_ROSTER_LIFETIME_PG', registry: { namespace: base.provisioned.namespaces.registry }, participantId: id, participants: rows, ...(leaseSessions === undefined ? {} : { leaseSessions }) }), { mode: 0o600 });
    const extra = { NS_ROSTER_LIFETIME_PG: lifetimeURI, MULTITENANT_OPERATION_CONFIG: file,
      NS_SERVE_INTERNAL_HOST: id === 'api-1' ? '127.0.0.2' : '127.0.0.3', NS_SERVE_INTERNAL_PORT: String(port), NS_API_INTERNAL_URL: url('127.0.0.4'),
      NS_EVALUATOR_INTERNAL_URL: url('127.0.0.5'), NS_REALTIME_INTERNAL_URL: url('127.0.0.6'), NS_TENANT_ADMIN_INTERNAL_URL: url('127.0.0.7'),
      NODE_OPTIONS: '--require ' + path.join(__dirname, 'api-fixed-roster-controls.js'),
      NS_API_ROSTER_CONTROL_DIR: base.directory, NS_API_ROSTER_ID: id,
      NS_PREVIEW_REPLICA_CONTROL: 'history-clock', NS_PREVIEW_REPLICA_CLOCK_MS: controlledClock, NS_POOL_OPERATION_MAX: '2', NS_POOL_API_MAX: '2', ...environment };
    if (id === 'api-1' && !environments.has(id)) {
      const roleFile = path.join(base.directory, 'api-prestart.json');
      fs.writeFileSync(roleFile, JSON.stringify(config), { mode: 0o600 });
      const verifier = require('../../lib/server/serve/platform-verification-admin').create({
        namespace: config.platformVerification.namespace, connectionString: proofWriter,
        targets: [{ role: 'api', configFile: roleFile, operationConfigFile: file }]
      }, base.environment(extra));
      try { await verifier.verify(); await verifier.backfillTenantFloorsV1(); } catch (error) {
        throw new Error('Roster API pre-start refused: ' + JSON.stringify(error.verificationDiagnostic), { cause: error });
      } finally { await verifier.close(); }
    }
    environments.set(id, extra);
    const worker = base.start(config, extra);
    await base.ready(worker, readinessTenant); current.set(id, worker); return worker;
  }
  async function setup () {
    await base.setup(); config = base.configuration(); previousMode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    await run('up', { direct: true, connectionString: base.adminConnectionString, namespace, catalogue: require('../../lib/tenant-lifecycle/postgres-candidate.json') });
    const admin = base.admin;
    await admin.query('CREATE ROLE preview_control_owner NOLOGIN NOSUPERUSER NOBYPASSRLS');
    for (const table of (await admin.query('SELECT tablename FROM pg_tables WHERE schemaname=$1', [namespace])).rows) await admin.query('ALTER TABLE ' + q(namespace) + '.' + q(table.tablename) + ' OWNER TO preview_control_owner');
    await admin.query('ALTER FUNCTION preview_control.tenant_lifecycle_backend_birth() OWNER TO preview_control_owner');
    await admin.query('ALTER SCHEMA preview_control OWNER TO preview_control_owner');
    const roleURI = async role => {
      const password = crypto.randomBytes(24).toString('hex');
      await admin.query('CREATE ROLE ' + q(role) + " LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '" + password + "'");
      const selected = new URL(base.adminConnectionString); selected.username = role; selected.password = password; return selected.toString();
    };
    lifetimeURI = await roleURI('preview_lifetime_api');
    const operatorURI = await roleURI('preview_restore_operator');
    proofWriter = await roleURI('preview_roster_verifier');
    config.platformVerification = { namespace: 'preview_roster_proof', role: 'api' };
    await require('../../lib/server/serve/platform-verification').install(admin, { namespace: config.platformVerification.namespace,
      writer: 'preview_roster_verifier', floorReaders: ['preview_app'], readers: ['preview_app','preview_check'] });
    for (const sql of base.provisioned.registryGrants({ enumerators: ['preview_roster_verifier'] })) await admin.query(sql);
    for (const role of ['preview_app', 'preview_check', 'preview_settings', 'preview_lifetime_api']) {
      await admin.query('GRANT USAGE ON SCHEMA preview_control TO ' + q(role));
      await admin.query('GRANT SELECT ON preview_control.schema_migrations,preview_control.tenant_lifecycle_windows,preview_control.tenant_lifecycle_operations TO ' + q(role));
    }
    await admin.query('GRANT INSERT(tenant_id,operation_id,generation),UPDATE(finished) ON preview_control.tenant_lifecycle_operations TO preview_lifetime_api');
    await admin.query('GRANT EXECUTE ON FUNCTION preview_control.tenant_lifecycle_backend_birth() TO preview_lifetime_api');
    // Registry provisioning adds a settings CHECK validator. It is not an
    // operation-lifetime capability: PostgreSQL's default PUBLIC EXECUTE must
    // not leak that unrelated function to the deliberately narrow lease role.
    const settingsValidator = '"' + base.provisioned.namespaces.settings + '".tenant_settings_values_valid(jsonb)';
    await admin.query('REVOKE EXECUTE ON FUNCTION ' + settingsValidator + ' FROM PUBLIC');
    assert.equal((await admin.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS executes",
      ['preview_lifetime_api', settingsValidator])).rows[0].executes, false);
    for (const sql of maintenance.operatorGrants({ namespace, role: 'preview_restore_operator' })) await admin.query(sql);
    await admin.query('GRANT pg_read_all_stats TO preview_restore_operator');
    for (const lock of locks) {
      const existing = (await admin.query('SELECT lock_key::text AS key FROM preview_control.tenant_lifecycle_windows WHERE tenant_id=$1', [lock.tenant])).rows;
      assert.equal(existing.length, 1, 'actual provisioning created the window');
      assert.equal(existing[0].key, lock.key, 'registry lock rule matches actual provisioned window');
      await admin.query("INSERT INTO preview_control.tenant_lifecycle_restore_authority VALUES($1,'preview_restore_operator'::regrole::oid,true)", [lock.tenant]);
    }
    port = await freePort();
    const protectedNames = require('../../lib/server/serve/role-topology').protectedNamespaces(config).filter(name => name !== namespace).sort();
    participants = manifests.validate([
      ...['api-1', 'api-2'].map((id, i) => ({ id, roles: ['api'], namespaces: protectedNames, endpoint: endpoint('127.0.0.' + (i + 2)) })),
      ...['evaluator', 'realtime', 'tenant-admin'].map((role, i) => ({ id: role, roles: [role], namespaces: protectedNames, endpoint: endpoint('127.0.0.' + (i + 5)) }))]);
    await base.provisioned.release();
    await start('api-1'); await start('api-2');
    privateProxy = serviceProxy(true); await new Promise(resolve => privateProxy.listen(port, '127.0.0.4', resolve));
    publicProxy = serviceProxy(false); await new Promise(resolve => publicProxy.listen(0, '127.0.0.1', resolve));
    operatorPool = new Pool({ connectionString: operatorURI, max: 1 });
    controller = maintenance.create({ namespace, locks, pool: operatorPool, drainTimeoutMs });
    resume = require('../../lib/tenant-lifecycle/restore-resume').create({ namespace, locks, pool: operatorPool });
  }
  async function cleanup () {
    for (const worker of current.values()) if (!worker.exit) worker.child.kill('SIGUSR2');
    if (controller) await controller.close(); if (resume) await resume.close();
    for (const proxy of [privateProxy, publicProxy].filter(Boolean)) await new Promise(resolve => proxy.close(resolve));
    if (operatorPool) await operatorPool.end(); await base.cleanup(); if (previousMode) scope.setTenancyMode(previousMode);
  }
  return { setup, cleanup, start, withAdmin, base, current, calls, locks, namespace,
    refusedWithoutClock: async id => {
      const disabled = { ...config, postgres: { ...config.postgres, namespaces: { ...config.postgres.namespaces } } };
      delete disabled.writeClock; delete disabled.postgres.namespaces.clock;
      return base.refused(disabled, environments.get(id));
    },
    get lifetimeConnectionString () { return lifetimeURI; }, get participants () { return participants; }, get operatorPool () { return operatorPool; },
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
