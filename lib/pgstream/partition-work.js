'use strict';
const {version}=require('./work-state');
const {createHash}=require('node:crypto');
const OWNER_DOMAIN='nightscout:pgstream-evaluator-owner:v2:';
const NAME=/^[a-z][a-z0-9_]{0,62}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function configure(value,{namespace,consumer,intakeProfile,predecessorProfile}){
 if(value===undefined)return null;
 const profile=intakeProfile===undefined?null:require('../tenant-lifecycle/generation-domain').recognize(intakeProfile),pool=!!profile&&require('../tenant-lifecycle/generation-domain').isPool(profile);
 if(!value||Object.keys(value).sort().join(',')!=='assignment,currentGeneration,lifecycleNamespace,membershipNamespace,self'||typeof value.currentGeneration!=='function'||[value.membershipNamespace,value.lifecycleNamespace].some(name=>typeof name!=='string'||!NAME.test(name)||name.startsWith('pg_')||['public','information_schema'].includes(name))||typeof value.assignment?.owner!=='function'||typeof value.assignment?.select!=='function'||!value.self||!Number.isInteger(value.self.ordinal)||value.self.ordinal<0)throw new TypeError('EVALUATOR_FIXED_PARTITION_CONFIG');
 if(pool){require('./pool-assignment').validateView(value.assignment);if(value.self.ordinal>=require('../pool-membership/slice').MAX_MEMBERS||value.self.memberId!==null&&!UUID.test(value.self.memberId))throw new TypeError('EVALUATOR_FIXED_PARTITION_CONFIG');}
 else if(![1,2].includes(value.assignment.members)||typeof value.assignment.revision!=='string'||!UUID.test(value.self.memberId)||value.self.ordinal>=value.assignment.members)throw new TypeError('EVALUATOR_FIXED_PARTITION_CONFIG');
 const supplied=value.assignment,assignment=profile&&!pool?profile.assignment:supplied,self=Object.freeze({...value.self}),currentGeneration=value.currentGeneration,membershipNamespace=value.membershipNamespace,lifecycleNamespace=value.lifecycleNamespace;
 if(profile){const b=profile.binding;if(b.namespace!==namespace||b.consumer!==consumer||b.membershipNamespace!==membershipNamespace||b.lifecycleNamespace!==lifecycleNamespace||!pool&&(b.revision!==supplied.revision||b.members!==supplied.members||JSON.stringify(b.tenants)!==JSON.stringify(supplied.tenants)))throw new Error('PGSTREAM_INTAKE_WORKER_PROFILE');}
 const fixedRevision=pool?null:version(assignment.revision);if(fixedRevision==='0')throw new TypeError('EVALUATOR_FIXED_PARTITION_CONFIG');
 const revision=()=>fixedRevision??assignment.revision;
 const key=createHash('sha256').update(OWNER_DOMAIN+namespace+':'+consumer+':'+self.ordinal).digest().readBigInt64BE(0).toString();
 function check(row){if(row.work_owner_ordinal!==self.ordinal||row.work_assignment_revision!==revision())throw new Error('EVALUATOR_PARTITION_ASSIGNMENT_REFUSED');return row;}
 function tenant(id){if(assignment.owner(id)!==self.ordinal)throw new Error('EVALUATOR_PARTITION_FOREIGN_TENANT');}
 function filter(values){return {sql:' AND work_owner_ordinal=$'+(values.length+1)+' AND work_assignment_revision=$'+(values.length+2)+'::bigint',values:[...values,self.ordinal,revision()]};}
 async function open(connection,owner){
  if(typeof owner.withTenantTransaction!=='function')throw new Error('EVALUATOR_PARTITION_OWNER_BOUNDARY_REQUIRED');
  if(pool)await require('./pool-worker-grants').assertReady(connection.readOnly.bind(connection),{profile,ordinal:self.ordinal});
  else await require('./worker-grants').assertReady(connection.readOnly.bind(connection),{namespace,consumer,assignment,ordinal:self.ordinal,membershipNamespace});
  await require('./assignment-protocol').assertInstalled(connection.readOnly.bind(connection),{namespace,membershipNamespace,lifecycleNamespace,...(pool?{poolProfile:profile,poolIntake:true,predecessorProfile}:{intakeProfile})});
  const query=connection.query.bind(connection),guard=pool?await require('./pool-effect-fence').open({query:connection.readOnly.bind(connection),profile,assignment,self,backendPid:owner.backendPid}):await require('./effect-fence').open({query:connection.readOnly.bind(connection),namespace:membershipNamespace,assignment,self,backendPid:owner.backendPid});
  async function start(id,restore,operation='complete'){
   if(!['complete','ack'].includes(operation))throw new Error('EVALUATOR_PARTITION_OPERATION');
   tenant(id);const admitted=await guard.admit(query,id),generation=version(currentGeneration(id));
   if(generation==='0'||restore!==undefined&&(restore===null||version(restore)!==generation))throw new Error('EVALUATOR_PARTITION_RESTORE_REFUSED');
   const context=Object.freeze({tenant:id,consumer:consumer+'-completed',ordinal:self.ordinal,memberId:self.memberId,revision:revision(),backendPid:admitted.backendPid,transactionId:admitted.transactionId,restoreGeneration:generation,operation,...(pool?{partitioned:admitted.partitioned}: {})});
   await query("SELECT set_config('app.pgstream_partition_effect',$1,true)",[JSON.stringify(context)]);return context;
  }
  async function finish(context){
   const admitted=await guard.admit(query,context.tenant);
   if(admitted.backendPid!==context.backendPid||admitted.transactionId!==context.transactionId||version(currentGeneration(context.tenant))!==context.restoreGeneration||pool&&(revision()!==context.revision||admitted.partitioned!==context.partitioned))throw new Error('EVALUATOR_PARTITION_FINAL_FENCE');
  }
  return Object.freeze({start,finish});
 }
 return Object.freeze({key,ordinal:self.ordinal,get revision(){return revision();},check,tenant,filter,open,select:',work_owner_ordinal,work_assignment_revision::text AS work_assignment_revision'});
}
module.exports={configure,OWNER_DOMAIN};
