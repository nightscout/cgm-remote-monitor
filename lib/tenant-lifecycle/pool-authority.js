'use strict';

// Current lifecycle ownership eligibility for selected-v2. Caller holds its
// actual tenant operation-window lease and invokes this on that same physical
// transaction/backend after binding the real tenant GUC. No startup roster,
// artifact, worker hint or process identity can supply this authority.
const { TABLE } = require('./recommission-candidate');
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const READS = Object.freeze(Object.fromEntries(Object.entries({
  tenant_lifecycle_windows: ['tenant_id', 'lock_key', 'phase', 'generation', 'claim_id', 'artifact_digest'],
  tenant_lifecycle_requests: ['tenant_id', 'request_id', 'artifact_digest', 'phase'],
  tenant_lifecycle_ceremony: ['tenant_id', 'request_id', 'phase'],
  [TABLE]: ['tenant_id', 'request_id', 'generation', 'artifact_digest', 'activated']
}).map(([table, columns]) => [table, Object.freeze(columns)])));
const fail = () => Object.assign(new Error('LIFECYCLE_POOL_AUTHORITY_REFUSED'), { code: 'LIFECYCLE_POOL_AUTHORITY_REFUSED' });
function namespaceOf (value) {
  if (typeof value !== 'string' || !NAME.test(value) || value === 'public' || value.startsWith('pg_') || value === 'information_schema') throw fail();
  return value;
}
const qualified = (namespace, table) => '"' + namespace + '"."' + table + '"';
function completedSQL (namespace, request) {
  const requests = qualified(namespace, 'tenant_lifecycle_requests'), links = qualified(namespace, TABLE);
  return 'EXISTS (SELECT 1 FROM ' + links + ' x JOIN ' + requests + ' d ON d.tenant_id=x.tenant_id AND d.request_id=x.request_id AND d.artifact_digest=x.artifact_digest' +
    " WHERE x.tenant_id=w.tenant_id AND x.request_id=" + request + " AND d.phase='executed' AND x.activated AND x.generation<=w.generation)";
}
function deletionSQL (namespace, windowAlias = 'w') {
  namespaceOf(namespace);
  if (windowAlias !== 'w') throw fail();
  const requests = qualified(namespace, 'tenant_lifecycle_requests');
  const ceremonies = qualified(namespace, 'tenant_lifecycle_ceremony');
  const completed = request => completedSQL(namespace, request);
  return '(EXISTS (SELECT 1 FROM ' + ceremonies + " c WHERE c.tenant_id=w.tenant_id AND c.phase<>'cancelled' AND NOT " + completed('c.request_id') + ')' +
    ' OR EXISTS (SELECT 1 FROM ' + requests + " r WHERE r.tenant_id=w.tenant_id AND (r.phase='executed' OR NOT EXISTS (SELECT 1 FROM " + ceremonies + " c WHERE c.request_id=r.request_id AND c.tenant_id=w.tenant_id AND c.phase='cancelled')) AND NOT " + completed('r.request_id') + '))';
}
function executedDeletionSQL (namespace) {
  namespaceOf(namespace);
  return 'EXISTS (SELECT 1 FROM ' + qualified(namespace, 'tenant_lifecycle_requests') + " r WHERE r.tenant_id=w.tenant_id AND r.phase='executed' AND NOT " +
    completedSQL(namespace, 'r.request_id') + ' AND EXISTS (SELECT 1 FROM ' + qualified(namespace, 'tenant_lifecycle_ceremony') + " c WHERE c.tenant_id=r.tenant_id AND c.request_id=r.request_id AND c.phase='executed'))";
}
function sql (namespace) {
  namespaceOf(namespace);
  return 'SELECT /* pool-lifecycle-authority */ w.tenant_id::text AS tenant,w.generation::text AS generation,w.phase,' +
    "w.tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AS bound," + deletionSQL(namespace) + ' AS deletion FROM ' + qualified(namespace, 'tenant_lifecycle_windows') + ' w WHERE w.tenant_id=$1';
}
function create ({ namespace } = {}) {
  const statement = sql(namespace);
  return Object.freeze({ async read (query, tenant) {
    if (typeof query !== 'function' || typeof tenant !== 'string' || !UUID.test(tenant)) throw fail();
    const rows = (await query(statement, [tenant])).rows;
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].tenant !== tenant || rows[0].bound !== true ||
        !['active', 'suspended'].includes(rows[0].phase) || typeof rows[0].deletion !== 'boolean') throw fail();
    try { require('./generation-domain').assertGeneration(rows[0].generation); } catch { throw fail(); }
    return Object.freeze({ tenant, identity: tenant, generation: rows[0].generation,
      eligibility: rows[0].deletion ? 'deleted' : rows[0].phase === 'active' ? 'active' : 'suspended' });
  } });
}
function grants ({ namespace, role } = {}) {
  namespaceOf(namespace);
  if (typeof role !== 'string' || !NAME.test(role)) throw fail();
  return Object.freeze(Object.entries(READS).map(([table, columns]) => 'GRANT SELECT (' + columns.map(column => '"' + column + '"').join(',') + ') ON ' + qualified(namespace, table) + ' TO "' + role + '"'));
}
module.exports = { READS, create, sql, deletionSQL, executedDeletionSQL, grants };
