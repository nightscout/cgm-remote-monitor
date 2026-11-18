'use strict';
const assert=require('node:assert/strict');
const profiles=require('../lib/pgstream/pool-intake-profile'),domain=require('../lib/tenant-lifecycle/generation-domain'),fixture=require('./fixtures/operation-window-runtime-protocol');
const A='11111111-1111-4111-8111-111111111111';
const profile=()=>profiles.create({namespace:'pool_work',membershipNamespace:'pool_members',lifecycleNamespace:'synthetic_window',role:'pool_intake',operatorRole:'pool_operator',consumer:'evaluator-pool',codec:profiles.CODEC,generationDomain:profiles.GENERATION_DOMAIN,sliceRule:require('../lib/pool-membership/slice').RULE});
function setup(eligibility='active',generation='1'){
 const windows=require('../lib/tenant-lifecycle/generation-scope'),f=fixture({lockRule:'tenant-id-sha256-v1',key:require('../lib/tenant-registry/rules').lockKey(A)},options=>windows.create({...options,intakeProfile:profile()})),query=f.client.query;
 f.client.query=async(text,values)=>{if(typeof text==='string'&&text.includes('/* pool-lifecycle-authority */'))return {rows:[{tenant:values[0],generation,phase:eligibility==='suspended'?'suspended':'active',bound:true,deletion:eligibility==='deleted'}]};return query(text,values);};return {...f,windows};
}
describe('v2 dynamic operation-window authority adapter (recording SQL)',()=>{
 it('separates dynamic population from infrastructure and keeps v1 catalogue prefix exact',()=>{
  const p=profile(),base=require('../lib/tenant-lifecycle/postgres-candidate.json'),selected=domain.catalogue(p);assert.deepEqual(selected.migrations.slice(0,base.migrations.length),base.migrations);assert.equal(selected.migrations.at(-2).name,'0010_selected_lifecycle_generation_domain');assert.equal(selected.migrations.at(-1).name,'0011_exact_artifact_recommission');assert.equal(domain.bind(p,'synthetic_window',[A]),p);assert.throws(()=>domain.bind(p,'foreign'),/BINDING/);assert.equal(domain.validateRoster(p,[{tenant:A,phase:'active',generation:'1'}]),p);assert.throws(()=>domain.validateRoster(p,[{phase:'active',generation:'1'}]),/COVERAGE/);
 });
 it('requires dynamic lock derivation and checks physical current tenant authority before admitted work',async()=>{
  assert.throws(()=>require('../lib/tenant-lifecycle/operation-window').create({namespace:'synthetic_window',locks:[{tenant:A,key:'17'}],pool:{connect(){}},intakeProfile:profile()}),/DYNAMIC_LOCK_RULE/);
  const f=setup();try{await f.window.ready();const lease=await f.window.acquireClient(f.client,A);assert.equal(await f.window.assertClient(f.client,A,lease),'1');await lease.close();assert.equal(f.windows.intakeRoster(f.window),undefined);}finally{await f.window.close();}
 });
 it('refuses terminal, suspended and generation-inconsistent current authority',async()=>{
  for(const [state,generation]of [['deleted','1'],['suspended','1'],['active','2']]){const f=setup(state,generation);try{await f.window.ready();const lease=await f.window.acquireClient(f.client,A);await assert.rejects(f.window.assertClient(f.client,A,lease),/TENANT_AUTHORITY/);await lease.close();}finally{await f.window.close();}}
 });
 it('checks the source authority again before commit after an initially eligible admission',async()=>{
  const f=setup(), query=f.client.query;
  try {
   await f.window.ready();
   const lease=await f.window.acquireClient(f.client,A);
   try {
    assert.equal(await f.window.assertClient(f.client,A,lease),'1');
    f.client.query=async(text,values)=>{
     const result=await query(text,values);
     if(typeof text==='string'&&text.includes('pool-lifecycle-authority')) result.rows[0].deletion=true;
     return result;
    };
    await assert.rejects(f.window.assertCommit(f.client,A,lease),/TENANT_AUTHORITY/);
    f.client.query=query;
    await f.window.assertCommit(f.client,A,lease);
   } finally { await lease.close(); }
  } finally { await f.window.close(); }
 });
});
