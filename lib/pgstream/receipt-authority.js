'use strict';
// Intake holds the existing maintenance lock through SQL COMMIT, without
// requiring serving readiness or write privileges on the lifecycle catalogue.
const rules=require('../tenant-registry/rules');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function create({namespace,generation,available}){
 if(typeof namespace!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(namespace)||! /^[a-f0-9]{32}$/.test(generation)||typeof available!=='function')throw new TypeError('Explicit native receipt authority required');
 const table='"'+namespace+'".tenant_lifecycle_windows';
 return async function assert(client,tenant,{final=false}={}){
  if(!UUID.test(tenant)||!available())throw new Error('CLINICAL_STREAM_OWNER_FENCE');
  const key=rules.lockKey(tenant);
  // A write keeps two statements (decision restore-fence-read-path): the lock,
  // with the RLS tenant binding folded into it, then the authoritative
  // generation SELECT, whose READ COMMITTED snapshot starts after the lock.
  // A refused lock aborts the transaction, so its binding is never used.
  let locked;
  if(final){const number=BigInt(key);locked=(await client.query("SELECT /* commit-generation-lock */ pg_try_advisory_xact_lock_shared($1::int,$2::int) AS held,set_config('app.current_tenant_id',$3,true) AS tenant",[Number(BigInt.asIntN(32,number>>32n)),Number(BigInt.asIntN(32,number)),tenant])).rows[0]?.held;}
  else locked=(await client.query("SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS held,set_config('app.current_tenant_id',$2,true) AS tenant",[key,tenant])).rows[0]?.held;
  if(locked!==true)throw new Error('CLINICAL_STREAM_MAINTENANCE_FENCE');
  const row=(await client.query('SELECT lock_key::text AS lock_key,generation::text AS generation,phase FROM '+table+' WHERE tenant_id=$1',[tenant])).rows[0];
  if(!available()||!row||row.lock_key!==key||!['active','suspended'].includes(row.phase)||! /^[1-9][0-9]{0,18}$/.test(row.generation)||BigInt(row.generation)>9223372036854775807n)throw new Error('CLINICAL_STREAM_RESTORE_FENCE');
  return generation+':'+row.generation;
 };
}
module.exports={create};
