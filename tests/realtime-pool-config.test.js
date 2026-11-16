'use strict';
const assert=require('node:assert/strict');
const profiles=require('../lib/pgstream/pool-intake-profile'),legacy=require('../lib/pgstream/intake-profile');
const parse=require('../lib/server/realtime/config').parse,fixture=require('./fixtures/realtime-completed-config');
function input(){
 const f=fixture(),v=f.value,p=profiles.create({namespace:v.completedOutput.namespace,membershipNamespace:'rt_pool',lifecycleNamespace:v.activity.namespace,role:'rt_intake',operatorRole:'rt_pool_operator',consumer:v.completedOutput.consumer,codec:profiles.CODEC,generationDomain:profiles.GENERATION_DOMAIN,sliceRule:require('../lib/pool-membership/slice').RULE});
 return {...f,p};
}
describe('pure shared-pool realtime config provenance',()=>{
 it('keeps the default parser and accepts infrastructure-only v2 without a frozen tenant roster or revision',()=>{
  const f=input();assert.equal(parse(f.value,f.source).intakeProfile,undefined);f.value.intakeProfile=JSON.parse(JSON.stringify(f.p));
  const selected=parse(f.value,f.source);assert.equal(selected.intakeProfile.digest,f.p.digest);assert.equal(selected.intakeProfile.binding.tenants,undefined);assert.equal(selected.intakeProfile.binding.revision,undefined);assert.equal(selected.tenants.size,0);
 });
 it('keeps selected-v1 ledger provenance outside the immutable v2 profile and validates its exact layout',()=>{
  const f=input(),b=f.p.binding,old=legacy.create({namespace:b.namespace,membershipNamespace:b.membershipNamespace,lifecycleNamespace:b.lifecycleNamespace,role:'retired_intake',consumer:b.consumer,codec:b.codec,generationDomain:b.generationDomain,members:2,revision:'7',tenants:['11111111-1111-4111-8111-111111111111']});
  f.value.intakeProfile=f.p;f.value.predecessorProfile=old;const selected=parse(f.value,f.source);assert.equal(selected.intakeProfile,f.p);assert.equal(selected.predecessorProfile.digest,old.digest);assert(!Object.hasOwn(selected.intakeProfile.binding,'predecessorProfile'));
  const foreign=legacy.create(Object.fromEntries(['namespace','membershipNamespace','lifecycleNamespace','role','consumer','codec','generationDomain','members','revision','tenants'].map(key=>[key,key==='namespace'?'foreign_work':old.binding[key]])));assert.throws(()=>parse({...f.value,predecessorProfile:foreign},f.source));
 });
 it('rejects orphan lineage, foreign selected source and unsupported profile protocols',()=>{
  const f=input();assert.throws(()=>parse({...f.value,predecessorProfile:{}},f.source));assert.throws(()=>parse({...f.value,intakeProfile:{...f.p,binding:{...f.p.binding,namespace:'foreign_work'}}},f.source));assert.throws(()=>parse({...f.value,intakeProfile:{...f.p,binding:{...f.p.binding,protocol:'future-unknown'}}},f.source));
 });
});
