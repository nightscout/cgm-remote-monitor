'use strict';

// Selected-v2 extension only. Original lifecycle/selected-v1 migrations retain
// their bytes and order. This public tenant-bound link contains no tenant data,
// key material or reconstruction-floor copy; the exact retained artifact owns it.
const { checksum, validateCatalogue } = require('../migrations/catalogue');
const TABLE = 'tenant_lifecycle_recommission';
const NAME = '0011_exact_artifact_recommission';
const tenant = "tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid";
const authority = 'EXISTS (SELECT 1 FROM tenant_lifecycle_restore_authority a WHERE a.tenant_id = ' + TABLE + '.tenant_id AND a.role_oid = CURRENT_USER::regrole::oid AND a.active)';
const auditMatch = 'r.tenant_id = ' + TABLE + '.tenant_id AND r.claim_id = ' + TABLE + '.claim_id AND r.generation = ' + TABLE + '.generation AND r.artifact_digest = ' + TABLE + '.artifact_digest AND r.role_oid = CURRENT_USER::regrole::oid';
const owner = 'r.owner_pid = pg_backend_pid() AND r.owner_birth = tenant_lifecycle_backend_birth()';
const insertRecord = 'EXISTS (SELECT 1 FROM tenant_lifecycle_requests d WHERE d.tenant_id = ' + TABLE + ".tenant_id AND d.request_id = " + TABLE + ".request_id AND d.artifact_digest = " + TABLE + ".artifact_digest AND d.phase = 'executed' AND EXISTS (SELECT 1 FROM tenant_lifecycle_key_retention k WHERE k.tenant_id = d.tenant_id AND k.request_id = d.request_id AND k.artifact_digest = d.artifact_digest AND k.phase = 'retained'))";
const activation = 'EXISTS (SELECT 1 FROM tenant_lifecycle_windows w WHERE w.tenant_id = ' + TABLE + ".tenant_id AND w.phase = 'active' AND w.generation = " + TABLE + '.generation) AND EXISTS (SELECT 1 FROM tenant_lifecycle_restore_audit r WHERE ' + auditMatch + " AND ((r.state = 'activated' AND " + owner + ") OR (r.state = 'restored' AND EXISTS (SELECT 1 FROM tenant_lifecycle_restore_resume s WHERE s.tenant_id = r.tenant_id AND s.claim_id = r.claim_id AND s.generation = r.generation AND s.artifact_digest = r.artifact_digest AND s.interrupted = 'data-replaced' AND s.role_oid = CURRENT_USER::regrole::oid AND s.owner_pid = pg_backend_pid() AND s.owner_birth = tenant_lifecycle_backend_birth()))))";
const UP = Object.freeze([
  'CREATE TABLE ' + TABLE + ' (tenant_id uuid NOT NULL REFERENCES tenant_lifecycle_windows (tenant_id), request_id uuid PRIMARY KEY REFERENCES tenant_lifecycle_requests (request_id), claim_id uuid NOT NULL UNIQUE REFERENCES tenant_lifecycle_restore_audit (claim_id), generation bigint NOT NULL CHECK (generation > 0), artifact_digest text NOT NULL CHECK (artifact_digest ~ \'^[a-f0-9]{64}$\'), activated boolean NOT NULL DEFAULT false)',
  'ALTER TABLE ' + TABLE + ' ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE ' + TABLE + ' FORCE ROW LEVEL SECURITY',
  'REVOKE ALL ON ' + TABLE + ' FROM PUBLIC',
  'CREATE POLICY tenant_recommission_read ON ' + TABLE + ' FOR SELECT USING (' + tenant + ')',
  'CREATE POLICY tenant_recommission_insert ON ' + TABLE + ' FOR INSERT WITH CHECK (' + tenant + ' AND activated = false AND ' + authority + ' AND ' + insertRecord + " AND EXISTS (SELECT 1 FROM tenant_lifecycle_restore_audit r WHERE " + auditMatch + " AND r.state = 'suspended' AND " + owner + '))',
  'CREATE POLICY tenant_recommission_activate ON ' + TABLE + ' FOR UPDATE USING (' + tenant + ' AND activated = false AND ' + authority + ') WITH CHECK (' + tenant + ' AND activated = true AND ' + authority + ' AND ' + activation + ')'
]);
function extend (base) {
  const prefix = validateCatalogue(base);
  if (prefix.some(migration => migration.name === NAME)) throw new TypeError('LIFECYCLE_RECOMMISSION_ALREADY_SELECTED');
  return Object.freeze({ version: 1, migrations: Object.freeze([...prefix, Object.freeze({ name: NAME, up: UP, checksum: checksum(UP) })]) });
}
module.exports = { TABLE, NAME, UP, extend, tenant, authority, auditMatch, owner, insertRecord, activation };
