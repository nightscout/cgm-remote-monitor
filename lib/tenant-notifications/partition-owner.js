'use strict';
const {createHash}=require('node:crypto');
const {version}=require('../pgstream/work-state');
const candidate=require('./partition-candidate');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function configure(value,namespace){
 if(value===undefined)return null;
 candidate.quote(namespace);
 if(!value||Object.keys(value).sort().join(',')!=='assignment,checkpointNamespace,consumer,currentGeneration,evaluatorConsumer,lifecycleNamespace,membershipNamespace,self'||typeof value.currentGeneration!=='function'||typeof value.assignment?.select!=='function'||typeof value.assignment?.owner!=='function'||![1,2].includes(value.assignment.members)||!value.self||typeof value.self.memberId!=='string'||value.self.memberId!==value.self.memberId.trim()||!UUID.test(value.self.memberId)||!Number.isInteger(value.self.ordinal)||value.self.ordinal<0||value.self.ordinal>=value.assignment.members)throw new TypeError('NOTIFICATION_PARTITION_CONFIG');
 const binding=candidate.bindings(Object.fromEntries(['checkpointNamespace','consumer','evaluatorConsumer','lifecycleNamespace','membershipNamespace'].map(key=>[key,value[key]])));
 const self=Object.freeze({...value.self}),assignment=value.assignment,currentGeneration=value.currentGeneration,revision=version(assignment.revision);
 if(typeof assignment.revision!=='string'||revision==='0')throw new TypeError('NOTIFICATION_PARTITION_REVISION');
 const key=createHash('sha256').update(candidate.OWNER_DOMAIN+namespace+':'+binding.consumer+':'+self.ordinal).digest().readBigInt64BE(0).toString();
 const catalogue=candidate.build(binding).catalogue;
 let owner,guard,closed=false,lost=false;
 const available=()=>!closed&&!lost&&owner?.available===true;
 const queryOf=connection=>connection.query.bind(connection);
 async function own(connection,onLoss=()=>{}){
  if(owner||closed||typeof onLoss!=='function')throw new Error('NOTIFICATION_PARTITION_OWNER_STATE');
  owner=await connection.holdAdvisoryLock(key,()=>{if(lost)return;lost=true;try{Promise.resolve(onLoss()).catch(()=>{});}catch{ /* Local admission is already withdrawn. */ }});
  try{
   if(typeof owner.withTenantTransaction!=='function')throw new Error('NOTIFICATION_PARTITION_COMMIT_BOUNDARY_REQUIRED');
   const read=connection.readOnly.bind(connection);
   await require('./partition-grants').assertReady(read,binding);
   await require('./partition-protocol').assertInstalled(read,namespace,binding);
   await require('../pgstream/assignment-protocol').assertInstalled(read,{namespace:binding.checkpointNamespace,membershipNamespace:binding.membershipNamespace,lifecycleNamespace:binding.lifecycleNamespace});
   guard=await require('../pgstream/effect-fence').open({query:read,namespace:binding.membershipNamespace,assignment,self,backendPid:owner.backendPid});
  }catch(error){closed=true;await owner.close();throw error;}
 }
 function ownsTenant(id){
  const ordinal=assignment.owner(id);
  if(!Number.isInteger(ordinal)||ordinal<0||ordinal>=assignment.members)throw new Error('NOTIFICATION_PARTITION_ASSIGNMENT_REFUSED');
  return ordinal===self.ordinal;
 }
 function tenant(id){if(!ownsTenant(id))throw new Error('NOTIFICATION_PARTITION_FOREIGN_TENANT');}
 async function admitted(connection,id){
  tenant(id);const query=queryOf(connection);await owner.check();
  const admission=await guard.admit(query,id);
  const rows=(await query('SELECT work_owner_ordinal,work_assignment_revision::text AS work_assignment_revision FROM "'+binding.checkpointNamespace+'".tenant_consumer_checkpoint WHERE tenant_id=$1 AND consumer=$2',[id,binding.evaluatorConsumer])).rows;
  if(rows.length!==1||rows[0].work_owner_ordinal!==self.ordinal||rows[0].work_assignment_revision!==revision)throw new Error('NOTIFICATION_PARTITION_ASSIGNMENT_REFUSED');
  const generation=version(currentGeneration(id));if(generation==='0')throw new Error('NOTIFICATION_PARTITION_RESTORE_REFUSED');
  return Object.freeze({tenant:id,consumer:binding.consumer,ordinal:self.ordinal,memberId:self.memberId,revision,backendPid:admission.backendPid,transactionId:admission.transactionId,restoreGeneration:generation});
 }
 async function transaction(connection,id,fn){
  if(!available()||!guard)throw new Error('NOTIFICATION_PARTITION_OWNER_UNAVAILABLE');
  return owner.withTenantTransaction(id,async()=>{
   const context=await admitted(connection,id);
   await connection.query("SELECT set_config('app.pgstream_notification_effect',$1,true)",[JSON.stringify(context)]);
   const result=await fn(),fresh=await admitted(connection,id);
   if(!available()||JSON.stringify(fresh)!==JSON.stringify(context))throw new Error('NOTIFICATION_PARTITION_FINAL_FENCE');
   return result;
  });
 }
 async function beforeSend(connection,id,assertOperation){
  if(!available())return false;
  try{await transaction(connection,id,async()=>{if(assertOperation)await assertOperation();return true;});return available();}catch{return false;}
 }
 async function close(){if(closed)return;closed=true;await owner?.close();}
 return Object.freeze({key,catalogue,binding,own,transaction,beforeSend,close,tenant,ownsTenant,available});
}
module.exports={configure};
