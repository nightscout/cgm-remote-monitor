'use strict';

// Activity effects of the deletion ceremony (decision deletion-request-auto-pauses):
//   request  pauses the site now and remembers whether it was paused before;
//   cancel   restores that earlier pause state once no other request is pending;
//   execute  (the operator's claim) suspends the site.
// Each runs on the ceremony's own connection, inside its transaction and tenant
// binding, so the activity change commits or rolls back with the ceremony row.
// Owners may still pause or unpause while a request is pending; cancel restores
// the state from before the first pending request.
const qualified = (namespace, table) => '"' + namespace + '"."' + table + '"';
const refuse = code => Object.assign(new Error(code), { code });
const PENDING = ['requested', 'confirmed', 'executing'];

async function lockRow (connection, { ledgerNamespace, tenant }) {
  const row = (await connection.query('SELECT version::text,paused,suspended,deletion_request_id,paused_before_deletion FROM ' +
    qualified(ledgerNamespace, 'tenant_activity') + ' WHERE tenant_id=$1 FOR UPDATE', [tenant])).rows[0];
  // Every provisioned tenant has a row (decision activity-row-always-provisioned).
  if (!row) throw refuse('LIFECYCLE_ACTIVITY_MISSING');
  return row;
}
async function write (connection, { ledgerNamespace, tenant }, row, next, verb, actor) {
  const updated = (await connection.query('UPDATE ' + qualified(ledgerNamespace, 'tenant_activity') +
    ' SET version=version+1,paused=$3,suspended=$4,deletion_request_id=$5,paused_before_deletion=$6' +
    ' WHERE tenant_id=$1 AND version=$2::bigint RETURNING version::text,paused,suspended',
  [tenant, row.version, next.paused, next.suspended, next.deletion_request_id, next.paused_before_deletion])).rows[0];
  if (!updated) throw refuse('LIFECYCLE_ACTIVITY_CONFLICT');
  const recorded = await connection.query('INSERT INTO ' + qualified(ledgerNamespace, 'tenant_activity_audit') +
    ' (tenant_id,version,verb,authority,principal,consumer,paused,suspended) VALUES ($1,$2::bigint,$3,$4,$5,$6,$7,$8)',
  [tenant, updated.version, verb, actor.plane, actor.principal, actor.consumer, updated.paused, updated.suspended]);
  if (recorded.rowCount !== 1) throw refuse('LIFECYCLE_ACTIVITY_CONFLICT');
  return updated;
}
const current = row => ({ paused: row.paused, suspended: row.suspended, deletion_request_id: row.deletion_request_id,
  paused_before_deletion: row.paused_before_deletion });

async function requested (connection, options, actor) {
  const row = await lockRow(connection, options);
  const next = current(row);
  next.paused = true;
  if (row.deletion_request_id === null) { next.deletion_request_id = options.requestId; next.paused_before_deletion = row.paused; }
  return write(connection, options, row, next, 'deletion-request', actor);
}
async function cancelled (connection, options, actor) {
  const row = await lockRow(connection, options);
  const others = (await connection.query('SELECT request_id FROM ' + qualified(options.ledgerNamespace, 'tenant_lifecycle_ceremony') +
    ' WHERE tenant_id=$1 AND request_id<>$2 AND phase = ANY($3::text[]) ORDER BY request_id', [options.tenant, options.requestId, PENDING])).rows;
  const next = current(row);
  if (row.deletion_request_id === null) return row; // nothing was saved (request predates activity rows)
  if (others.length) next.deletion_request_id = others[0].request_id; // still pending: stay paused
  else { next.paused = row.paused_before_deletion; next.deletion_request_id = null; next.paused_before_deletion = null; }
  return write(connection, options, row, next, 'deletion-cancel', actor);
}
async function executing (connection, options, actor) {
  const row = await lockRow(connection, options);
  if (row.suspended) return row;
  return write(connection, options, row, { ...current(row), suspended: true }, 'deletion-execute', actor);
}

module.exports = { requested, cancelled, executing };
