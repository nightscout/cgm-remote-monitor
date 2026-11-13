'use strict';

// Explicit private-plane demonstration, using the same controller and lifecycle
// as the selected application tree. It never provisions roles or reopens a
// tenant after a refused/uncertain restore. Artifacts include ciphertext.
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const fail = code => Object.assign(new Error(code), { code });
const validName = value => typeof value === 'string' && NAME.test(value) && value !== 'public' && value !== 'information_schema' && !value.startsWith('pg_');
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k)) && keys.every(k => Object.hasOwn(v, k));

function validateConfig (value, env = process.env) {
  if (!exact(value, ['version', 'tenants', 'apiOrigin', 'control', 'namespaces', 'catalogues', 'drainTimeoutMs']) || value.version !== 1 ||
      !Number.isSafeInteger(value.drainTimeoutMs) || value.drainTimeoutMs < 1 || value.drainTimeoutMs > 2147483647 ||
      !Array.isArray(value.tenants) || value.tenants.length !== 2 ||
      !value.tenants.every(t => exact(t, ['id', 'host', 'tokenEnv']) && UUID.test(t.id) && /^[a-z0-9.-]+$/.test(t.host) &&
        /^[A-Z][A-Z0-9_]*$/.test(t.tokenEnv) && typeof env[t.tokenEnv] === 'string' && env[t.tokenEnv].length > 0) ||
      new Set(value.tenants.map(t => t.id)).size !== 2 || new Set(value.tenants.map(t => t.host)).size !== 2 ||
      !exact(value.control, ['namespace', 'locks', 'participants']) || !validName(value.control.namespace) ||
      !Array.isArray(value.control.locks) || value.control.locks.length !== 2 ||
      !value.control.locks.every(row => exact(row, ['tenant', 'key']) && value.tenants.some(t => t.id === row.tenant) &&
        typeof row.key === 'string' && /^[1-9][0-9]{0,18}$/.test(row.key) && BigInt(row.key) <= 9223372036854775807n) ||
      new Set(value.control.locks.map(row => row.tenant)).size !== 2 || new Set(value.control.locks.map(row => row.key)).size !== 2 ||
      !Array.isArray(value.control.participants) || !value.control.participants.length ||
      !value.namespaces || typeof value.namespaces !== 'object' || Array.isArray(value.namespaces) ||
      !Object.entries(value.namespaces).every(([key, namespace]) => validName(key) && validName(namespace)) ||
      new Set(Object.values(value.namespaces)).size !== Object.keys(value.namespaces).length ||
      !Array.isArray(value.catalogues) || !value.catalogues.length ||
      !value.catalogues.every(row => validName(row.kind) && Object.hasOwn(value.namespaces, row.kind)) ||
      new Set(value.catalogues.map(row => row.kind)).size !== value.catalogues.length ||
      typeof env.NS_OPERATOR_PG !== 'string' || !env.NS_OPERATOR_PG || !/^[0-9a-f]{40}$/.test(env.NS_SOURCE_COMMIT || '')) {
    throw fail('COMPOSE_OPERATOR_CONFIG_REFUSED');
  }
  let origin, pg;
  try { origin = new URL(value.apiOrigin); pg = new URL(env.NS_OPERATOR_PG); } catch { throw fail('COMPOSE_OPERATOR_CONFIG_REFUSED'); }
  // The demo uses the Compose private service, not a user-provided public site.
  if (origin.origin !== value.apiOrigin || origin.hostname !== 'api' || origin.protocol !== 'http:' || origin.username || origin.password ||
      !['postgres:', 'postgresql:'].includes(pg.protocol) || !pg.username || !pg.password || !pg.pathname.slice(1) || pg.hash ||
      [...pg.searchParams.keys()].some(k => k !== 'sslmode')) throw fail('COMPOSE_OPERATOR_CONFIG_REFUSED');
  return structuredClone(value);
}

function loadConfig (file = process.env.NS_OPERATOR_CONFIG || '/run/ns-config/config.json', env = process.env) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024 || (stat.mode & 0o077)) throw fail('COMPOSE_OPERATOR_CONFIG_PERMISSIONS');
  return validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')), env);
}

function expectedCandidates () {
  const domains = require('../../lib/server/serve/postgres-domains');
  const successors = require('../../lib/server/tenant-socket-order-port').catalogues;
  return {
    ...Object.fromEntries(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'settings'].map(kind => [kind, successors[kind] || domains.get(kind).catalogue])),
    authorization: require('../../lib/tenant-authorization/postgres-candidate.json'),
    secrets: require('../../lib/secrets/postgres-candidate.json'),
    legacy: require('../../lib/secrets/legacy-credentials-candidate.json'),
    access: require('../../lib/tenant-authorization/access-candidate.json'),
    clock: require('../../migrations/candidates/postgres-write-clock-v1.json'),
    checkpoint: require('../../migrations/candidates/postgres-consumer-checkpoint-v1.json'),
    evaluator_checkpoint: require('../../migrations/candidates/postgres-consumer-checkpoint-v1.json'),
    alarm_suppression: require('../../migrations/candidates/postgres-alarm-suppression-v1.json'),
    notification_outbox: require('../../lib/tenant-notifications/postgres-candidate.json')
  };
}

