'use strict';

// Read-only physical admission for the explicitly reviewed tenant insertion
// primitive. Caller owns a consistent read-only transaction and tenant binding;
// this neither creates schema nor supplies a maintenance/authorization fence.
const { isDeepStrictEqual } = require('node:util');
const sql = require('../tenant-lifecycle/tenant-insertion-sql');
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX = 9223372036854775807n;
function identifiers (namespace, domain) {
  if (!NAME.test(namespace || '') || namespace === 'public' || namespace === 'information_schema' || namespace.startsWith('pg_') || !sql.DOMAINS.includes(domain)) {
    throw new TypeError('Explicit reviewed insertion namespace and domain required');
  }
  return { table: namespace + '.' + domain, counter: namespace + '.tenant_insertion_ordinal',
    fn: namespace + '.allocate_tenant_insertion_ordinal()', quoted: '"' + namespace + '"."' + domain + '"' };
}
function fail (detail) {
  const error = new Error('unsafe tenant insertion ' + detail);
  error.code = 'TENANT_INSERTION_ADMISSION_REFUSED';
  return error;
}
const expression = value => typeof value === 'string' ? value.replace(/::text|\s|[()]/g, '') : '';
const BINDING = expression("tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid");
function policy (rows) {
  return Array.isArray(rows) && rows.length === 1 && rows[0].command === '*' && rows[0].permissive === true &&
    isDeepStrictEqual(rows[0].roles, ['0']) && expression(rows[0].using) === BINDING && expression(rows[0].check) === BINDING;
}
function isOrderedCatalogue (catalogue) {
  return require('../migrations/catalogue').validateCatalogue(catalogue).some(migration =>
    migration.operation?.kind === 'tenant-insertion-v1');
}

