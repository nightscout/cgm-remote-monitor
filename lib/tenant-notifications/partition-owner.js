'use strict';
const {createHash}=require('node:crypto');
const {version}=require('../pgstream/work-state');
const candidate=require('./partition-candidate');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function configure(value,namespace,{predecessorProfile}={}){
 if(value===undefined)return null;
 candidate.quote(namespace);
 const pool=value?.intakeProfile?.binding?.protocol==='pgstream-pool-intake-v2';
 const keys='assignment,checkpointNamespace,consumer,currentGeneration,evaluatorConsumer,lifecycleNamespace,membershipNamespace,self',profileKeys=keys.split(',').concat('intakeProfile').sort().join(',');
 if(!value||![keys,profileKeys].includes(Object.keys(value).sort().join(','))||typeof value.currentGeneration!=='function'||typeof value.assignment?.select!=='function'||typeof value.assignment?.owner!=='function'||(!pool&&![1,2].includes(value.assignment.members))||!value.self||!(typeof value.self.memberId==='string'&&value.self.memberId===value.self.memberId.trim()&&UUID.test(value.self.memberId)||pool&&value.self.memberId===null)||!Number.isInteger(value.self.ordinal)||value.self.ordinal<0||value.self.ordinal>=(pool?require('../pool-membership/slice').MAX_MEMBERS:value.assignment.members))throw new TypeError('NOTIFICATION_PARTITION_CONFIG');
 const binding=candidate.bindings(Object.fromEntries(['checkpointNamespace','consumer','evaluatorConsumer','lifecycleNamespace','membershipNamespace'].map(key=>[key,value[key]])));
 const intakeProfile=Object.hasOwn(value,'intakeProfile')?(pool?require('../pgstream/pool-intake-profile'):require('../pgstream/intake-profile')).validate(value.intakeProfile):undefined;
 const supplied=value.assignment,assignment=pool?require('../pgstream/pool-assignment').validateView(supplied):intakeProfile?intakeProfile.assignment:supplied;
 if(intakeProfile){const b=intakeProfile.binding;if(b.namespace!==binding.checkpointNamespace||b.consumer+'-completed'!==binding.evaluatorConsumer||b.lifecycleNamespace!==binding.lifecycleNamespace||b.membershipNamespace!==binding.membershipNamespace||!pool&&(b.revision!==supplied.revision||b.members!==supplied.members||JSON.stringify(b.tenants)!==JSON.stringify(supplied.tenants)))throw new Error('NOTIFICATION_INTAKE_PROFILE_BINDING');}
 const self=Object.freeze({...value.self}),currentGeneration=value.currentGeneration,revision=pool?null:version(assignment.revision);
 if(!pool&&(typeof assignment.revision!=='string'||revision==='0'))throw new TypeError('NOTIFICATION_PARTITION_REVISION');
 const key=createHash('sha256').update(candidate.OWNER_DOMAIN+namespace+':'+binding.consumer+':'+self.ordinal).digest().readBigInt64BE(0).toString();
 const catalogue=(pool?require('./pool-partition-candidate').build({binding,intakeProfile}):candidate.build(binding)).catalogue;
 let owner,guard,closed=false,lost=false;
 const available=()=>!closed&&!lost&&owner?.available===true;
 const queryOf=connection=>connection.query.bind(connection);
 async function own(connection,onLoss=()=>{}){
  if(owner||closed||typeof onLoss!=='function')throw new Error('NOTIFICATION_PARTITION_OWNER_STATE');
  owner=await connection.holdAdvisoryLock(key,()=>{if(lost)return;lost=true;try{Promise.resolve(onLoss()).catch(()=>{});}catch{ /* Local admission is already withdrawn. */ }});
  try{
   if(typeof owner.withTenantTransaction!=='function')throw new Error('NOTIFICATION_PARTITION_COMMIT_BOUNDARY_REQUIRED');
   const read=connection.readOnly.bind(connection);
   await require('./partition-grants').assertReady(read,binding,pool?intakeProfile:undefined);
   await require('./partition-protocol').assertInstalled(read,namespace,binding,pool?intakeProfile:undefined);
   await require('../pgstream/assignment-protocol').assertInstalled(read,{namespace:binding.checkpointNamespace,membershipNamespace:binding.membershipNamespace,lifecycleNamespace:binding.lifecycleNamespace,...(pool?{poolProfile:intakeProfile,poolIntake:true,predecessorProfile}:{intakeProfile})});
   guard=await (pool?require('../pgstream/pool-effect-fence'):require('../pgstream/effect-fence')).open({query:read,namespace:binding.membershipNamespace,...(pool?{profile:intakeProfile}:{}),assignment,self,backendPid:owner.backendPid});
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
  const current=pool?assignment.snapshot():null,currentRevision=pool?current.revision:revision;
  const admission=await guard.admit(query,id);
  const rows=(await query('SELECT work_owner_ordinal,work_assignment_revision::text AS work_assignment_revision FROM "'+binding.checkpointNamespace+'".tenant_consumer_checkpoint WHERE tenant_id=$1 AND consumer=$2',[id,binding.evaluatorConsumer])).rows;
  if(rows.length!==1||rows[0].work_owner_ordinal!==self.ordinal||rows[0].work_assignment_revision!==currentRevision)throw new Error('NOTIFICATION_PARTITION_ASSIGNMENT_REFUSED');
  const generation=version(currentGeneration(id));if(generation==='0')throw new Error('NOTIFICATION_PARTITION_RESTORE_REFUSED');
  return Object.freeze({tenant:id,consumer:binding.consumer,ordinal:self.ordinal,memberId:self.memberId,revision:currentRevision,...(pool?{partitioned:current.partitioned}:{}),backendPid:admission.backendPid,transactionId:admission.transactionId,restoreGeneration:generation});
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
