'use strict';

// Separate operator store admission, not a relaxation of an application role's
// readiness. DDL and repair preparation happen explicitly outside the endpoint.
const fail = () => { throw Object.assign(new Error('TENANT_ENSURE_STORE_UNPREPARED'),{code:'TENANT_ENSURE_STORE_UNPREPARED'}); };
async function admit ({ client, namespaces: ns, ledgerNamespace, checkpoints, dependencyNamespaces }) {
  const qualified = (kind, table) => ns[kind] + '.' + table;
  const ledger = ledgerNamespace + '.tenant_ensure_events';
  const writable = [ledger,qualified('settings','tenant_settings'),qualified('registry','tenant_registry_keys')];
    await require('../tenant-settings/readiness-check')(client.query.bind(client),writable);
    const rows = (await client.query(`SELECT n.nspname AS namespace,c.relname AS name,c.relrowsecurity,c.relforcerowsecurity,
      r.rolcanlogin,r.rolsuper,r.rolbypassrls,pg_has_role(current_user,c.relowner,'MEMBER') AS owns,
      has_table_privilege(c.oid,'UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(c.oid,'UPDATE,REFERENCES') AS rewrites,
      EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polpermissive AND p.polcmd='*'
        AND pg_get_expr(p.polqual,p.polrelid)=$2 AND pg_get_expr(p.polwithcheck,p.polrelid)=$2)
        AND (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid)=1 AS binds,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
        WHERE a.grantee<>c.relowner AND a.privilege_type IN ('UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES')) OR
      EXISTS(SELECT 1 FROM pg_attribute col CROSS JOIN LATERAL aclexplode(col.attacl) a WHERE col.attrelid=c.oid AND a.grantee<>c.relowner AND a.privilege_type IN ('UPDATE','REFERENCES')) AS history_rewrite
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
      WHERE (n.nspname||'.'||c.relname)=ANY($1::text[]) LIMIT 5`,
    [[...writable,qualified('settings','tenant_settings_history')], "(tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)"])).rows;
    if (rows.length !== 4 || rows.some(r => !r.relrowsecurity || !r.relforcerowsecurity || r.rolcanlogin || r.rolsuper || r.rolbypassrls || r.owns || r.rewrites || !r.binds || (r.name === 'tenant_settings_history' || r.name === 'tenant_ensure_events') && r.history_rewrite)) fail();
    // Derive the read allowlist from the SAME fixed grant builder, not a
    // second permission policy. Extra clinical/credential value SELECTs refuse.
    const allowedTables=[],allowedColumns=[];
    for (const statement of require('./ensure').grants({namespaces:ns,ledgerNamespace,checkpoints,dependencyNamespaces,role:'ensure_scope_probe'})) {
      const columnMatch=/^GRANT SELECT \(([^)]+)\) ON (.+) TO /.exec(statement);
      const tableMatch=/^GRANT SELECT ON (.+) TO /.exec(statement);
      const match=columnMatch || (tableMatch && [tableMatch[0],undefined,tableMatch[1]]);
      if (!match) continue;
      const relation=match[2].replace(/"/g,'');
      if (match[1]) for (const column of match[1].split(',')) allowedColumns.push(relation+'.'+column.trim());
      else allowedTables.push(relation);
    }
    const readScope=(await client.query(`SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND a.attnum>0 AND NOT a.attisdropped
      AND has_column_privilege(c.oid,a.attname,'SELECT') AND NOT ((n.nspname||'.'||c.relname)=ANY($1::text[]))
      AND NOT ((n.nspname||'.'||c.relname||'.'||a.attname)=ANY($2::text[]))) AS extra_reads`,[allowedTables,allowedColumns])).rows[0];
    if (readScope?.extra_reads!==false) fail();
    const guard = (await client.query(`SELECT
      has_column_privilege(current_user,$1,'ciphertext','SELECT') AS ciphertext,
      has_sequence_privilege(current_user,$2,'UPDATE') AS sequence_updates,
      has_column_privilege(current_user,$3,'event_number','INSERT') AS identity_insert,
      has_column_privilege(current_user,$3,'event_time','INSERT') AS time_insert,
      pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid=to_regclass($2)),'MEMBER') AS sequence_owned,
      EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND p.prosecdef AND has_function_privilege(p.oid,'EXECUTE')) AS definer`, [qualified('secrets','secret_records'),ledgerNamespace+'.tenant_ensure_events_event_number_seq',ledger])).rows[0];
    if (!guard || guard.ciphertext !== false || guard.definer !== false || guard.sequence_updates !== false || guard.sequence_owned !== false || guard.identity_insert !== false || guard.time_insert !== false) fail();
    // INSERT can invoke triggers and CHECK functions. Screen the actual
    // shipped bodies/owners, not just the migration receipt or function name.
    const registryCatalogue = require('./postgres-candidate.json');
    const touch = registryCatalogue.migrations.flatMap(m => m.up).find(sql => sql.startsWith('CREATE FUNCTION tenant_registry_touch('));
    const touchBody = /AS \$fn\$([\s\S]*)\$fn\$$/.exec(touch)[1];
    const triggers = (await client.query(`SELECT n.nspname AS namespace,c.relname AS relation,t.tgname,t.tgtype,t.tgenabled,
      CASE WHEN octet_length(p.prosrc)<=65536 THEN p.prosrc END AS prosrc,p.prosecdef,CASE WHEN coalesce(octet_length(p.proconfig::text),0)<=4096 THEN p.proconfig ELSE ARRAY['oversized']::text[] END AS proconfig,l.lanname,r.rolcanlogin,r.rolsuper,r.rolbypassrls,
      c.relowner=p.proowner AS same_owner
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_language l ON l.oid=p.prolang JOIN pg_roles r ON r.oid=p.proowner
      WHERE NOT t.tgisinternal AND (n.nspname||'.'||c.relname)=ANY($1::text[]) LIMIT 2`,[writable])).rows;
    if (triggers.length !== 1) fail();
    const trigger = triggers[0];
    if (trigger.namespace !== ns.registry || trigger.relation !== 'tenant_registry_keys' || trigger.tgname !== 'tenant_registry_keys_revision' || trigger.tgtype !== 60 || trigger.tgenabled !== 'O' ||
      trigger.prosrc !== touchBody || !trigger.prosecdef || trigger.lanname !== 'plpgsql' || !trigger.same_owner || trigger.rolcanlogin || trigger.rolsuper || trigger.rolbypassrls ||
      JSON.stringify((trigger.proconfig || []).map(value => value.replace(/"/g,''))) !== JSON.stringify(['search_path=' + ns.registry + ', pg_catalog'])) fail();
    const validator = require('../tenant-settings/postgres-candidate.json').migrations.flatMap(m => m.up).find(sql => sql.startsWith('CREATE FUNCTION tenant_settings_values_valid('));
    const validatorBody = /AS \$\$([\s\S]*)\$\$$/.exec(validator)[1];
    const functions = (await client.query(`SELECT CASE WHEN octet_length(p.prosrc)<=65536 THEN p.prosrc END AS prosrc,p.prosecdef,p.proisstrict,p.provolatile,CASE WHEN coalesce(octet_length(p.proconfig::text),0)<=4096 THEN p.proconfig ELSE ARRAY['oversized']::text[] END AS proconfig,l.lanname,
      has_function_privilege(p.oid,'EXECUTE') AS executable,pg_get_function_result(p.oid) AS result,r.rolcanlogin,r.rolsuper,r.rolbypassrls
      FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang JOIN pg_roles r ON r.oid=p.proowner
      WHERE p.oid=to_regprocedure($1)`,[ns.settings+'.tenant_settings_values_valid(jsonb)'])).rows;
    const fn = functions[0];
    if (functions.length !== 1 || fn.executable !== true || fn.prosrc !== validatorBody || fn.prosecdef || !fn.proisstrict || fn.provolatile !== 'i' || fn.proconfig !== null || fn.lanname !== 'sql' || fn.result !== 'boolean' || fn.rolcanlogin || fn.rolsuper || fn.rolbypassrls) fail();
    // Exact canonical migrations for provenance-bearing history and our ledger.
    for (const [namespace,catalogue] of [[ns.settings,require('../tenant-settings/postgres-candidate.json')],[ledgerNamespace,require('./ensure-candidate.json')]]) {
      const expected = require('../migrations/catalogue').validateCatalogue(catalogue);
      const actual = (await client.query('SELECT CASE WHEN octet_length(name)<=256 THEN name END AS name,CASE WHEN octet_length(checksum)=64 THEN checksum END AS checksum FROM "' + namespace + '".schema_migrations ORDER BY name LIMIT '+(expected.length+1))).rows;
      if (JSON.stringify(actual.map(r => [r.name,r.checksum])) !== JSON.stringify(expected.map(r => [r.name,r.checksum]))) fail();
    }
    // Plan their fixed bounded access, including explicit checkpoint namespaces.
    await client.query('SELECT tenant_id,operation_id,phase,request_digest,result,observations FROM "' + ledgerNamespace + '".tenant_ensure_events WHERE false');
    for (const row of checkpoints) await client.query('SELECT tenant_id,consumer FROM "' + row.namespace + '".tenant_consumer_checkpoint WHERE false');
}
module.exports = async function startup (options) {
  await options.client.query('BEGIN READ ONLY');
  await admit(options);
  await options.client.query('ROLLBACK');
};
module.exports.admit = admit;
