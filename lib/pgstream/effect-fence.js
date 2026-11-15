'use strict';
// Fixed-partition admission prototype, not wired into startup. Database mutation
// triggers must reject every writer that omits the cohort exclusive lock.
const transactionLock=require('../pool-membership/transaction-lock');
function create({namespace,assignment,self,backendPid}){
 if(typeof namespace!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(namespace)||namespace.startsWith('pg_')||typeof assignment?.select!=='function'||typeof assignment?.owner!=='function'||!self||!Number.isSafeInteger(backendPid)||backendPid<1)throw new TypeError('PGSTREAM_EFFECT_FENCE_CONFIG');
 self=Object.freeze({...self});
 const desired='"'+namespace+'".pool_desired',members='"'+namespace+'".pool_membership';
 const identity=row=>row&&row.backend_pid===backendPid&&typeof row.transaction_id==='string'&&/^[0-9]+$/.test(row.transaction_id);
 return Object.freeze({async admit(query,tenant){
   if(typeof query!=='function')throw new TypeError('PGSTREAM_EFFECT_TRANSACTION_REQUIRED');
   if(assignment.owner(tenant)!==self.ordinal)throw new Error('PGSTREAM_EFFECT_FOREIGN_TENANT');
   const lock=await transactionLock.lock(query,namespace,'evaluator',true);
   if(!identity(lock))throw new Error('PGSTREAM_EFFECT_OWNER_TRANSACTION');
   const locked=(await query('SELECT members,previous_members AS "previousMembers",slice_rule AS rule,revision::text AS revision,pg_backend_pid() AS backend_pid,pg_current_xact_id()::text AS transaction_id FROM '+desired+' WHERE pool_kind=$1',['evaluator'])).rows;
   if(locked.length!==1||!identity(locked[0])||locked[0].transaction_id!==lock.transaction_id)throw new Error('PGSTREAM_EFFECT_OWNER_TRANSACTION');
   const row=(await query(`SELECT pg_backend_pid() AS backend_pid,pg_current_xact_id()::text AS transaction_id,
     (SELECT coalesce(json_agg(json_build_object('ordinal',ordinal,'memberId',member_id::text,'rule',slice_rule,'appliedMembers',applied_members,'live',lease_expires_at>clock_timestamp()) ORDER BY ordinal,member_id),'[]'::json) FROM ${members} WHERE pool_kind=$1) AS members`,['evaluator'])).rows;
   if(row.length!==1||!identity(row[0])||row[0].transaction_id!==locked[0].transaction_id)throw new Error('PGSTREAM_EFFECT_OWNER_TRANSACTION');
   const verdict=assignment.select({self,rows:row[0].members,desired:locked[0]});
   if(!verdict.eligible||!verdict.includes(tenant))throw new Error('PGSTREAM_EFFECT_MEMBERSHIP_REFUSED');
   return verdict;
 }});
}
async function open(options){await require('../pool-membership/fixed-protocol').assertInstalled(options.query,options.namespace);return create(options);}
module.exports={open};
