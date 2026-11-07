'use strict';

// Standalone explicit operator SQL proposal, not an admitted migration catalogue.
const DOMAINS = Object.freeze(['entries', 'food', 'treatments', 'devicestatus', 'profile']);
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const MAX = '9223372036854775807';
function name (value) {
  if (typeof value !== 'string' || !NAME.test(value) || value === 'public' || value === 'information_schema' || value.startsWith('pg_')) {
    throw new TypeError('Explicit non-system SQL identifier required');
  }
  return '"' + value + '"';
}
function build ({ namespace, domain } = {}) {
  if (!DOMAINS.includes(domain)) throw new TypeError('Explicit admitted insertion-order domain required');
  const ns = name(namespace), table = ns + '.' + name(domain);
  const counter = ns + '."tenant_insertion_ordinal"';
  const fn = ns + '."allocate_tenant_insertion_ordinal"';
  const up = [
    'LOCK TABLE ' + table + ' IN ACCESS EXCLUSIVE MODE',
    'SET LOCAL row_security = off',
    `DO $tenant_insertion_upgrade$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class t JOIN pg_attribute a ON a.attrelid=t.oid
      WHERE t.oid='${table}'::regclass AND a.attname='insertion_ordinal'
        AND a.attidentity='a' AND a.atttypid='pg_catalog.int8'::regtype
        AND t.relkind='r' AND NOT t.relispartition AND t.relrowsecurity AND t.relforcerowsecurity)
     OR EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid='${table}'::regclass OR inhparent='${table}'::regclass) THEN
    RAISE EXCEPTION 'TENANT_ORDINAL_SOURCE_UNSUPPORTED';
  END IF;
  IF EXISTS (SELECT 1 FROM ${table} WHERE insertion_ordinal IS NULL OR insertion_ordinal<=0)
     OR EXISTS (SELECT 1 FROM ${table} GROUP BY tenant_id,insertion_ordinal HAVING count(*)>1) THEN
    RAISE EXCEPTION 'TENANT_ORDINAL_SOURCE_INVALID';
  END IF;
END
$tenant_insertion_upgrade$`,
    `CREATE TABLE ${counter} (tenant_id uuid PRIMARY KEY, last_ordinal bigint NOT NULL CHECK (last_ordinal>=0))`,
    `INSERT INTO ${counter} (tenant_id,last_ordinal) SELECT tenant_id,max(insertion_ordinal) FROM ${table} GROUP BY tenant_id`,
    `ALTER TABLE ${counter} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${counter} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY tenant_insertion_isolation ON ${counter} USING (tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid)`,
    `ALTER TABLE ${table} ALTER COLUMN insertion_ordinal DROP IDENTITY`,
    `ALTER TABLE ${table} ADD CONSTRAINT tenant_insertion_positive CHECK (insertion_ordinal>0)`,
    `CREATE UNIQUE INDEX ${name(domain + '_tenant_ordinal_unique')} ON ${table} (tenant_id,insertion_ordinal)`,
    `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $tenant_insertion$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM NULLIF(current_setting('app.current_tenant_id',true),'')::uuid THEN
    RAISE EXCEPTION 'TENANT_ORDINAL_BINDING_REQUIRED';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.insertion_ordinal IS DISTINCT FROM OLD.insertion_ordinal THEN
      RAISE EXCEPTION 'TENANT_ORDINAL_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ${counter} WHERE tenant_id=NEW.tenant_id)
     AND EXISTS (SELECT 1 FROM ${table} WHERE tenant_id=NEW.tenant_id) THEN
    RAISE EXCEPTION 'TENANT_ORDINAL_COUNTER_MISSING';
  END IF;
  IF NEW.insertion_ordinal IS NULL THEN
    INSERT INTO ${counter} AS counter (tenant_id,last_ordinal) VALUES (NEW.tenant_id,1)
      ON CONFLICT (tenant_id) DO UPDATE SET last_ordinal=counter.last_ordinal+1
      WHERE counter.last_ordinal<${MAX}
      RETURNING counter.last_ordinal INTO NEW.insertion_ordinal;
    IF NOT FOUND THEN RAISE EXCEPTION 'TENANT_ORDINAL_EXHAUSTED' USING ERRCODE='22003'; END IF;
  ELSE
    IF NEW.insertion_ordinal<=0 THEN RAISE EXCEPTION 'TENANT_ORDINAL_INVALID'; END IF;
    INSERT INTO ${counter} AS counter (tenant_id,last_ordinal) VALUES (NEW.tenant_id,NEW.insertion_ordinal)
      ON CONFLICT (tenant_id) DO UPDATE SET last_ordinal=GREATEST(counter.last_ordinal,EXCLUDED.last_ordinal);
  END IF;
  RETURN NEW;
END
$tenant_insertion$`,
    `REVOKE ALL ON FUNCTION ${fn}() FROM PUBLIC`,
    `CREATE TRIGGER tenant_insertion_allocate BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    'SET LOCAL row_security = on'
  ];
  function grants (role, restore) {
    const who = name(role);
    return Object.freeze([
      `REVOKE INSERT ON ${table} FROM ${who}`,
      `REVOKE INSERT (insertion_ordinal) ON ${table} FROM ${who}`,
      `GRANT INSERT (tenant_id,id_kind,doc${restore ? ',insertion_ordinal' : ''}) ON ${table} TO ${who}`,
      `GRANT EXECUTE ON FUNCTION ${fn}() TO ${who}`,
      `GRANT SELECT ON ${counter} TO ${who}`,
      `GRANT INSERT (tenant_id,last_ordinal), UPDATE (last_ordinal) ON ${counter} TO ${who}`
    ]);
  }
  function verifyGrants (role, { restore = false } = {}) {
    name(role);
    if (typeof restore !== 'boolean') throw new TypeError('Explicit restore privilege selection required');
    return `DO $tenant_insertion_acl$
BEGIN
  IF NOT has_schema_privilege('${role}','${namespace}','USAGE')
     OR NOT has_function_privilege('${role}','${fn}()','EXECUTE')
     OR NOT has_column_privilege('${role}','${table}','tenant_id','INSERT')
     OR NOT has_column_privilege('${role}','${table}','id_kind','INSERT')
     OR NOT has_column_privilege('${role}','${table}','doc','INSERT') THEN
    RAISE EXCEPTION 'TENANT_ORDINAL_INPUT_PRIVILEGES_REQUIRED';
  END IF;
  IF has_column_privilege('${role}','${table}','insertion_ordinal','INSERT') IS DISTINCT FROM ${restore ? 'true' : 'false'} THEN
    RAISE EXCEPTION 'TENANT_ORDINAL_EXPLICIT_INSERT_UNSAFE';
  END IF;
  IF NOT has_table_privilege('${role}','${counter}','SELECT')
     OR NOT has_column_privilege('${role}','${counter}','tenant_id','INSERT')
     OR NOT has_column_privilege('${role}','${counter}','last_ordinal','INSERT')
     OR NOT has_column_privilege('${role}','${counter}','last_ordinal','UPDATE')
     OR has_column_privilege('${role}','${counter}','tenant_id','UPDATE')
     OR has_table_privilege('${role}','${counter}','DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR EXISTS (SELECT 1 FROM pg_class c WHERE c.oid='${counter}'::regclass AND pg_has_role('${role}',c.relowner,'MEMBER'))
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}' AND (rolsuper OR rolbypassrls OR rolcreaterole)) THEN
    RAISE EXCEPTION 'TENANT_ORDINAL_COUNTER_PRIVILEGES_UNSAFE';
  END IF;
END
$tenant_insertion_acl$`;
  }
  return Object.freeze({ namespace, domain, counterTable: 'tenant_insertion_ordinal', up: Object.freeze(up),
    servingGrants: role => grants(role, false), restoreGrants: role => grants(role, true), verifyGrants });
}
// The already-committed v1 conversion statements remain immutable. This
// correction is a separately checksummed append-only migration operation.
function bindingCorrectionUp (options) {
  const source = build(options).up.find(sql => sql.startsWith('CREATE FUNCTION '));
  return Object.freeze([source.replace('CREATE FUNCTION ', 'CREATE OR REPLACE FUNCTION ')
    .replace("RAISE EXCEPTION 'TENANT_ORDINAL_BINDING_REQUIRED';", "RAISE EXCEPTION 'TENANT_ORDINAL_BINDING_REQUIRED' USING ERRCODE='42501';")]);
}
function effectiveFunctionBody (options) {
  return bindingCorrectionUp(options)[0].split('$tenant_insertion$')[1];
}
module.exports = { DOMAINS, build, bindingCorrectionUp, effectiveFunctionBody };
