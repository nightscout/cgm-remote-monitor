'use strict';
const lock=require('../pool-membership/transaction-lock'),views=require('./pool-assignment');
async function open({query,profile,assignment,self,backendPid}){
 profile=require('./pool-intake-profile').validate(profile);views.validateView(assignment);
 if(typeof query!=='function'||!self||!Number.isSafeInteger(backendPid)||backendPid<1)throw new TypeError('PGSTREAM_POOL_EFFECT_FENCE');
 await require('../pool-membership/pool-candidate').assertInstalled(query,profile.binding.membershipNamespace);
 return Object.freeze({async admit(run,tenant){
  if(assignment.owner(tenant)!==self.ordinal)throw new Error('PGSTREAM_EFFECT_FOREIGN_TENANT');
  const identity=await lock.lock(run,profile.binding.membershipNamespace,'evaluator',true);
  const valid=row=>row&&row.backend_pid===backendPid&&row.transaction_id===identity.transaction_id;
  if(identity.backend_pid!==backendPid)throw new Error('PGSTREAM_EFFECT_OWNER_TRANSACTION');
  const desired=(await run('SELECT members,previous_members AS "previousMembers",partitioned,previous_partitioned AS "previousPartitioned",slice_rule AS rule,revision::text AS revision,pg_backend_pid() AS backend_pid,pg_current_xact_id()::text AS transaction_id FROM "'+profile.binding.membershipNamespace+'".pool_desired WHERE pool_kind=$1',['evaluator'])).rows;
  const rows=(await run('SELECT pg_backend_pid() AS backend_pid,pg_current_xact_id()::text AS transaction_id,(SELECT coalesce(json_agg(json_build_object(\'ordinal\',ordinal,\'memberId\',member_id::text,\'rule\',slice_rule,\'appliedMembers\',applied_members,\'live\',lease_expires_at>clock_timestamp()) ORDER BY ordinal,member_id),\'[]\'::json) FROM "'+profile.binding.membershipNamespace+'".pool_membership WHERE pool_kind=$1) AS members',['evaluator'])).rows;
  if(desired.length!==1||rows.length!==1||!valid(desired[0])||!valid(rows[0]))throw new Error('PGSTREAM_EFFECT_OWNER_TRANSACTION');
  const verdict=assignment.select({self,rows:rows[0].members,desired:desired[0]});if(!verdict.eligible||!verdict.includes(tenant))throw new Error('PGSTREAM_EFFECT_MEMBERSHIP_REFUSED');
  return Object.freeze({...verdict,backendPid,transactionId:identity.transaction_id});
 }});
}
module.exports={open};
