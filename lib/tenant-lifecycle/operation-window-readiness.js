'use strict';

const candidate = require('./postgres-candidate.json').migrations;
const publicRoles = require('../storage/postgres-public-policy-roles');
const canonical = require('./catalogue-structure');
const tenant = "tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid";
const owner = tenant + ' AND owner_pid = pg_backend_pid() AND owner_birth = tenant_lifecycle_backend_birth()';
const roleOwner = tenant + ' AND role_oid = CURRENT_USER::regrole::oid';
const restoreOwner = roleOwner + ' AND owner_pid = pg_backend_pid() AND owner_birth = tenant_lifecycle_backend_birth()';
const restoreAuthority = tenant + ' AND EXISTS (SELECT 1 FROM tenant_lifecycle_restore_authority a WHERE a.tenant_id = tenant_lifecycle_windows.tenant_id AND a.role_oid = CURRENT_USER::regrole::oid AND a.active)';
const appendColumns = Object.freeze({
  tenant_lifecycle_restore_resume: ['tenant_id','resume_id','claim_id','generation','artifact_digest','interrupted'],
  tenant_lifecycle_operation_clearance: ['tenant_id','operation_id','generation','marker_pid','marker_birth']
});
const tableIdentities = Object.freeze({schema_migrations:'ledgerOid',tenant_lifecycle_windows:'windowsOid',tenant_lifecycle_operations:'operationsOid',tenant_lifecycle_restore_authority:'authorityOid',tenant_lifecycle_restore_audit:'auditOid',tenant_lifecycle_restore_resume:'resumeOid',tenant_lifecycle_operation_clearance:'clearanceOid'});
const identityKeys = Object.freeze(['namespaceOid','ownerOid',...Object.values(tableIdentities),'backendBirthOid']);
const layouts = {
  schema_migrations: [['name','text',true],['checksum','text',true],['applied_at','timestamp with time zone',true,'now()']],
  tenant_lifecycle_windows: [['tenant_id','uuid',true],['lock_key','bigint',true],['phase','text',true],['generation','bigint',true],['claim_id','uuid',false],['artifact_digest','text',false]],
  tenant_lifecycle_operations: [['tenant_id','uuid',true],['operation_id','uuid',true],['generation','bigint',true],['finished','boolean',true,'false'],['owner_pid','integer',true,'pg_backend_pid()'],['owner_birth','timestamp with time zone',true,'tenant_lifecycle_backend_birth()']],
  tenant_lifecycle_restore_authority: [['tenant_id','uuid',true],['role_oid','oid',true],['active','boolean',true,'false']],
  tenant_lifecycle_restore_audit: [['tenant_id','uuid',true],['claim_id','uuid',true],['generation','bigint',true],['artifact_digest','text',true],
    ['role_oid','oid',true,'CURRENT_USER::regrole::oid'],['owner_pid','integer',true,'pg_backend_pid()'],['owner_birth','timestamp with time zone',true,'tenant_lifecycle_backend_birth()'],
    ['state','text',true,"'suspended'::text"],['started_at','timestamp with time zone',true,'clock_timestamp()'],['restored_at','timestamp with time zone',false],['activated_at','timestamp with time zone',false]],
  tenant_lifecycle_restore_resume: [['tenant_id','uuid',true],['resume_id','uuid',true],['claim_id','uuid',true],['generation','bigint',true],['artifact_digest','text',true],['interrupted','text',true],
    ['role_oid','oid',true,'CURRENT_USER::regrole::oid'],['owner_pid','integer',true,'pg_backend_pid()'],['owner_birth','timestamp with time zone',true,'tenant_lifecycle_backend_birth()'],['resumed_at','timestamp with time zone',true,'clock_timestamp()']],
  tenant_lifecycle_operation_clearance: [['tenant_id','uuid',true],['operation_id','uuid',true],['generation','bigint',true],['marker_pid','integer',true],['marker_birth','timestamp with time zone',true],
    ['role_oid','oid',true,'CURRENT_USER::regrole::oid'],['owner_pid','integer',true,'pg_backend_pid()'],['owner_birth','timestamp with time zone',true,'tenant_lifecycle_backend_birth()'],['cleared_at','timestamp with time zone',true,'clock_timestamp()']]
};
const constraints = {
  schema_migrations: ['PRIMARY KEY (name)'],
  tenant_lifecycle_windows: ['PRIMARY KEY (tenant_id)','UNIQUE (lock_key)','CHECK (lock_key > 0)','CHECK (phase = ANY (ARRAY[\'active\'::text, \'suspended\'::text]))','CHECK (generation > 0)',"CHECK ((phase = 'suspended'::text) = (claim_id IS NOT NULL))","CHECK (tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid)","CHECK (artifact_digest ~ '^[a-f0-9]{64}$'::text)","CHECK ((phase = 'suspended'::text) = (artifact_digest IS NOT NULL))"],
  tenant_lifecycle_operations: ['PRIMARY KEY (operation_id)','FOREIGN KEY (tenant_id) REFERENCES tenant_lifecycle_windows(tenant_id)','CHECK (generation > 0)'],
  tenant_lifecycle_restore_authority: ['PRIMARY KEY (tenant_id, role_oid)','FOREIGN KEY (tenant_id) REFERENCES tenant_lifecycle_windows(tenant_id)'],
  tenant_lifecycle_restore_audit: ['PRIMARY KEY (claim_id)','FOREIGN KEY (tenant_id) REFERENCES tenant_lifecycle_windows(tenant_id)','CHECK (generation > 0)',
    "CHECK (artifact_digest ~ '^[a-f0-9]{64}$'::text)", "CHECK (state = ANY (ARRAY['suspended'::text, 'restored'::text, 'activated'::text]))",
    "CHECK ((state = ANY (ARRAY['restored'::text, 'activated'::text])) = (restored_at IS NOT NULL))", "CHECK ((state = 'activated'::text) = (activated_at IS NOT NULL))",
    'CHECK (activated_at IS NULL OR activated_at >= restored_at)'],
  tenant_lifecycle_restore_resume: ['PRIMARY KEY (resume_id)','UNIQUE (claim_id)','FOREIGN KEY (tenant_id) REFERENCES tenant_lifecycle_windows(tenant_id)','FOREIGN KEY (claim_id) REFERENCES tenant_lifecycle_restore_audit(claim_id)','CHECK (generation > 0)',
    "CHECK (artifact_digest ~ '^[a-f0-9]{64}$'::text)", "CHECK (interrupted = ANY (ARRAY['before-data'::text, 'data-replaced'::text]))"],
  tenant_lifecycle_operation_clearance: ['PRIMARY KEY (operation_id)','FOREIGN KEY (tenant_id) REFERENCES tenant_lifecycle_windows(tenant_id)','FOREIGN KEY (operation_id) REFERENCES tenant_lifecycle_operations(operation_id)','CHECK (generation > 0)']
};
function policiesFor (name) {
  const result = name === 'schema_migrations' ? [] : [{command:'r',using:name === 'tenant_lifecycle_restore_authority' || name === 'tenant_lifecycle_restore_audit' || name === 'tenant_lifecycle_restore_resume' ? roleOwner : tenant,check:null}];
  if (name === 'tenant_lifecycle_operations') result.push({command:'a',using:null,check:owner+' AND finished = false'}, {command:'w',using:owner+' AND finished = false',check:owner+' AND finished = true'});
  // Provisioning inserts a tenant's window active at generation 1 (migration 0008,
  // decision provisioning-split); every later change is the restore authority's.
  if (name === 'tenant_lifecycle_windows') result.push({command:'w',using:restoreAuthority,check:restoreAuthority},
    {command:'a',using:null,check:tenant+" AND phase = 'active' AND generation = 1 AND claim_id IS NULL AND artifact_digest IS NULL"});
  if (name === 'tenant_lifecycle_restore_audit') result.push({command:'a',using:null,check:restoreOwner+" AND state = 'suspended'"}, {command:'w',using:restoreOwner,check:restoreOwner});
  if (Object.hasOwn(appendColumns,name)) {
    const authority = 'EXISTS (SELECT 1 FROM tenant_lifecycle_restore_authority a WHERE a.tenant_id = ' + name + '.tenant_id AND a.role_oid = CURRENT_USER::regrole::oid AND a.active)';
    const record = name === 'tenant_lifecycle_restore_resume'
      ? "EXISTS (SELECT 1 FROM tenant_lifecycle_restore_audit r WHERE r.claim_id = tenant_lifecycle_restore_resume.claim_id AND r.tenant_id = tenant_lifecycle_restore_resume.tenant_id AND r.generation = tenant_lifecycle_restore_resume.generation AND r.artifact_digest = tenant_lifecycle_restore_resume.artifact_digest AND ((r.state = 'suspended' AND tenant_lifecycle_restore_resume.interrupted = 'before-data') OR (r.state = 'restored' AND tenant_lifecycle_restore_resume.interrupted = 'data-replaced')))"
      : 'EXISTS (SELECT 1 FROM tenant_lifecycle_operations o WHERE o.operation_id = tenant_lifecycle_operation_clearance.operation_id AND o.tenant_id = tenant_lifecycle_operation_clearance.tenant_id AND o.generation = tenant_lifecycle_operation_clearance.generation AND o.owner_pid = tenant_lifecycle_operation_clearance.marker_pid AND o.owner_birth = tenant_lifecycle_operation_clearance.marker_birth AND o.finished = false)';
    result.push({command:'a',using:null,check:restoreOwner+' AND '+authority+' AND '+record});
  }
  return result;
}
function fail () { throw Object.assign(new Error('LIFECYCLE_WINDOW_SCHEMA_UNSAFE'), {code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'}); }
// The public code stays one fixed refusal. Privately remember only that the
// principal's own role or privileges, not the catalogue, failed admission.
const authorityRefusals = new WeakSet();
function failAuthority () { const error = Object.assign(new Error('LIFECYCLE_WINDOW_SCHEMA_UNSAFE'), {code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'}); authorityRefusals.add(error); throw error; }
const isAuthorityRefusal = error => authorityRefusals.has(error);
function validateTable (row, name, namespace, lifetime, maintenance = false, intakeProfile) {
  const selected = require('./generation-domain').bind(intakeProfile,namespace);
  if ((require('./native-selection').isNative(selected) || selected?.binding.protocol === require('../pgstream/pool-intake-profile').PROTOCOL) && name === require('./recommission-candidate').TABLE) {
    return require('./recommission-readiness').validate(row, namespace, maintenance);
  }
  const expectedConstraints = selected && !require('./native-selection').isNative(selected) && name === 'tenant_lifecycle_windows' ? [...constraints[name],require('./generation-domain').constraint()] : constraints[name];
  const op = name === 'tenant_lifecycle_operations', ledger = name === 'schema_migrations';
  const privateTable = name === 'tenant_lifecycle_restore_authority' || name === 'tenant_lifecycle_restore_audit' || Object.hasOwn(appendColumns,name);
  const audit = name === 'tenant_lifecycle_restore_audit';
  if (!row || !row.oid || row.kind !== 'r' || row.persistence !== 'p' || row.owns !== false || row.reads !== (privateTable ? maintenance : true) || row.broad_writes !== false ||
      row.triggers !== false || row.rules !== false || row.inherited !== false || row.bad_indexes !== false || row.dropped !== false || row.owner_safe !== true || !Array.isArray(row.columns) || row.columns.length !== layouts[name].length ||
      (!ledger && !row.secured) || (ledger && row.secured)) fail();
  layouts[name].forEach(([column,type,notNull,expression], i) => {
    const actual = row.columns[i];
    if (!actual || !Object.hasOwn(actual,'default') || actual.default === undefined || actual.name !== column || actual.type !== type || actual.not_null !== notNull ||
        actual.identity !== '' || actual.generated !== '' || canonical(actual.default,namespace) !== canonical(expression === undefined ? null : expression,namespace) ||
        actual.inserts !== !!(op && lifetime && ['tenant_id','operation_id','generation'].includes(column) || audit && maintenance && ['tenant_id','claim_id','generation','artifact_digest'].includes(column) || maintenance && appendColumns[name]?.includes(column)) ||
        actual.updates !== !!(op && lifetime && column === 'finished' || name === 'tenant_lifecycle_windows' && maintenance && ['phase','generation','claim_id','artifact_digest'].includes(column) || audit && maintenance && ['state','restored_at','activated_at'].includes(column))) fail();
  });
  if (!Array.isArray(row.constraints) || row.constraints.some(c => !c.valid || c.deferrable) ||
      JSON.stringify(row.constraints.map(c => canonical(c.definition,namespace)).sort()) !== JSON.stringify(expectedConstraints.map(c => canonical(c,namespace)).sort())) fail();
  const expected = policiesFor(name);
  if (!Array.isArray(row.policies) || row.policies.length !== expected.length) fail();
  for (const p of expected) {
    const found = row.policies.find(v => v.command === p.command);
    if (!found || !Object.hasOwn(found,'using') || !Object.hasOwn(found,'check') || found.using === undefined || found.check === undefined || !found.permissive || !publicRoles(found.roles) || canonical(found.using,namespace) !== canonical(p.using,namespace) || canonical(found.check,namespace) !== canonical(p.check,namespace)) fail();
  }
}

async function admit (client, namespace, {lifetime = false, maintenance = false, identity, intakeProfile} = {}) {
  intakeProfile = require('./generation-domain').bind(intakeProfile,namespace);
  const migrations = intakeProfile ? require('./generation-domain').catalogue(intakeProfile).migrations : candidate;
  if (lifetime && maintenance) fail();
  const role = (await client.query(`SELECT /* operation-window-role ${maintenance ? 'maintenance' : lifetime ? 'lifetime' : 'lower'} */ n.oid AS namespace_oid,n.nspowner AS owner_oid,
    r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication AS elevated,
    pg_has_role(current_user,n.nspowner,'MEMBER') AS owns_schema,
    has_schema_privilege(n.oid,'USAGE') AS uses_schema,
    has_database_privilege(current_database(),'CREATE') AS database_create,
    EXISTS (SELECT 1 FROM pg_roles e WHERE (e.rolsuper OR e.rolbypassrls OR e.rolcreaterole OR e.rolcreatedb OR e.rolreplication) AND pg_has_role(current_user,e.oid,'MEMBER')) AS elevated_membership,
    ${lifetime ? `EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace
      WHERE s.nspname !~ '^pg_' AND s.nspname <> 'information_schema'
      AND NOT (s.nspname=$1 AND p.proname='tenant_lifecycle_backend_birth' AND p.pronargs=0 AND p.prokind='f')
      AND has_function_privilege(p.oid,'EXECUTE'))` : 'false'} AS foreign_functions,
    ${lifetime ? `EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
      WHERE s.nspname !~ '^pg_' AND s.nspname <> 'information_schema'
      AND NOT (s.nspname=$1 AND c.relname='tenant_lifecycle_operations')
      AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(c.oid,'USAGE,UPDATE')
        WHEN c.relkind IN ('r','p','v','m','f') THEN
          (has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
            OR has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES')) ELSE false END)` : 'false'} AS foreign_writes,
    EXISTS (SELECT 1 FROM pg_namespace s WHERE s.nspname !~ '^pg_' AND s.nspname <> 'information_schema' AND has_schema_privilege(s.oid,'CREATE')) AS schema_writes
    FROM pg_roles r CROSS JOIN pg_namespace n WHERE r.rolname=current_user AND n.nspname=$1`, [namespace])).rows;
  if (role.length !== 1 || !role[0].namespace_oid || role[0].uses_schema !== true || role[0].elevated !== false || role[0].owns_schema !== false || role[0].database_create !== false || role[0].elevated_membership !== false || role[0].schema_writes !== false || role[0].foreign_writes !== false || role[0].foreign_functions !== false) failAuthority();
  const identities = { namespaceOid: role[0].namespace_oid, ownerOid: role[0].owner_oid };
  const selectedV2 = require('./native-selection').isNative(intakeProfile) || intakeProfile?.binding.protocol === require('../pgstream/pool-intake-profile').PROTOCOL;
  for (const name of [...Object.keys(layouts), ...(selectedV2 ? [require('./recommission-candidate').TABLE] : [])]) {
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
        'reads',has_column_privilege(c.oid,a.attname,'SELECT'),'inserts',has_column_privilege(c.oid,a.attname,'INSERT'),'updates',has_column_privilege(c.oid,a.attname,'UPDATE')) ORDER BY a.attnum)
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('definition',pg_get_constraintdef(k.oid),'valid',k.convalidated,'deferrable',k.condeferrable)) FROM pg_constraint k WHERE k.conrelid=c.oid),'[]'::jsonb) AS constraints,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('command',p.polcmd,'roles',p.polroles,'permissive',p.polpermissive,'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))) FROM pg_policy p WHERE p.polrelid=c.oid),'[]'::jsonb) AS policies
      FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=to_regclass($1)`, ['"'+namespace+'".'+name])).rows;
    if (rows.length !== 1 || rows[0].owner_oid !== identities.ownerOid) fail();
    validateTable(rows[0],name,namespace,lifetime,maintenance,intakeProfile);
    if (tableIdentities[name]) identities[tableIdentities[name]] = rows[0].oid;
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
      f.lanname !== 'sql' || f.owner_safe !== true || f.owns !== false || f.public_executes !== false || f.executes !== (lifetime || maintenance) ||
      JSON.stringify(f.proconfig) !== JSON.stringify(['search_path=pg_catalog']) ||
      canonical(f.prosrc,namespace) !== canonical('SELECT backend_start FROM pg_catalog.pg_stat_activity WHERE pid = pg_catalog.pg_backend_pid()',namespace)) fail();
  identities.backendBirthOid = f.oid;
  const history = (await client.query('SELECT /* operation-window-ledger */ name,checksum FROM "'+namespace+'".schema_migrations ORDER BY name')).rows;
  if (history.length !== migrations.length || history.some((v,i) => v.name !== migrations[i].name || v.checksum !== migrations[i].checksum)) fail();
  if (identity && JSON.stringify(identities) !== JSON.stringify(identity)) fail();
  return Object.freeze(identities);
}
module.exports = { admit, isAuthorityRefusal, validateTable, layouts, constraints, canonical, policiesFor, appendColumns, tableIdentities, identityKeys };
