'use strict';

// Registry-owned same-ID recommission/removal ports. Host configuration comes
// from the current declared operator configuration, never the tenant artifact.
const rules = require('./rules');
const lifecycle = require('../tenant-lifecycle/pool-authority');
const maintenance = require('../tenant-lifecycle/maintenance-window');
const { refuse } = require('../tenant-lifecycle/artifact');
const q = (namespace, table) => '"' + namespace + '"."' + table + '"';
function namespaceOf (value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value) || value === 'public' || value.startsWith('pg_') || value === 'information_schema') throw new TypeError('Explicit recommission registry namespace required');
  return value;
}
function create ({ namespace, controlNamespace }) {
  namespaceOf(namespace); namespaceOf(controlNamespace);
  if (namespace === controlNamespace) throw new TypeError('Separate registry and lifecycle namespaces required');
  return Object.freeze({ async register (connection, { tenant, maintenanceClaim, artifactDigest, configuration }) {
    rules.tenant(tenant);
    const claim = { connection, tenant, artifactDigest };
    await maintenance.assertHeld(maintenanceClaim, claim);
    if (!configuration || !Array.isArray(configuration.hosts)) throw refuse('LIFECYCLE_RECOMMISSION_CURRENT_HOSTS_REQUIRED');
    const spec = require('./provision').parseSpec({ id: tenant, hosts: configuration.hosts,
      ...(configuration.internalHost ? { internalHost: configuration.internalHost } : {}) }, { mode: configuration.mode || 'direct-alias' });
    const current = (await connection.query('SELECT /* recommission-current-registry */ tenant_id::text AS tenant,state,signing_version FROM ' + q(namespace, 'tenant_registry') + ' WHERE tenant_id=$1 FOR UPDATE', [tenant])).rows;
    if (current.length !== 1 || current[0].tenant !== tenant || !['active', 'removed'].includes(current[0].state)) throw refuse('LIFECYCLE_RECOMMISSION_REGISTRY_REQUIRED');
    const wanted = [...spec.aliases.map(host => ({ host, kind: 'alias' })), ...(spec.internal ? [{ host: spec.internal, kind: 'internal' }] : [])].sort((a, b) => a.host.localeCompare(b.host));
    const existing = (await connection.query('SELECT host,kind FROM ' + q(namespace, 'tenant_registry_hosts') + ' WHERE tenant_id=$1 ORDER BY host', [tenant])).rows;
    if (existing.length && JSON.stringify(existing.map(row => ({ host: row.host, kind: row.kind }))) !== JSON.stringify(wanted)) throw refuse('LIFECYCLE_RECOMMISSION_CURRENT_HOSTS_CONFLICT');
    if (!existing.length) for (const row of wanted) {
      const inserted = await connection.query('INSERT INTO ' + q(namespace, 'tenant_registry_hosts') + ' (host,tenant_id,kind) VALUES ($1,$2,$3)', [row.host, tenant, row.kind]);
      if (inserted.rowCount !== 1) throw refuse('LIFECYCLE_RECOMMISSION_REGISTRY_CHANGED');
    }
    if (current[0].state === 'removed') {
      const restored = await connection.query('UPDATE ' + q(namespace, 'tenant_registry') + " SET state='active',updated_at=clock_timestamp() WHERE tenant_id=$1 AND state='removed'", [tenant]);
      if (restored.rowCount !== 1) throw refuse('LIFECYCLE_RECOMMISSION_REGISTRY_CHANGED');
    }
    const keys = (await connection.query('SELECT tenant_id::text AS tenant,purpose,kid,public_key FROM ' + q(namespace, 'tenant_registry_keys') + ' WHERE tenant_id=$1 ORDER BY purpose,kid', [tenant])).rows;
    if (!keys.length || keys.some(row => row.tenant !== tenant)) throw refuse('LIFECYCLE_RECOMMISSION_REGISTRY_KEYS_REQUIRED');
    await maintenance.assertHeld(maintenanceClaim, claim);
    return Object.freeze({ signingVersion: current[0].signing_version, keys: Object.freeze(keys.map(row => Object.freeze({ ...row }))) });
  } });
}
async function removalAdmission (query, { namespace, tenant }) {
  namespaceOf(namespace); rules.tenant(tenant);
  const rows = (await query('SELECT /* removal-current-lifetime */ lock_key::text AS key,phase,claim_id FROM ' + q(namespace, 'tenant_lifecycle_windows') + ' WHERE tenant_id=$1', [tenant])).rows;
  if (rows.length !== 1 || rows[0].key !== rules.lockKey(tenant) || rows[0].phase !== 'active' || rows[0].claim_id !== null) return false;
  if (!await require('../tenant-lifecycle/tenant-lock').tryShared(query, rows[0].key, { label: 'removal-shared-lifetime' })) return false;
  const authority = await lifecycle.create({ namespace }).read(query, tenant);
  if (authority.eligibility !== 'deleted') return false;
  const executed = (await query('SELECT /* removal-current-execution */ ' + lifecycle.executedDeletionSQL(namespace) + ' AS executed FROM ' + q(namespace, 'tenant_lifecycle_windows') + ' w WHERE w.tenant_id=$1', [tenant])).rows;
  return executed.length === 1 && executed[0].executed === true;
}
function grants ({ namespace, role }) {
  namespaceOf(namespace);
  if (typeof role !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(role)) throw new TypeError('Explicit recommission operator role required');
  const who = '"' + role + '"';
  return Object.freeze([
    'GRANT USAGE ON SCHEMA "' + namespace + '" TO ' + who,
    ...['tenant_registry', 'tenant_registry_hosts', 'tenant_registry_keys'].map(table => 'GRANT SELECT ON ' + q(namespace, table) + ' TO ' + who),
    'GRANT INSERT (host,tenant_id,kind) ON ' + q(namespace, 'tenant_registry_hosts') + ' TO ' + who,
    'GRANT UPDATE (state,updated_at) ON ' + q(namespace, 'tenant_registry') + ' TO ' + who
  ]);
}
module.exports = { create, removalAdmission, grants };
