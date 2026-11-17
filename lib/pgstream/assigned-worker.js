'use strict';
// Fixed tenant ownership. Changing the roster requires a process restart;
// there is no membership service, expiry lease or implicit takeover.
const {createHash}=require('node:crypto');
const {version}=require('./work-state');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function configure(value,{namespace,consumer}){
 if(!value||Object.keys(value).sort().join(',')!=='currentGeneration,tenants'||typeof value.currentGeneration!=='function'||!Array.isArray(value.tenants)||!value.tenants.length||value.tenants.length>10000||value.tenants.some(id=>!UUID.test(id))||new Set(value.tenants).size!==value.tenants.length)throw new TypeError('EVALUATOR_ASSIGNED_WORKER_CONFIG');
 const tenants=Object.freeze([...value.tenants].sort()),roster=new Set(tenants),currentGeneration=value.currentGeneration;
 const key=Object.freeze(tenants.map(tenant=>createHash('sha256').update(JSON.stringify(['clinical-tenant-owner',namespace,consumer,tenant])).digest().readBigInt64BE(0).toString()));
 const tenantKeys=new Map(tenants.map((tenant,index)=>[tenant,key[index]]));
 const identity=createHash('sha256').update(JSON.stringify([namespace,consumer,tenants])).digest('hex');
 function tenant(id){if(!roster.has(id))throw new Error('EVALUATOR_ASSIGNMENT_FOREIGN_TENANT');}
 async function open(connection,owner){
  if(typeof owner.withTenantTransaction!=='function'||typeof owner.check!=='function')throw new Error('EVALUATOR_ASSIGNMENT_OWNER_BOUNDARY');
  async function assert(id,restore){tenant(id);await owner.check(tenantKeys.get(id));const generation=version(currentGeneration(id));if(generation==='0'||restore===null||version(restore)!==generation)throw new Error('EVALUATOR_ASSIGNMENT_RESTORE_REFUSED');return generation;}
  return Object.freeze({async start(id,restore){return {tenant:id,generation:await assert(id,restore)};},async finish(context){await assert(context.tenant,context.generation);}});
 }
 return Object.freeze({fixed:true,key,identity,tenants,tenant,select:'',check(row){tenant(row.tenant);return row;},filter(values){return {sql:' AND tenant_id=ANY($'+(values.length+1)+'::uuid[])',values:[...values,tenants]};},open});
}
module.exports={configure};
