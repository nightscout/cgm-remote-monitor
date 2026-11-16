'use strict';
// A current selection snapshot. SQL membership/effect fences remain authority.
const {RULE,bucket,shape}=require('../pool-membership/slice');
const {assess}=require('../pool-membership/assess');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const genuine=new WeakSet();
function create(value){
 if(!value||Object.keys(value).sort().join(',')!=='members,revision,tenants')throw new TypeError('PGSTREAM_POOL_ASSIGNMENT');
 const members=value.members,revision=value.revision,source=value.tenants,length=Array.isArray(source)?source.length:null;
 shape(members,0);
 if(typeof revision!=='string'||!/^[1-9][0-9]{0,18}$/.test(revision)||BigInt(revision)>9223372036854775807n||!Array.isArray(source)||!Number.isSafeInteger(length)||length>10000)throw new TypeError('PGSTREAM_POOL_ASSIGNMENT');
 const tenants=[];for(let i=0;i<length;i++){const id=source[i];if(typeof id!=='string'||!UUID.test(id))throw new TypeError('PGSTREAM_POOL_ASSIGNMENT');tenants.push(id);}
 if(new Set(tenants).size!==tenants.length)throw new TypeError('PGSTREAM_POOL_ASSIGNMENT');
 tenants.sort();Object.freeze(tenants);const known=new Set(tenants),slices=Array.from({length:members},()=>[]);
 for(const id of tenants)slices[bucket(id,members)].push(id);slices.forEach(Object.freeze);
 function owner(id){if(!known.has(id))throw new Error('PGSTREAM_POOL_TENANT_UNKNOWN');return bucket(id,members);}
 function select({self,rows,desired}){
  const refused=reason=>Object.freeze({eligible:false,reason,tenants:Object.freeze([])});
  if(!self||!UUID.test(self.memberId)||self.rule!==RULE||!Number.isSafeInteger(self.ordinal)||self.ordinal<0||self.ordinal>=members||!Array.isArray(rows)||rows.some(row=>!row||!UUID.test(row.memberId)||!Number.isSafeInteger(row.ordinal)||typeof row.live!=='boolean'))return refused('PGSTREAM_POOL_MEMBERSHIP_SHAPE');
  if(!desired||desired.members!==members||desired.revision!==revision||desired.rule!==RULE)return refused('PGSTREAM_POOL_ASSIGNMENT_CHANGED');
  const verdict=assess(self,rows,desired);if(!verdict.eligible)return refused(verdict.reason);
  if(verdict.switching||verdict.missingOrdinals.length||rows.some(row=>row.live&&(row.ordinal<0||row.ordinal>=members||row.appliedMembers!==members)))return refused('PGSTREAM_POOL_MEMBERSHIP_INCOMPLETE');
  const selected=slices[self.ordinal],included=new Set(selected);
  return Object.freeze({eligible:true,reason:null,members,revision,ordinal:self.ordinal,tenants:selected,includes:id=>included.has(id)});
 }
 const result=Object.freeze({rule:RULE,members,revision,tenants,owner,select});genuine.add(result);return result;
}
function validate(value){if(!genuine.has(value))throw new TypeError('PGSTREAM_POOL_ASSIGNMENT_SOURCE_REQUIRED');return value;}
module.exports={create,validate};
