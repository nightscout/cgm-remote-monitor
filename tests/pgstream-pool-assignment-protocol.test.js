'use strict';
const assert=require('node:assert/strict');
const protocol=require('../lib/pgstream/assignment-protocol'),legacy=require('../lib/pgstream/assignment-candidate'),pool=require('../lib/pgstream/pool-assignment-candidate'),profiles=require('../lib/pgstream/pool-intake-profile');
const profile=profiles.create({namespace:'proto_checkpoint',membershipNamespace:'proto_membership',lifecycleNamespace:'proto_lifecycle',role:'proto_intake',operatorRole:'proto_operator',consumer:'evaluator-protocol',codec:profiles.CODEC,generationDomain:profiles.GENERATION_DOMAIN,sliceRule:require('../lib/pool-membership/slice').RULE});
const options={namespace:profile.binding.namespace,membershipNamespace:profile.binding.membershipNamespace,lifecycleNamespace:profile.binding.lifecycleNamespace};
function queryFor(candidate,patch){return async sql=>{
 if(sql.includes('FROM pg_trigger')){const rows=[['pgstream_assignment_protocol',31,candidate.assignmentBody,'pgstream_assignment_required',legacy.ASSIGNMENT_COLUMNS,false],['pgstream_effect_protocol',19,candidate.effectBody,'pgstream_assigned_effect_required',legacy.EFFECT_COLUMNS,false],['pgstream_effect_commit',17,candidate.effectBody,'pgstream_assigned_effect_required',[],true]].map(([name,type,source,function_name,columns,deferred])=>({name,type,source,function_name,columns,deferred,deferrable:deferred,enabled:'A',arguments:0,unconditional:true,function_arguments:0,trigger_result:true,definer:false,language:'plpgsql',config:['search_path=pg_catalog']}));return {rows:patch?patch(rows):rows};}
 if(sql.includes('FROM pg_index'))return {rows:legacy.INDEXES.map(i=>({name:i.name,valid:true,ready:true,unique:false,method:'btree',predicate:i.predicate,columns:i.columns}))};
 assert.fail('unexpected protocol query');
};}
describe('versioned pool assignment source protocol admission',()=>{
 it('admits exact additive v2 and unchanged v1, refusing the other version',async()=>{
  const base=legacy.build(options),v2=pool.build({base,...options,operatorRole:profile.binding.operatorRole});
  await protocol.assertInstalled(queryFor(base),options);await protocol.assertInstalled(queryFor(v2),{...options,poolProfile:profile});
  await assert.rejects(protocol.assertInstalled(queryFor(base),{...options,poolProfile:profile}),/UNQUALIFIED/);await assert.rejects(protocol.assertInstalled(queryFor(v2),options),/UNQUALIFIED/);
 });
 it('refuses disabled/deferred/body/column drift and foreign infrastructure binding',async()=>{
  const v2=pool.build({base:legacy.build(options),...options,operatorRole:profile.binding.operatorRole});
  for(const patch of [rows=>rows.slice(0,2),rows=>rows.map(r=>({...r,enabled:'O'})),rows=>rows.map(r=>({...r,source:r.source+' '})),rows=>rows.map(r=>({...r,deferred:false,deferrable:false})),rows=>rows.map(r=>({...r,columns:[]}))])await assert.rejects(protocol.assertInstalled(queryFor(v2,patch),{...options,poolProfile:profile}),/UNQUALIFIED/);
  await assert.rejects(protocol.assertInstalled(()=>assert.fail('before SQL'),{...options,namespace:'foreign_checkpoint',poolProfile:profile}),/BINDING/);
 });
});
