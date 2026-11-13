'use strict';

// Whether a tenant is active, read from the lifecycle control namespace's
// existing state (postgres-candidate.json); no state of its own:
//   - tenant_lifecycle_windows.phase: 'suspended' while a restore holds the
//     tenant (maintenance-window.js), 'active' otherwise;
//   - tenant_lifecycle_requests / tenant_lifecycle_ceremony: a deletion request
//     that is not cancelled (requested, confirmed, executing) or has executed.
// A tenant without a window row is not provisioned for lifecycle operations and
// is not active. Shared by callers that must refuse on a non-active tenant (the
// admin role's ownership operations; other operator verbs may use it too).
//
// The caller runs inside one READ COMMITTED transaction bound to the tenant
// (app.current_tenant_id; the control tables use forced tenant RLS). With
// `hold: true` the transaction also takes the tenant's operation-window lock
// SHARED and nonblocking (pg_try_advisory_xact_lock_shared on the window's
// lock_key) before reading the phase, so a restore cannot take the exclusive
// lock and start its data phase until this transaction ends; a restore already
// holding it reads as 'held'. Advisory locks need no privilege; the identity
// needs schema USAGE and SELECT on the three tables (phaseGrants).
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TABLES = Object.freeze(['tenant_lifecycle_windows', 'tenant_lifecycle_requests', 'tenant_lifecycle_ceremony']);
const STATES = Object.freeze(['active', 'suspended', 'deletion', 'held', 'unprovisioned']);

function namespaceOf (value) {
  if (typeof value !== 'string' || !NAME.test(value) || value === 'public' || value.startsWith('pg_') || value === 'information_schema') {
    throw new TypeError('Explicit lifecycle control namespace required');
  }
  return value;
}
const qualified = (namespace, table) => '"' + namespace + '"."' + table + '"';

async function tenantPhase (connection, { namespace, tenant, hold = false } = {}) {
  namespaceOf(namespace);
  if (!connection || typeof connection.query !== 'function' || typeof tenant !== 'string' || !UUID.test(tenant)) {
    throw new TypeError('Tenant phase requires a transaction connection and a tenant');
  }
  const windows = qualified(namespace, 'tenant_lifecycle_windows');
  const requests = qualified(namespace, 'tenant_lifecycle_requests');
  const ceremony = qualified(namespace, 'tenant_lifecycle_ceremony');
  const key = (await connection.query('SELECT /* tenant-phase-key */ lock_key::text AS lock_key FROM ' + windows + ' WHERE tenant_id=$1', [tenant])).rows;
  if (key.length !== 1) return Object.freeze({ active: false, state: 'unprovisioned' });
  if (hold) {
    const held = (await connection.query('SELECT /* tenant-phase-hold */ pg_try_advisory_xact_lock_shared($1::bigint) AS held', [key[0].lock_key])).rows[0];
    if (held?.held !== true) return Object.freeze({ active: false, state: 'held' });
  }
  // Read after the lock: in READ COMMITTED this statement sees a suspension
  // committed before the lock was taken.
  const row = (await connection.query(`SELECT /* tenant-phase */ w.phase, w.lock_key::text AS lock_key,
      EXISTS (SELECT 1 FROM ${ceremony} c WHERE c.tenant_id=$1 AND c.phase<>'cancelled')
      OR EXISTS (SELECT 1 FROM ${requests} r WHERE r.tenant_id=$1 AND (r.phase='executed' OR NOT EXISTS
        (SELECT 1 FROM ${ceremony} c WHERE c.request_id=r.request_id AND c.tenant_id=$1 AND c.phase='cancelled'))) AS deletion
    FROM ${windows} w WHERE w.tenant_id=$1`, [tenant])).rows;
  if (row.length !== 1 || row[0].lock_key !== key[0].lock_key) return Object.freeze({ active: false, state: 'unprovisioned' });
  if (row[0].deletion !== false) return Object.freeze({ active: false, state: 'deletion' });
  if (row[0].phase !== 'active') return Object.freeze({ active: false, state: 'suspended' });
  return Object.freeze({ active: true, state: 'active' });
}

// The grants an identity needs to call tenantPhase. Nothing else in the
// control namespace: no operation registration, no window or ceremony write.
function phaseGrants ({ namespace, role } = {}) {
  namespaceOf(namespace);
  if (typeof role !== 'string' || !NAME.test(role)) throw new TypeError('Explicit role required');
  return Object.freeze(['GRANT USAGE ON SCHEMA "' + namespace + '" TO "' + role + '"',
    ...TABLES.map(table => 'GRANT SELECT ON ' + qualified(namespace, table) + ' TO "' + role + '"')]);
}

module.exports = { tenantPhase, phaseGrants, TABLES, STATES };
