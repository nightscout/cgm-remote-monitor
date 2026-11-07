'use strict';
// Catalog protocol double: no claim about PostgreSQL parser/RLS enforcement.
const {layouts,constraints,policiesFor} = require('../../lib/tenant-lifecycle/operation-window-readiness');
const migrations = require('../../lib/tenant-lifecycle/postgres-candidate.json').migrations;
module.exports = function protocol (mutate = () => {}) {
  let lifetime = false, maintenance = false;
  return (sql,values) => {
    let rows, kind;
    if (sql.includes('operation-window-role')) {
      lifetime = sql.includes('lifetime'); maintenance = sql.includes('maintenance'); kind='role'; rows=[{namespace_oid:40,owner_oid:39,uses_schema:true,elevated:false,owns_schema:false,database_create:false,elevated_membership:false,schema_writes:false,foreign_writes:false,foreign_functions:false}];
    } else if (sql.includes('operation-window-table')) {
      kind=values[0].split('.').at(-1); const op=kind==='tenant_lifecycle_operations', audit=kind==='tenant_lifecycle_restore_audit', privateTable=audit||kind==='tenant_lifecycle_restore_authority';
      rows=[{owner_oid:39,dropped:false,oid:Object.keys(layouts).indexOf(kind)+41,kind:'r',persistence:'p',secured:kind!=='schema_migrations',owns:false,reads:privateTable?maintenance:true,owner_safe:true,broad_writes:false,triggers:false,rules:false,inherited:false,bad_indexes:false,
        columns:layouts[kind].map(([name,type,not_null,expression]) => ({name,type,not_null,identity:'',generated:'',default:expression||null,inserts:!!(op&&lifetime&&['tenant_id','operation_id','generation'].includes(name)||audit&&maintenance&&['tenant_id','claim_id','generation','artifact_digest'].includes(name)),updates:!!(op&&lifetime&&name==='finished'||kind==='tenant_lifecycle_windows'&&maintenance&&['phase','generation','claim_id','artifact_digest'].includes(name)||audit&&maintenance&&['state','restored_at','activated_at'].includes(name))})),
        constraints:constraints[kind].map(definition=>({definition,valid:true,deferrable:false})),
        policies:policiesFor(kind).map(p=>({...p,roles:[0],permissive:true}))}];
    } else if(sql.includes('operation-window-function')) {
      kind='function';rows=[{oid:44,owner_oid:39,prosecdef:false,provolatile:'s',proretset:false,pronargs:0,result:'timestamp with time zone',prosrc:'SELECT backend_start FROM pg_catalog.pg_stat_activity WHERE pid = pg_catalog.pg_backend_pid()',proconfig:['search_path=pg_catalog'],lanname:'sql',owner_safe:true,owns:false,executes:lifetime||maintenance,public_executes:false}];
    } else if(sql.includes('operation-window-ledger')) { kind='ledger';rows=migrations.map(({name,checksum})=>({name,checksum})); }
    else return null;
    mutate(kind,rows,lifetime);return {rows};
  };
};
