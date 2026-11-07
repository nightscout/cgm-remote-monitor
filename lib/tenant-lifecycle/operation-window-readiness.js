'use strict';

const candidate = require('./postgres-candidate.json').migrations;
const publicRoles = require('../storage/postgres-public-policy-roles');
const canonical = (value, namespace) => typeof value === 'string' ? value.toLowerCase()
  .replaceAll('"' + namespace + '".', '').replaceAll(namespace + '.', '').replace(/pg_catalog\./g, '')
  .replace(/::text/g, '').replace(/[\s()]/g, '') : '';
const tenant = "tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid";
const owner = tenant + ' AND owner_pid = pg_backend_pid() AND owner_birth = tenant_lifecycle_backend_birth()';
const layouts = {
  schema_migrations: [['name','text',true],['checksum','text',true],['applied_at','timestamp with time zone',true,'now()']],
  tenant_lifecycle_windows: [['tenant_id','uuid',true],['lock_key','bigint',true],['phase','text',true],['generation','bigint',true],['claim_id','uuid',false]],
  tenant_lifecycle_operations: [['tenant_id','uuid',true],['operation_id','uuid',true],['generation','bigint',true],['finished','boolean',true,'false'],['owner_pid','integer',true,'pg_backend_pid()'],['owner_birth','timestamp with time zone',true,'tenant_lifecycle_backend_birth()']]
};
const constraints = {
  schema_migrations: ['PRIMARY KEY (name)'],
  tenant_lifecycle_windows: ['PRIMARY KEY (tenant_id)','UNIQUE (lock_key)','CHECK (lock_key > 0)','CHECK (phase = ANY (ARRAY[\'active\'::text, \'suspended\'::text]))','CHECK (generation > 0)',"CHECK ((phase = 'suspended'::text) = (claim_id IS NOT NULL))","CHECK (tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid)"],
  tenant_lifecycle_operations: ['PRIMARY KEY (operation_id)','FOREIGN KEY (tenant_id) REFERENCES tenant_lifecycle_windows(tenant_id)','CHECK (generation > 0)']
};
function fail () { throw Object.assign(new Error('LIFECYCLE_WINDOW_SCHEMA_UNSAFE'), {code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'}); }
function validateTable (row, name, namespace, lifetime) {
  const op = name === 'tenant_lifecycle_operations', ledger = name === 'schema_migrations';
  if (!row || !row.oid || row.kind !== 'r' || row.persistence !== 'p' || row.owns !== false || row.reads !== true || row.broad_writes !== false ||
      row.triggers !== false || row.rules !== false || row.inherited !== false || row.bad_indexes !== false || row.dropped !== false || row.owner_safe !== true || !Array.isArray(row.columns) || row.columns.length !== layouts[name].length ||
      (!ledger && !row.secured) || (ledger && row.secured)) fail();
  layouts[name].forEach(([column,type,notNull,expression], i) => {
    const actual = row.columns[i];
    if (!actual || actual.name !== column || actual.type !== type || actual.not_null !== notNull ||
        actual.identity !== '' || actual.generated !== '' || canonical(actual.default,namespace) !== canonical(expression,namespace) ||
        actual.inserts !== !!(op && lifetime && ['tenant_id','operation_id','generation'].includes(column)) ||
        actual.updates !== !!(op && lifetime && column === 'finished')) fail();
  });
  if (!Array.isArray(row.constraints) || row.constraints.some(c => !c.valid || c.deferrable) ||
      JSON.stringify(row.constraints.map(c => canonical(c.definition,namespace)).sort()) !== JSON.stringify(constraints[name].map(c => canonical(c,namespace)).sort())) fail();
  const expected = ledger ? [] : [{command:'r',using:tenant,check:null}];
  if (op) expected.push({command:'a',using:null,check:owner+' AND finished = false'}, {command:'w',using:owner+' AND finished = false',check:owner+' AND finished = true'});
  if (!Array.isArray(row.policies) || row.policies.length !== expected.length) fail();
  for (const p of expected) {
    const found = row.policies.find(v => v.command === p.command);
    if (!found || !found.permissive || !publicRoles(found.roles) || canonical(found.using,namespace) !== canonical(p.using,namespace) || canonical(found.check,namespace) !== canonical(p.check,namespace)) fail();
  }
}

async function admit (client, namespace, {lifetime = false, identity} = {}) {
  const role = (await client.query(`SELECT /* operation-window-role ${lifetime ? 'lifetime' : 'lower'} */ n.oid AS namespace_oid,n.nspowner AS owner_oid,
    r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication AS elevated,
    pg_has_role(current_user,n.nspowner,'MEMBER') AS owns_schema,
    has_schema_privilege(n.oid,'USAGE') AS uses_schema,
    has_database_privilege(current_database(),'CREATE') AS database_create,
    EXISTS (SELECT 1 FROM pg_roles e WHERE (e.rolsuper OR e.rolbypassrls OR e.rolcreaterole OR e.rolcreatedb OR e.rolreplication) AND pg_has_role(current_user,e.oid,'MEMBER')) AS elevated_membership,
    ${lifetime ? `EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
      WHERE s.nspname !~ '^pg_' AND s.nspname <> 'information_schema'
      AND NOT (s.nspname=$1 AND c.relname='tenant_lifecycle_operations')
      AND (has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
        OR has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES')))` : 'false'} AS foreign_writes,
    EXISTS (SELECT 1 FROM pg_namespace s WHERE s.nspname !~ '^pg_' AND s.nspname <> 'information_schema' AND has_schema_privilege(s.oid,'CREATE')) AS schema_writes
    FROM pg_roles r CROSS JOIN pg_namespace n WHERE r.rolname=current_user AND n.nspname=$1`, [namespace])).rows;
  if (role.length !== 1 || !role[0].namespace_oid || role[0].uses_schema !== true || role[0].elevated !== false || role[0].owns_schema !== false || role[0].database_create !== false || role[0].elevated_membership !== false || role[0].schema_writes !== false || role[0].foreign_writes !== false) fail();
  const identities = { namespaceOid: role[0].namespace_oid, ownerOid: role[0].owner_oid };
  for (const name of Object.keys(layouts)) {
    const rows = (await client.query(`SELECT /* operation-window-table */ c.oid,c.relowner AS owner_oid,c.relkind AS kind,c.relpersistence AS persistence,
      c.relrowsecurity AND c.relforcerowsecurity AS secured,pg_has_role(current_user,c.relowner,'MEMBER') AS owns,
      NOT (o.rolcanlogin OR o.rolsuper OR o.rolbypassrls OR o.rolcreaterole OR o.rolcreatedb OR o.rolreplication) AS owner_safe,has_table_privilege(c.oid,'SELECT') AS reads,
      has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(c.oid,'REFERENCES') AS broad_writes,
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attisdropped) AS dropped,
      EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS triggers,
      EXISTS (SELECT 1 FROM pg_rewrite w WHERE w.ev_class=c.oid) AS rules,
      EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhrelid=c.oid OR h.inhparent=c.oid) AS inherited,
      EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND (NOT i.indisvalid OR NOT i.indisready OR NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid=i.indexrelid))) AS bad_indexes,
      (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
        'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),
        'inserts',has_column_privilege(c.oid,a.attname,'INSERT'),'updates',has_column_privilege(c.oid,a.attname,'UPDATE')) ORDER BY a.attnum)
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('definition',pg_get_constraintdef(k.oid),'valid',k.convalidated,'deferrable',k.condeferrable)) FROM pg_constraint k WHERE k.conrelid=c.oid),'[]'::jsonb) AS constraints,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('command',p.polcmd,'roles',p.polroles,'permissive',p.polpermissive,'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))) FROM pg_policy p WHERE p.polrelid=c.oid),'[]'::jsonb) AS policies
      FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=to_regclass($1)`, ['"'+namespace+'".'+name])).rows;
    if (rows.length !== 1 || rows[0].owner_oid !== identities.ownerOid) fail();
    validateTable(rows[0],name,namespace,lifetime);
    identities[name === 'schema_migrations' ? 'ledgerOid' : name === 'tenant_lifecycle_windows' ? 'windowsOid' : 'operationsOid'] = rows[0].oid;
  }
  const funcs = (await client.query(`SELECT /* operation-window-function */ p.oid,p.proowner AS owner_oid,p.prosecdef,p.provolatile,p.proretset,p.pronargs,
    pg_get_function_result(p.oid) AS result,p.prosrc,p.proconfig,l.lanname,NOT (o.rolcanlogin OR o.rolsuper OR o.rolbypassrls OR o.rolcreaterole OR o.rolcreatedb OR o.rolreplication) AS owner_safe,
    pg_has_role(current_user,p.proowner,'MEMBER') AS owns,
    has_function_privilege(p.oid,'EXECUTE') AS executes,
    EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_executes
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang JOIN pg_roles o ON o.oid=p.proowner
    WHERE n.nspname=$1 AND p.proname='tenant_lifecycle_backend_birth'`, [namespace])).rows;
  const f = funcs[0];
  if (funcs.length !== 1 || f.owner_oid !== identities.ownerOid || f.prosecdef !== false || f.provolatile !== 's' || f.proretset !== false || f.pronargs !== 0 || f.result !== 'timestamp with time zone' ||
      f.lanname !== 'sql' || f.owner_safe !== true || f.owns !== false || f.public_executes !== false || f.executes !== lifetime ||
      JSON.stringify(f.proconfig) !== JSON.stringify(['search_path=pg_catalog']) ||
      canonical(f.prosrc,namespace) !== canonical('SELECT backend_start FROM pg_catalog.pg_stat_activity WHERE pid = pg_catalog.pg_backend_pid()',namespace)) fail();
  identities.backendBirthOid = f.oid;
  const history = (await client.query('SELECT /* operation-window-ledger */ name,checksum FROM "'+namespace+'".schema_migrations ORDER BY name')).rows;
  if (history.length !== candidate.length || history.some((v,i) => v.name !== candidate[i].name || v.checksum !== candidate[i].checksum)) fail();
  if (identity && JSON.stringify(identities) !== JSON.stringify(identity)) fail();
  return Object.freeze(identities);
}
module.exports = { admit, validateTable, layouts, constraints, canonical };