async function schemaMetadata (connection, { namespace, domain } = {}) {
  const names = identifiers(namespace, domain);
  const row = (await connection.query(`SELECT /* tenant-insertion-structure */
    t.relkind='r' AND NOT t.relispartition AND t.relrowsecurity AND t.relforcerowsecurity AS clinical_secured,
    c.relkind='r' AND NOT c.relispartition AND c.relrowsecurity AND c.relforcerowsecurity AS counter_secured,
    NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid IN(t.oid,c.oid) OR inhparent IN(t.oid,c.oid)) AS independent,
    t.relowner=c.relowner AND c.relowner=f.proowner AND t.relowner=(SELECT nspowner FROM pg_namespace WHERE oid=t.relnamespace) AS same_owner,
    pg_has_role(current_user,t.relowner,'MEMBER') OR pg_has_role(current_user,c.relowner,'MEMBER') OR pg_has_role(current_user,f.proowner,'MEMBER') AS owns,
    a.atttypid='pg_catalog.int8'::regtype AND a.attnotnull AND a.attidentity='' AND a.attgenerated='' AND NOT a.atthasdef AS plain_ordinal,
    (SELECT jsonb_agg(jsonb_build_object('name',attname,'type',format_type(atttypid,atttypmod),'required',attnotnull,'identity',attidentity,'generated',attgenerated) ORDER BY attnum)
      FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped) AS counter_columns,
    f.prosrc AS body,f.prosecdef AS definer,f.provolatile AS volatility,f.proconfig AS config,
    l.lanname AS language,f.prorettype='pg_catalog.trigger'::regtype AND NOT f.proretset AND f.pronargs=0 AS trigger_function,
    (SELECT jsonb_agg(jsonb_build_object('name',tgname,'enabled',tgenabled,'type',tgtype,'internal',tgisinternal,
      'function',tgfoid=f.oid,'args',tgnargs,'conditional',tgqual IS NOT NULL) ORDER BY tgname)
      FROM pg_trigger WHERE tgrelid=t.oid AND NOT tgisinternal) AS triggers,
    (SELECT jsonb_agg(jsonb_build_object('command',polcmd,'permissive',polpermissive,'roles',polroles,
      'using',pg_get_expr(polqual,polrelid),'check',pg_get_expr(polwithcheck,polrelid))) FROM pg_policy WHERE polrelid=c.oid) AS counter_policies,
    (SELECT jsonb_agg(jsonb_build_object('command',polcmd,'permissive',polpermissive,'roles',polroles,
      'using',pg_get_expr(polqual,polrelid),'check',pg_get_expr(polwithcheck,polrelid))) FROM pg_policy WHERE polrelid=t.oid) AS clinical_policies,
    EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=t.oid AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL
      AND (SELECT array_agg(a.attname::text ORDER BY k.ordinality) FROM unnest(i.indkey) WITH ORDINALITY k(number,ordinality)
        JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.number)=ARRAY['tenant_id','insertion_ordinal']::text[]) AS unique_order,
    EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary AND i.indisvalid AND i.indisready
      AND (SELECT array_agg(a.attname::text ORDER BY k.ordinality) FROM unnest(i.indkey) WITH ORDINALITY k(number,ordinality)
        JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.number)=ARRAY['tenant_id']::text[]) AS counter_primary,
    (SELECT jsonb_agg(jsonb_build_object('expression',pg_get_expr(conbin,conrelid),'validated',convalidated))
      FROM pg_constraint WHERE conrelid=c.oid AND contype='c') AS counter_checks,
    (SELECT jsonb_agg(jsonb_build_object('expression',pg_get_expr(conbin,conrelid),'validated',convalidated))
      FROM pg_constraint WHERE conrelid=t.oid AND conname='tenant_insertion_positive' AND contype='c') AS ordinal_checks,
    pg_get_serial_sequence($1,'insertion_ordinal') IS NULL AS no_sequence
    FROM pg_class t JOIN pg_attribute a ON a.attrelid=t.oid AND a.attname='insertion_ordinal' AND NOT a.attisdropped
    JOIN pg_class c ON c.oid=to_regclass($2) JOIN pg_proc f ON f.oid=to_regprocedure($3)
    JOIN pg_language l ON l.oid=f.prolang WHERE t.oid=to_regclass($1)`, [names.table, names.counter, names.fn])).rows[0];
  const expectedBody = sql.effectiveFunctionBody({ namespace, domain });
  const columns = [{ name: 'tenant_id', type: 'uuid', required: true, identity: '', generated: '' },
    { name: 'last_ordinal', type: 'bigint', required: true, identity: '', generated: '' }];
  const checks = row && {
    clinicalRls: row.clinical_secured === true, counterRls: row.counter_secured === true,
    independent: row.independent === true, sameOwner: row.same_owner === true, plainOrdinal: row.plain_ordinal === true,
    counterColumns: isDeepStrictEqual(row.counter_columns, columns), functionBody: row.body === expectedBody,
    invoker: row.definer === false, volatility: row.volatility === 'v', language: row.language === 'plpgsql',
    triggerFunction: row.trigger_function === true, searchPath: isDeepStrictEqual(row.config, ['search_path=pg_catalog']),
    trigger: isDeepStrictEqual(row.triggers, [{ name: 'tenant_insertion_allocate', enabled: 'O', type: 23, internal: false, function: true, args: 0, conditional: false }]),
    counterPolicy: policy(row.counter_policies), clinicalPolicy: policy(row.clinical_policies),
    counterCheck: Array.isArray(row.counter_checks) && row.counter_checks.length === 1 && row.counter_checks[0].validated === true && expression(row.counter_checks[0].expression) === 'last_ordinal>=0',
    ordinalCheck: Array.isArray(row.ordinal_checks) && row.ordinal_checks.length === 1 && row.ordinal_checks[0].validated === true && expression(row.ordinal_checks[0].expression) === 'insertion_ordinal>0',
    uniqueOrder: row.unique_order === true, counterPrimary: row.counter_primary === true, noSequence: row.no_sequence === true
  };
  const refused = checks ? Object.keys(checks).filter(name => !checks[name]) : ['missing'];
  if (refused.length) {
    const error = fail('schema');
    // Stable predicate names only; SQL/function text and private namespace names
    // remain with the caller's test instrumentation, never in public errors.
    error.predicates = refused;
    throw error;
  }
  return { owns: row.owns };
}