function lifecycleFor (config) {
  const expected = expectedCandidates();
  if (!isDeepStrictEqual(Object.keys(expected).sort(), config.catalogues.map(row => row.kind).sort()) ||
      config.catalogues.some(row => !isDeepStrictEqual(row.candidate, expected[row.kind]))) throw fail('COMPOSE_OPERATOR_CATALOGUE_REFUSED');
  require('../../lib/storage/tenant-scope').setTenancyMode('multi');
  return require('../../lib/tenant-lifecycle').createLifecycle({ catalogues: config.catalogues });
}

function tenantFor (config, tenant) {
  if (!config.tenants.some(t => t.id === tenant)) throw fail('COMPOSE_OPERATOR_TENANT_REFUSED');
  return tenant;
}

async function capture (config, tenant, env = process.env) {
  tenantFor(config, tenant);
  const lifecycle = lifecycleFor(config);
  const connection = await require('../../lib/storage/postgres-connection')({ connectionString: env.NS_OPERATOR_PG, max: 1,
    connectionTimeoutMillis: 5000, statement_timeout: 10000, options: '-c search_path=pg_catalog' });
  try { return await lifecycle.exportTenant(connection, { tenant, namespaces: config.namespaces, sourceCommit: env.NS_SOURCE_COMMIT }); }
  finally { await connection.end(); }
}

async function ready (config) {
  const cohort = await require('../../lib/server/serve/operation-cohort').createRemote({namespace: config.control.namespace,
    tenants: config.tenants.map(t => t.id), participants: config.control.participants});
  await cohort.close();
}

async function restore (config, artifact, env = process.env, hooks = {}) {
  const tenant = tenantFor(config, artifact?.manifest?.tenant);
  const lifecycle = lifecycleFor(config);
  // createRemote reads actual participants. Missing peers fail before suspension.
  const cohort = await require('../../lib/server/serve/operation-cohort').createRemote({ namespace: config.control.namespace,
    tenants: config.tenants.map(t => t.id), participants: config.control.participants });
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: env.NS_OPERATOR_PG, max: 1, connectionTimeoutMillis: 5000,
    statement_timeout: 10000, options: '-c search_path=pg_catalog' });
  try {
    const controller = require('../../lib/tenant-lifecycle/maintenance-window').create({ namespace: config.control.namespace,
      locks: config.control.locks, pool, cohort, drainTimeoutMs: config.drainTimeoutMs });
    let committed = false;
    const result = await controller.withRestore(tenant, { artifactDigest: artifact.digest }, async ({ connection, maintenanceClaim }) => {
      // The lifecycle control namespace holds the key-retention ledger (BF-230).
      return lifecycle.restoreLogical(connection, artifact, { tenant, namespaces: config.namespaces, ledgerNamespace: config.control.namespace, maintenanceClaim,
        ...(hooks.onRow ? { onRow: hooks.onRow } : {}), onCommitted: async summary => { committed = true; if (hooks.onCommitted) await hooks.onCommitted(summary); } });
    });
    if (!committed) throw fail('COMPOSE_RESTORE_COMMIT_NOT_OBSERVED');
    return result;
  } finally { try { await cohort.close(); } finally { await pool.end(); } }
}

function argumentsFor (args) {
  const command = args.shift();
  if (!['export', 'restore'].includes(command)) throw fail('COMPOSE_OPERATOR_USAGE');
  const options = {};
  while (args.length) {
    const name = args.shift(), value = args.shift();
    if (!['--tenant', '--directory', '--digest'].includes(name) || !value || Object.hasOwn(options, name)) throw fail('COMPOSE_OPERATOR_USAGE');
    options[name] = value;
  }
  if (!UUID.test(options['--tenant'] || '') || !path.isAbsolute(options['--directory'] || '') ||
      (command === 'restore' && !/^[a-f0-9]{64}$/.test(options['--digest'] || '')) ||
      (command === 'export' && options['--digest'])) throw fail('COMPOSE_OPERATOR_USAGE');
  return { command, tenant: options['--tenant'], directory: options['--directory'], digest: options['--digest'] };
}

async function main (args = process.argv.slice(2)) {
  const options = argumentsFor(args), config = loadConfig(), artifacts = require('../../lib/tenant-lifecycle/filesystem-artifact');
  tenantFor(config, options.tenant);
  if (options.command === 'export') {
    const artifact = await capture(config, options.tenant);
    await artifacts.saveTenantArtifact(artifact, { directory: options.directory });
    return { operation: 'export', tenant: options.tenant, digest: artifact.digest };
  }
  const artifact = await artifacts.loadTenantArtifact({ directory: options.directory, digest: options.digest });
  if (artifact.manifest.tenant !== options.tenant) throw fail('COMPOSE_OPERATOR_TENANT_REFUSED');
  await restore(config, artifact);
  return { operation: 'restore', tenant: options.tenant, digest: artifact.digest, state: 'restored-and-active' };
}

if (require.main === module) main().then(result => process.stdout.write(JSON.stringify(result) + '\n'), error => {
  // Never print inherited HTTP/PG errors, connection strings or artifact content.
  process.stderr.write(JSON.stringify({ error: /^[A-Z][A-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'COMPOSE_OPERATOR_FAILED',
    recovery: 'Inspect persisted operation state. Do not automatically replay or reopen the tenant.' }) + '\n');
  process.exitCode = 1;
});
module.exports = { validateConfig, loadConfig, lifecycleFor, tenantFor, ready, capture, restore, argumentsFor, main };
