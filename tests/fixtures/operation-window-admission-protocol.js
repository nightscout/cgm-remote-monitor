'use strict';
// Catalog protocol double: no claim about PostgreSQL parser/RLS enforcement.
const {layouts,constraints} = require('../../lib/tenant-lifecycle/operation-window-readiness');
const migrations = require('../../lib/tenant-lifecycle/postgres-candidate.json').migrations;
const tenant = "tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid";
const owner = tenant+' AND owner_pid = pg_backend_pid() AND owner_birth = tenant_lifecycle_backend_birth()';
module.exports = function protocol (mutate = () => {}) {
  let lifetime = false;
  return (sql,values) => {
    let rows, kind;
    if (sql.includes('operation-window-role')) {
      lifetime = sql.includes('lifetime'); kind='role'; rows=[{namespace_oid:40,owner_oid:39,uses_schema:true,elevated:false,owns_schema:false,database_create:false,elevated_membership:false,schema_writes:false,foreign_writes:false,foreign_functions:false}];
    } else if (sql.includes('operation-window-table')) {
      kind=values[0].split('.').at(-1); const op=kind==='tenant_lifecycle_operations';
      rows=[{owner_oid:39,dropped:false,oid:Object.keys(layouts).indexOf(kind)+41,kind:'r',persistence:'p',secured:kind!=='schema_migrations',owns:false,reads:true,owner_safe:true,broad_writes:false,triggers:false,rules:false,inherited:false,bad_indexes:false,
        columns:layouts[kind].map(([name,type,not_null,expression]) => ({name,type,not_null,identity:'',generated:'',default:expression||null,inserts:!!(op&&lifetime&&['tenant_id','operation_id','generation'].includes(name)),updates:!!(op&&lifetime&&name==='finished')})),
        constraints:constraints[kind].map(definition=>({definition,valid:true,deferrable:false})),
        policies:kind==='schema_migrations'?[]:[{command:'r',roles:[0],permissive:true,using:tenant,check:null}]}];
      if(op) rows[0].policies.push({command:'a',roles:[0],permissive:true,using:null,check:owner+' AND finished = false'},{command:'w',roles:[0],permissive:true,using:owner+' AND finished = false',check:owner+' AND finished = true'});
    } else if(sql.includes('operation-window-function')) {
      kind='function';rows=[{oid:44,owner_oid:39,prosecdef:false,provolatile:'s',proretset:false,pronargs:0,result:'timestamp with time zone',prosrc:'SELECT backend_start FROM pg_catalog.pg_stat_activity WHERE pid = pg_catalog.pg_backend_pid()',proconfig:['search_path=pg_catalog'],lanname:'sql',owner_safe:true,owns:false,executes:lifetime,public_executes:false}];
    } else if(sql.includes('operation-window-ledger')) { kind='ledger';rows=migrations.map(({name,checksum})=>({name,checksum})); }
    else return null;
    mutate(kind,rows,lifetime);return {rows};
  };
};
