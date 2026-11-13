'use strict';

// Closed deployment-only map. Tables come from canonical source helpers, never
// an API caller's table/SQL or a claim that another database has no records.
const { createHash } = require('node:crypto');
const census = require('../tenant-operations/catalogues');
const { validateCatalogue } = require('../migrations/catalogue');
const base = require('../tenant-lifecycle').admittedCatalogue();
const alternatives = require('../server/tenant-socket-order-port').catalogues;
const families = Object.fromEntries(base.map(row => [row.kind,[{candidate:row.candidate,tables:row.tables},
  ...(alternatives[row.kind] ? [{candidate:alternatives[row.kind],tables:census.createdTables(alternatives[row.kind])}] : [])]]));
for (const [kind,candidate] of Object.entries({lifecycle:require('../tenant-lifecycle/postgres-candidate.json'),
  suppression:require('../../migrations/candidates/postgres-alarm-suppression-v1.json'),outbox:require('../tenant-notifications/postgres-candidate.json'),
  ensure_ledger:require('./ensure-candidate.json')})) families[kind] = [{candidate,tables:census.createdTables(candidate)}];
families.registry = [{candidate:require('./postgres-candidate.json'),tables:require('./provision-residue').tables.registry}];
for (const choices of Object.values(families)) choices.forEach((choice,index) => { choice.id = index === 0 ? 'canonical' : 'socket-order'; });
const kinds = Object.keys(families).sort();
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const validName = value => typeof value === 'string' && NAME.test(value) && !value.startsWith('pg_') && !['public','information_schema'].includes(value);
const q = value => { if (!validName(value)) throw new TypeError('Explicit dependency namespace required'); return '"'+value+'"'; };
const fail = () => { throw Object.assign(new Error('TENANT_PROVISION_DEPENDENCIES_UNPREPARED'),{code:'TENANT_PROVISION_DEPENDENCIES_UNPREPARED'}); };
const schema = {type:'object',additionalProperties:false,required:kinds,properties:Object.fromEntries(kinds.map(kind => [kind,
  {type:'array',maxItems:8,items:{type:'object',additionalProperties:false,required:['namespace','catalogue'],properties:{
    namespace:{type:'string',pattern:'^[a-z][a-z0-9_]{0,62}$'},catalogue:{type:'string',enum:families[kind].map(c=>c.id)}}}}]))};
