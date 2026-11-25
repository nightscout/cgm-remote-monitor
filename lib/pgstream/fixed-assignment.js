'use strict';
// Fixed-roster selection only. This does not fence effects or renew membership.
// Callers must assess a current database snapshot in their effect transaction.
const {RULE,bucket}=require('../pool-membership/slice');
const {assess}=require('../pool-membership/assess');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function create({tenants,members,revision}){
 if(!Array.isArray(tenants)||!tenants.length||tenants.length>10000||tenants.some(id=>typeof id!=='string'||!UUID.test(id))||new Set(tenants).size!==tenants.length||![1,2].includes(members)||typeof revision!=='string'||!/^[1-9][0-9]{0,18}$/.test(revision)||BigInt(revision)>9223372036854775807n)throw new TypeError('PGSTREAM_FIXED_ASSIGNMENT_CONFIG');
 const roster=Object.freeze([...tenants].sort()),known=new Set(roster);
 const slices=Array.from({length:members},(_,ordinal)=>Object.freeze(roster.filter(id=>bucket(id,members)===ordinal)));
 function owner(tenant){if(!known.has(tenant))throw new Error('PGSTREAM_FIXED_ASSIGNMENT_TENANT');return bucket(tenant,members);}
 function select({self,rows,desired}){
   const refused=reason=>Object.freeze({eligible:false,reason,tenants:Object.freeze([])});
   if(!self||!UUID.test(self.memberId)||!Number.isInteger(self.ordinal)||self.ordinal<0||self.ordinal>=members||self.rule!==RULE||!Array.isArray(rows)||rows.some(row=>!row||!UUID.test(row.memberId)||!Number.isInteger(row.ordinal)||typeof row.live!=='boolean'))return refused('PGSTREAM_FIXED_MEMBERSHIP_SHAPE');
   if(!desired||desired.members!==members||desired.revision!==revision||desired.rule!==RULE)return refused('PGSTREAM_FIXED_ASSIGNMENT_CHANGED');
   const verdict=assess(self,rows,desired);
   if(!verdict.eligible)return refused(verdict.reason);
   // This first capability has no scale transition or missing-owner takeover.
   if(verdict.switching||verdict.missingOrdinals.length||rows.some(row=>row.live&&(row.ordinal<0||row.ordinal>=members||row.appliedMembers!==members)))return refused('PGSTREAM_FIXED_MEMBERSHIP_INCOMPLETE');
   const selected=slices[self.ordinal],included=new Set(selected);
   return Object.freeze({eligible:true,reason:null,ordinal:self.ordinal,members,revision,tenants:selected,includes:tenant=>included.has(tenant)});
 }
 return Object.freeze({rule:RULE,members,revision,tenants:roster,owner,select});
}
module.exports={create};
