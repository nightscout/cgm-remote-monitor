'use strict';
// Fixed tenant ownership. Changing the roster requires a process restart;
// there is no membership service, expiry lease or implicit takeover.
const {createHash}=require('node:crypto');
const {version}=require('./work-state');
const slice=require('../pool-membership/slice');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Receiver order is the ordinal contract, never URL sorting.
function processProfile(text, receiver) {
 if(text===undefined)return undefined;
 const refuse=()=>{throw new TypeError('EVALUATOR_PROCESS_ASSIGNMENT_CONFIG');};
 let value;try{if(typeof text!=='string'||Buffer.byteLength(text)>131072)refuse();value=JSON.parse(text);}catch{refuse();}
 if(!value||Object.keys(value).sort().join(',')!=='count,ordinal,receivers'||!Array.isArray(value.receivers)||value.receivers.length!==value.count)refuse();
 try{slice.shape(value.count,value.ordinal);}catch{refuse();}
 const receivers=value.receivers.map(url=>{
  if(typeof url!=='string')refuse();
  try{const parsed=new URL(url);require('../server/internal-api/transport').options({...receiver,url});if(parsed.href!==url||parsed.pathname!=='/'||Number(parsed.port)<1024)refuse();return parsed.href;}catch{refuse();}
 });
 if(new Set(receivers).size!==receivers.length||receivers[value.ordinal]!==new URL(receiver.url).href)refuse();
 return Object.freeze({count:value.count,ordinal:value.ordinal,receivers:Object.freeze(receivers)});
}
// Decision statefulset-ordinal-scaling: an evaluator's ordinal is the trailing
// number of its hostname (StatefulSet Pod evaluator-3, or Compose hostname
// evaluator-3) and K is NS_EVALUATOR_SLICES. Receiver i is the StatefulSet DNS
// name <base>-<i>.<base> on the configured receiver port; the roster is K
// receivers. K unset or 1 is the unsliced single evaluator. An ordinal at or
// above K is not refused: it owns no tenant and has no receiver in the roster.
const HOST=/^([a-z][a-z0-9-]{0,40}?)-(0|[1-9][0-9]{0,3})$/;
function hostAssignment(source,receiver,hostname=require('node:os').hostname()) {
 const refuse=()=>{throw new TypeError('EVALUATOR_PROCESS_ASSIGNMENT_CONFIG');};
 if(Object.hasOwn(source,'NS_PGSTREAM_EVALUATOR_SLICE'))refuse(); // retired: the slice is derived, never spliced
 const raw=source.NS_EVALUATOR_SLICES;
 if(raw===undefined||raw==='1')return undefined;
 if(typeof raw!=='string'||!/^[1-9][0-9]{0,3}$/.test(raw))refuse();
 const count=Number(raw),host=HOST.exec(String(hostname).toLowerCase());
 if(!host)refuse();
 const ordinal=Number(host[2]);
 try{slice.shape(count,0);slice.idle(count,ordinal);}catch{refuse();}
 let port;try{port=new URL(receiver.url).port;}catch{refuse();}
 const url=i=>'http://'+host[1]+'-'+i+'.'+host[1]+':'+port+'/';
 return Object.freeze({count,ordinal,receivers:Object.freeze(Array.from({length:count},(_,i)=>url(i))),receiver:url(ordinal)});
}
// One physical held resource per slice, independent of its current registry
// roster. Live registry admission filters the same immutable hash assignment.
function staticAssignment(value,{namespace,consumer}) {
 if(!value||Object.keys(value).sort().join(',')!=='currentGeneration,roster,slice'||typeof value.currentGeneration!=='function'||typeof value.roster!=='function')throw new TypeError('EVALUATOR_STATIC_ASSIGNMENT_CONFIG');
 const shape=require('../realtime-ownership').parse(value.slice),currentGeneration=value.currentGeneration,owns=slice.predicate(shape.count,shape.ordinal);
 const prefix=createHash('sha256').update(JSON.stringify(['evaluator-static-owner-v1',namespace,consumer])).digest().readUInt32BE(0);
 const packed=shape.count*slice.MAX_MEMBERS+shape.ordinal;
 const key=BigInt.asIntN(64,(BigInt(prefix)<<32n)|BigInt(packed)).toString();
 const identity=createHash('sha256').update(JSON.stringify([namespace,consumer,slice.RULE,shape])).digest('hex');
 const sql=' AND '+slice.sqlPredicate(shape.count,shape.ordinal);
 function tenant(id){if(!UUID.test(id)||!owns(id))throw new Error('EVALUATOR_ASSIGNMENT_FOREIGN_TENANT');}
 function roster(){const ids=[...value.roster()];if(new Set(ids).size!==ids.length)throw new Error('EVALUATOR_STATIC_ROSTER_REFUSED');ids.forEach(tenant);return ids.sort();}
 async function open(connection,owner){
  if(typeof owner.withTenantTransaction!=='function')throw new Error('EVALUATOR_ASSIGNMENT_OWNER_BOUNDARY');
  // The owner key is held before observation. Simultaneous differing K either
  // both refuse, or the later admission sees the existing layout and refuses.
  const markers=(await connection.readOnly("SELECT objid::text AS marker FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=$1::oid AND objsubid=1 AND granted",[String(prefix)])).rows;
  if(!markers.length||markers.some(row=>Math.floor(Number(row.marker)/slice.MAX_MEMBERS)!==shape.count))throw new Error('EVALUATOR_MIXED_LAYOUT_REFUSED');
  function assert(id,restore){tenant(id);if(!owner.available)throw new Error('EVALUATOR_OWNER_UNAVAILABLE');const generation=version(currentGeneration(id));if(generation==='0'||restore===null||version(restore)!==generation)throw new Error('EVALUATOR_ASSIGNMENT_RESTORE_REFUSED');return generation;}
  // Completion is executed by owner.withTenantTransaction on the original
  // physical backend. Losing it fails the entered transaction and COMMIT;
  // generation checks do not substitute for that process owner boundary.
  return Object.freeze({async start(id,restore){return {tenant:id,generation:assert(id,restore)};},async finish(context){assert(context.tenant,context.generation);}});
 }
 return Object.freeze({fixed:true,static:true,slice:shape,key,identity,get tenants(){return Object.freeze(roster());},tenant,select:'',check(row){tenant(row.tenant);return row;},filter(values){return {sql,values};},open});
}
// The static slice holds one advisory key per slice, so its roster has no count
// ceiling: operating limits come from measurement. The explicit list below
// holds one session advisory lock per tenant (holdAdvisoryLock), whose own
// key bound protects the shared PostgreSQL lock table; this check refuses an
// over-bound list at configuration rather than at owner admission.
function configure(value,{namespace,consumer}){
 if(value&&Object.hasOwn(value,'slice'))return staticAssignment(value,{namespace,consumer});
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
module.exports={configure,processProfile,hostAssignment};
