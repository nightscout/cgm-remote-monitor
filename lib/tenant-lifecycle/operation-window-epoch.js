'use strict';

// Catalogue epoch for operation-window admission (decision
// cost-proportional-to-activity, item 3). The full admission
// (operation-window-readiness.js admit) proves the serving identity cannot
// alter or bypass the lifecycle control tables. Its inputs are catalogue rows;
// PostgreSQL gives every committed change to a catalogue row a new row version
// with a new xmin, and every created or dropped object adds or removes a row.
// The epoch is a digest, computed by the database inside the caller's
// transaction, of the identity (oid or key) and row version (xmin) of every
// catalogue row an admission reads, plus the live values that live outside
// database-local catalogues (role attributes, memberships, the ledger). A
// cached admission is reused only while the database reports the same epoch;
// any change makes the next transaction run the full admission again.
//
// Coverage, per admission input (operation-window-readiness.js):
//  role row and elevated membership  -> every pg_roles row's attributes (live) and every pg_auth_members row version
//  schema ownership/usage/CREATE     -> every pg_namespace row version (schema_writes reads them all)
//  database CREATE                   -> the current pg_database row version
//  five control tables               -> pg_class, pg_attribute, pg_attrdef, pg_constraint, pg_policy, pg_trigger,
//                                       pg_rewrite, pg_index (with validity flags), pg_inherits row versions
//  backend-birth function            -> its pg_proc and pg_language row versions
//  migrations ledger                 -> its rows (name, checksum), read live
//  lifetime foreign writes/functions -> every user pg_class and pg_proc row version (oid >= 16384, a superset of
//                                       the swept namespaces) and every user pg_attribute row carrying a column ACL
// Owner attributes (owner_safe) are covered by the pg_roles attributes. A change
// a non-superuser cannot make (renaming built-in types or languages) is not covered.
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const TABLES = Object.freeze(['schema_migrations', 'tenant_lifecycle_windows', 'tenant_lifecycle_operations', 'tenant_lifecycle_restore_authority', 'tenant_lifecycle_restore_audit']);
const versions = (relation, key, where) => `(SELECT string_agg(${key}||'@'||x.xmin::text, ',' ORDER BY ${key}) FROM ${relation} x WHERE ${where})`;

const OID = value => { if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Admitted catalogue identity required'); return String(value); };
// identity: the frozen result of a full admission (operation-window-readiness.js).
// Its oids are literals here so every per-table lookup is an index scan; the
// names are re-resolved in the digest, so a replaced object changes the epoch.
function sql (namespace, lifetime, identity) {
  if (!NAME.test(namespace) || namespace === 'public' || namespace === 'information_schema' || namespace.startsWith('pg_')) throw new TypeError('Explicit operation-window namespace required');
  const relids = "'{" + ['ledgerOid', 'windowsOid', 'operationsOid', 'authorityOid', 'auditOid'].map(key => OID(identity?.[key])).join(',') + "}'::oid[]";
  const birth = OID(identity?.backendBirthOid) + '::oid';
  const parts = [
    `'${OID(identity.namespaceOid)}:'||coalesce((SELECT oid::text FROM pg_namespace WHERE nspname='${namespace}'),'-')`,
    `array_to_string(ARRAY[` + TABLES.map(name => `to_regclass('"${namespace}".${name}')`).join(',') + `]::oid[],',')`,
    `coalesce((SELECT p.oid::text FROM pg_proc p WHERE p.pronamespace=${OID(identity.namespaceOid)}::oid AND p.proname='tenant_lifecycle_backend_birth' AND p.pronargs=0),'-')`,
    `(SELECT string_agg(r.oid::text||':'||r.rolsuper||r.rolinherit||r.rolcreaterole||r.rolcreatedb||r.rolcanlogin||r.rolreplication||r.rolbypassrls, ',' ORDER BY r.oid) FROM pg_roles r)`,
    `current_user::regrole::oid::text`,
    versions('pg_auth_members', `x.roleid::text||'>'||x.member::text`, 'true'),
    versions('pg_namespace', 'x.oid::text', 'true'),
    versions('pg_database', 'x.oid::text', 'x.datname=current_database()'),
    lifetime ? versions('pg_class', 'x.oid::text', 'x.oid >= 16384::oid') : versions('pg_class', 'x.oid::text', `x.oid = ANY(${relids})`),
    versions('pg_attribute', `x.attrelid::text||'.'||x.attnum::text`, lifetime ? `x.attrelid >= 16384::oid AND (x.attacl IS NOT NULL OR x.attrelid = ANY(${relids}))` : `x.attrelid = ANY(${relids})`),
    versions('pg_attrdef', 'x.oid::text', `x.adrelid = ANY(${relids})`),
    versions('pg_constraint', 'x.oid::text', `x.conrelid = ANY(${relids})`),
    versions('pg_policy', 'x.oid::text', `x.polrelid = ANY(${relids})`),
    versions('pg_trigger', 'x.oid::text', `x.tgrelid = ANY(${relids})`),
    versions('pg_rewrite', 'x.oid::text', `x.ev_class = ANY(${relids})`),
    versions('pg_index', `x.indexrelid::text||':'||x.indisvalid::text||x.indisready::text||x.indislive::text`, `x.indrelid = ANY(${relids})`),
    versions('pg_inherits', `x.inhrelid::text||'<'||x.inhparent::text`, `x.inhrelid = ANY(${relids}) OR x.inhparent = ANY(${relids})`),
    lifetime ? versions('pg_proc', 'x.oid::text', 'x.oid >= 16384::oid') : versions('pg_proc', 'x.oid::text', `x.oid = ${birth}`),
    versions('pg_language', 'x.oid::text', `x.oid = (SELECT prolang FROM pg_proc WHERE oid = ${birth})`),
    `(SELECT string_agg(name||':'||checksum, ',' ORDER BY name) FROM "${namespace}".schema_migrations)`
  ];
  return `encode(sha256(convert_to(concat_ws('|',${parts.map(part => `coalesce(${part},'-')`).join(',')}),'UTF8')),'hex')`;
}
module.exports = { sql, TABLES };