const primary = {registry:'registry',legacy:'legacy',secrets:'secrets',authorization:'authorization',access:'access',clock:'clock',control:'lifecycle',settings:'tenant_settings',operatorPolicy:'operator_policy'};
function prepare (mapping,namespaces,ledgerNamespace,checkpoints=[]) {
  if (mapping === undefined) return null;
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || Object.keys(mapping).sort().join(',') !== kinds.join(',')) fail();
  const used = new Set(), normalized = {};
  for (const kind of kinds) {
    const names = mapping[kind];
    if (!Array.isArray(names) || names.length > 8 || names.some(n => !n || Object.keys(n).sort().join(',') !== 'catalogue,namespace' || !validName(n.namespace) || used.has(n.namespace) || !families[kind].some(c=>c.id===n.catalogue))) fail();
    if (new Set(names.map(n=>n.namespace)).size !== names.length) fail();
    names.forEach(n => used.add(n.namespace)); normalized[kind] = Object.freeze(names.map(n=>Object.freeze({namespace:n.namespace,catalogue:n.catalogue})).sort((a,b)=>a.namespace.localeCompare(b.namespace)));
  }
  if (used.size > 64) fail();
  for (const [key,kind] of Object.entries(primary)) if (!normalized[kind].some(n=>n.namespace===namespaces[key])) fail();
  if (!normalized.ensure_ledger.some(n=>n.namespace===ledgerNamespace) || checkpoints.some(row => !normalized.checkpoint.some(n=>n.namespace===row.namespace))) fail();
  const digest = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  return Object.freeze({mapping:Object.freeze(normalized),digest});
}
function grantReads (prepared,role) {
  if (!prepared) return [];
  const result = [];
  for (const kind of kinds) for (const selected of prepared.mapping[kind]) {
    const ns = selected.namespace, choice = families[kind].find(c=>c.id===selected.catalogue);
    result.push('GRANT USAGE ON SCHEMA '+q(ns)+' TO '+q(role),'GRANT SELECT (name,checksum) ON '+q(ns)+'.schema_migrations TO '+q(role));
    for (const table of choice.tables) result.push('GRANT SELECT (tenant_id'+(kind==='ensure_ledger'?',phase,registered':'')+') ON '+q(ns)+'.'+q(table)+' TO '+q(role));

  }
  return result;
}
async function prove (client,prepared,tenant) {
  if (!prepared) fail();
  const role = (await client.query('SELECT /* ensure-dependency-role */ rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname=current_user')).rows[0];
  if (!role || ['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication'].some(k=>role[k]!==false)) fail();
  const relations = new Map();
  for (const kind of kinds) for (const selected of prepared.mapping[kind]) {
    const namespace = selected.namespace, choice = families[kind].find(c=>c.id===selected.catalogue), max = choice.candidate.migrations.length;
    const actual = (await client.query('SELECT /* ensure-dependency-ledger */ CASE WHEN octet_length(name)<=256 THEN name END AS name,CASE WHEN octet_length(checksum)=64 THEN checksum END AS checksum FROM '+q(namespace)+'.schema_migrations ORDER BY name LIMIT '+(max+1))).rows;
    if (JSON.stringify(actual.map(r=>[r.name,r.checksum]))!==JSON.stringify(validateCatalogue(choice.candidate).map(m=>[m.name,m.checksum]))) fail();
    for (const table of choice.tables) relations.set(namespace+'.'+table,{kind,namespace,table});
  }
  // Metadata only, bounded one unknown relation; no tenant data/roster scan.
  const unknown = (await client.query(`SELECT /* ensure-dependency-unknown */ n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p','f','m','v') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attname='tenant_id')
    AND NOT ((n.nspname||'.'||c.relname)=ANY($1::text[])) LIMIT 1`,[[...relations.keys()]])).rows;
  if (unknown.length) fail();
  for (const [name,row] of relations) {
    const metadata = (await client.query(`SELECT /* ensure-dependency-relation */ c.oid::text AS oid,a.atttypid='uuid'::regtype AS uuid,a.attnotnull,
      c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,pg_has_role(current_user,c.relowner,'MEMBER') AS owns,
      r.rolcanlogin,r.rolsuper,r.rolbypassrls,
      ${require('../storage/tenant-policy-contract').binds('c.oid', '$2')} AS binds,
      EXISTS(SELECT 1 FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_am am ON am.oid=ic.relam
        WHERE i.indrelid=c.oid AND i.indisvalid AND i.indisready AND i.indislive AND i.indpred IS NULL AND i.indexprs IS NULL
        AND am.amname='btree' AND i.indkey[0]=a.attnum AND i.indclass[0]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='uuid_ops' AND opcmethod=am.oid)) AS indexed
      FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped
      WHERE c.oid=to_regclass($1) LIMIT 2`,[name,"(tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)"])).rows;
    const m = metadata[0], globalHost = row.kind==='registry' && row.table==='tenant_registry_hosts';
    if (metadata.length!==1 || m.relkind!=='r' || m.relpersistence!=='p' || !globalHost && m.binds!==true || m.uuid!==true || m.attnotnull!==true || m.owns!==false || m.rolcanlogin!==false || m.rolsuper!==false || m.rolbypassrls!==false ||
      m.relrowsecurity!==!globalHost || m.relforcerowsecurity!==!globalHost) fail();
    row.indexed = m.indexed === true;
    if (!row.indexed) {
      const fks = (await client.query(`SELECT /* ensure-dependency-fk */ k.convalidated,
        pn.nspname AS parent_namespace,p.relname AS parent_table,
        ARRAY(SELECT a.attname FROM unnest(k.conkey) WITH ORDINALITY x(attnum,ord) JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.attnum ORDER BY x.ord) AS child_columns,
        ARRAY(SELECT a.attname FROM unnest(k.confkey) WITH ORDINALITY x(attnum,ord) JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=x.attnum ORDER BY x.ord) AS parent_columns,
        (SELECT bool_and(a.attnotnull) FROM unnest(k.conkey) x(attnum) JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.attnum) AS child_not_null
        FROM pg_constraint k JOIN pg_class p ON p.oid=k.confrelid JOIN pg_namespace pn ON pn.oid=p.relnamespace
        WHERE k.contype='f' AND k.conrelid=to_regclass($1) LIMIT 17`,[name])).rows;
      if (fks.length>16) fail();
      row.parents = fks.filter(f=>f.convalidated===true && f.child_not_null===true && Array.isArray(f.child_columns) && Array.isArray(f.parent_columns) &&
        f.child_columns.indexOf('tenant_id')>=0 && f.parent_columns[f.child_columns.indexOf('tenant_id')]==='tenant_id')
        .map(f=>f.parent_namespace+'.'+f.parent_table).filter(parent=>relations.has(parent));
      if (!row.parents.length) fail();
    }
  }
  const empty = new Set(), visiting = new Set();
  async function absent (name) {
    if (empty.has(name)) return;
    if (visiting.has(name)) fail(); visiting.add(name);
    const row = relations.get(name);
    if (row.indexed) {
      const where = row.kind==='ensure_ledger' ? " AND phase='result' AND registered" : '';
      const found = (await client.query('SELECT /* ensure-dependency-residue */ EXISTS(SELECT 1 FROM '+q(row.namespace)+'.'+q(row.table)+' WHERE tenant_id=$1'+where+' LIMIT 1) AS present',[tenant])).rows[0];
      if (found?.present!==false) throw Object.assign(new Error('TENANT_PROVISION_INCOMPLETE'),{code:'TENANT_PROVISION_INCOMPLETE'});
    } else {
      // A validated non-null tenant-preserving FK cannot have a child when
      // an admitted indexed ancestor has no parent for this tenant.
      await absent(row.parents[0]);
    }
    visiting.delete(name); empty.add(name);
  }
  for (const name of relations.keys()) await absent(name);
  return prepared.digest;
}
module.exports = {schema,prepare,prove,grantReads,families,kinds};