async function checkRole (connection, { namespace, domain, mode = 'serving' } = {}, role = null) {
  const names = identifiers(namespace, domain);
  if (!['serving', 'reader', 'restore'].includes(mode)) throw new TypeError('Explicit insertion admission role mode required');
  await schemaMetadata(connection, { namespace, domain });
  const acl = (await connection.query(`SELECT /* tenant-insertion-effective-acl */
    r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication AS elevated,
    EXISTS(SELECT 1 FROM pg_class c WHERE c.oid IN(to_regclass($1),to_regclass($2)) AND pg_has_role(r.oid,c.relowner,'MEMBER')) OR
      EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure($3) AND pg_has_role(r.oid,p.proowner,'MEMBER')) AS owns,
    has_schema_privilege(r.oid,$4,'CREATE') AS creates,
    has_table_privilege(r.oid,$1,'SELECT') AS clinical_reads,
    has_table_privilege(r.oid,$1,'UPDATE') AND has_table_privilege(r.oid,$1,'DELETE') AS clinical_writes,
    has_column_privilege(r.oid,$1,'tenant_id','INSERT') AND has_column_privilege(r.oid,$1,'id_kind','INSERT') AND has_column_privilege(r.oid,$1,'doc','INSERT') AS clinical_inputs,
    has_column_privilege(r.oid,$1,'insertion_ordinal','INSERT') AS explicit_ordinal,
    has_table_privilege(r.oid,$1,'TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r.oid,$1,'REFERENCES') AS clinical_extra,
    has_any_column_privilege(r.oid,$1,'INSERT,UPDATE,REFERENCES') OR has_table_privilege(r.oid,$1,'DELETE,TRUNCATE,REFERENCES,TRIGGER') AS clinical_mutates,
    has_table_privilege(r.oid,$2,'SELECT') AS counter_reads,
    has_column_privilege(r.oid,$2,'tenant_id','INSERT') AND has_column_privilege(r.oid,$2,'last_ordinal','INSERT') AND has_column_privilege(r.oid,$2,'last_ordinal','UPDATE') AS counter_writes,
    has_column_privilege(r.oid,$2,'tenant_id','UPDATE') OR has_table_privilege(r.oid,$2,'TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r.oid,$2,'REFERENCES') AS counter_extra,
    has_table_privilege(r.oid,$2,'DELETE') AS counter_deletes,
    has_any_column_privilege(r.oid,$2,'INSERT,UPDATE,REFERENCES') OR has_table_privilege(r.oid,$2,'DELETE,TRUNCATE,REFERENCES,TRIGGER') AS counter_mutates,
    has_function_privilege(r.oid,$3,'EXECUTE') AS executes
    FROM pg_roles r WHERE r.rolname=COALESCE($5::text,current_user)`, [names.table, names.counter, names.fn, namespace, role])).rows[0];
  if (!acl || acl.owns || acl.elevated || acl.creates || !acl.clinical_reads || !acl.counter_reads || acl.clinical_extra || acl.counter_extra ||
      (mode === 'reader' ? acl.clinical_mutates || acl.counter_mutates || acl.executes :
        !acl.clinical_writes || !acl.clinical_inputs || !acl.counter_writes || !acl.executes ||
        acl.explicit_ordinal !== (mode === 'restore') || (mode === 'serving' && acl.counter_deletes))) {
    throw fail('privileges');
  }
}

async function metadata (connection, options) { return checkRole(connection, options); }
async function roleMetadata (connection, options = {}) {
  if (typeof options.role !== 'string' || !NAME.test(options.role)) throw new TypeError('Explicit insertion target role required');
  return checkRole(connection, options, options.role);
}

async function floor (connection, { namespace, domain, tenant } = {}) {
  const names = identifiers(namespace, domain);
  if (typeof tenant !== 'string' || !UUID.test(tenant)) throw new TypeError('Explicit insertion tenant required');
  // One statement snapshot sees a compliant commit's rows and floor together.
  const rows = (await connection.query(`SELECT /* tenant-insertion-floor */
    current_setting('app.current_tenant_id',true) AS binding,
    (SELECT last_ordinal FROM "${namespace}".tenant_insertion_ordinal WHERE tenant_id=$1) AS last_ordinal,
    max(insertion_ordinal) AS maximum FROM ${names.quoted} WHERE tenant_id=$1`, [tenant])).rows;
  const row = rows[0];
  try {
    if (rows.length !== 1 || row.binding !== tenant) throw fail('floor binding');
    const maximum = row.maximum === null ? null : BigInt(row.maximum);
    const current = row.last_ordinal === null ? null : BigInt(row.last_ordinal);
    if ((maximum !== null && (maximum <= 0n || maximum > MAX)) || (current !== null && (current < 0n || current > MAX)) ||
        (maximum !== null && (current === null || current < maximum))) throw fail('floor');
  } catch { throw fail('floor'); }
}

module.exports = { isOrderedCatalogue, schemaMetadata, metadata, roleMetadata, floor };
