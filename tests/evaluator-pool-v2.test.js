'use strict';
// Source dispatch and gate controls. No process, lease backend or PostgreSQL actor.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
const poolGate=require('../lib/server/serve/evaluator-pool');
const profiles=require('../lib/pgstream/pool-intake-profile');
const profile=profiles.create({namespace:'gate_checkpoint',membershipNamespace:'gate_membership',lifecycleNamespace:'gate_lifecycle',consumer:'evaluator-gate',role:'gate_intake',operatorRole:'gate_operator',codec:profiles.CODEC,generationDomain:profiles.GENERATION_DOMAIN,sliceRule:'sha256-modulo-v1'});
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
function load(file,overrides){const original=createRequire(file),module={exports:{}};vm.runInThisContext('(function(require,module,exports){'+fs.readFileSync(file,'utf8')+'\n})',{filename:file})(key=>Object.hasOwn(overrides,key)?overrides[key]:original(key),module,module.exports);return module.exports;}
function fixture({partitioned=false,requiresAssignmentRefresh=true,ordinal=0}={}){
 let next={eligible:true,includes:()=>true,members:1,revision:'9'},pending=null,reads=0,inspections=0,heartbeats=0,cancelled=0;
 const timers=[],member={configured:{mode:partitioned?'partitioned':'standalone',ordinal,rule:'sha256-modulo-v1',leaseMs:300},requiresAssignmentRefresh,
  async slice(){reads++;return pending?pending:next;},async heartbeat(){heartbeats++;return {renewed:true};},async inspect(){inspections++;return {kind:'evaluator',configured:this.configured,observed:{desired:{members:next.members,revision:next.revision},members:next.members,reason:next.reason,rows:[]}};}};
 const gate=poolGate.create({member,tenants:[A,B],now:()=>19,schedule(fn,every){const timer={fn,every,unref(){}};timers.push(timer);return timer;},cancel(){cancelled++;}});
 return {member,gate,timers,next(value){next=value;},pending(value){pending=value;},reads:()=>reads,inspections:()=>inspections,heartbeats:()=>heartbeats,cancelled:()=>cancelled};
}
describe('selected v2 evaluator membership seam',()=>{
 it('dispatches explicit poolProfile before standalone and forwards the exact source authority ports',async()=>{
  const calls=[],adapter={async create(options){calls.push(options);return marker;}},marker=Object.freeze({v2:true});
  const membership=load(require.resolve('../lib/pool-membership'),{'./pool-member':adapter,'./postgres':{async create(){assert.fail('legacy backend used');}}});
  const operationWindow=Object.freeze({source:'actual operationWindow caller value'}),clinicalConnection={async readOnly(){assert.fail('factory must not borrow/query port');}},readOnly=clinicalConnection.readOnly.bind(clinicalConnection);
  for(const config of [{kind:'evaluator',partitioned:false},{kind:'evaluator',partitioned:true,ordinal:2,leaseMs:300,namespace:'gate_membership',connectionString:'synthetic'}]){assert.equal(await membership.member(config,{poolProfile:profile,operationWindow,readOnly}),marker);assert.deepEqual(calls.at(-1),{config,profile,operationWindow,readOnly});assert.equal(calls.at(-1).operationWindow,operationWindow);assert.equal(calls.at(-1).readOnly,readOnly);}
  await assert.rejects(membership.member({kind:'evaluator',partitioned:false},{poolProfile:profile,intakeProfile:{},operationWindow,readOnly}),/PROFILE_VERSION/);
 });
 it('uses actual adapter window/profile/readOnly validation rather than returning a legacy standalone bypass',async()=>{
  const membership=require('../lib/pool-membership'),config={kind:'evaluator',partitioned:false};
  await assert.rejects(membership.member(config,{poolProfile:profile,operationWindow:{namespace:profile.binding.lifecycleNamespace,intakeProfileDigest:profile.digest},readOnly:async()=>assert.fail('unbranded window queried')}),/POOL_V2_CONFIG/);
  await assert.rejects(membership.member(config,{poolProfile:undefined}),/PGSTREAM_POOL_INTAKE_PROFILE/);
 });
 it('preserves v1 standalone and partitioned factory behavior without selecting v2',async()=>{
  const calls=[],marker={legacy:true},membership=load(require.resolve('../lib/pool-membership'),{'./postgres':{async create(options){calls.push(options);return marker;}},'./pool-member':{create(){assert.fail('v2 must be selected explicitly');}}});
  const standalone=await membership.member({kind:'evaluator',partitioned:false});assert.equal(standalone.configured.mode,'standalone');assert.equal((await standalone.slice()).eligible,true);await standalone.close();
  const config={kind:'evaluator',partitioned:true,ordinal:1,leaseMs:300,connectionString:'synthetic',namespace:'gate_membership'},options={fixedProtocol:true,intakeProfile:{legacy:true},operationWindow:{}};
  assert.equal(await membership.member(config,options),marker);assert.deepEqual(calls,[{...options,kind:config.kind,ordinal:1,leaseMs:300,connectionString:'synthetic',namespace:'gate_membership'}]);
 });
 it('requires the first singleton assignment refresh and shares concurrent refresh without scheduling heartbeat',async()=>{
  const f=fixture();assert.equal(f.gate.partitioned,false);assert.equal(f.gate.admits(A),false);assert.equal(f.gate.reason(),'POOL_NOT_READ');
  f.gate.start(300);assert.equal(f.timers.length,0);let resolve;f.pending(new Promise(done=>{resolve=done;}));const first=f.gate.refresh(),second=f.gate.refresh();assert.equal(first,second);assert.equal(f.reads(),1);assert.equal(f.gate.admits(A),false);
  resolve({eligible:true,members:1,revision:'9',includes:()=>true});await first;assert.equal(f.gate.admits(A),true);assert.equal(f.heartbeats(),0);f.gate.close();
 });
 it('withdraws singleton effects on actual mode/epoch refusal and inspection cannot certify a slice',async()=>{
  const f=fixture();let changes=0;f.gate.onChange(()=>changes++);
  const before=await f.gate.inspect();assert.equal(before.gate.eligible,false);assert.equal(before.gate.reads,0);assert.equal(f.reads(),0);assert.equal(f.inspections(),1);assert.equal(before.observed.revision,'9');assert.equal(before.gate.heartbeats,null);
  await f.gate.refresh();assert.equal(f.gate.admits(A),true);assert.equal(changes,1);
  f.next({eligible:false,reason:'POOL_MODE_CHANGED',members:null});await f.gate.refresh();assert.equal(f.gate.admits(A),false);assert.equal(f.gate.reason(),'POOL_MODE_CHANGED');assert.equal(changes,2);
  const after=await f.gate.inspect();assert.equal(after.gate.eligible,false);assert.equal(after.gate.refusals,1);assert.equal(after.observed.reason,'POOL_MODE_CHANGED');assert.equal(after.owner(A),null);assert.equal(f.reads(),2);f.gate.close();
 });
 it('notifies each admitted epoch/count/mode change even when the tenant set stays identical',async()=>{
  const f=fixture();let changes=0;f.gate.onChange(()=>changes++);
  for(const next of [{partitioned:false,members:1,revision:'9'},{partitioned:false,members:1,revision:'10'},{partitioned:true,members:3,revision:'11'},{partitioned:true,members:5,revision:'12'}]){f.next({eligible:true,includes:()=>true,...next});await f.gate.refresh();assert.equal(f.gate.admits(A),true);}
  assert.equal(changes,4);await f.gate.refresh();assert.equal(changes,4);assert.equal((await f.gate.inspect()).gate.changes,4);f.gate.close();
  const v1=fixture({partitioned:true,requiresAssignmentRefresh:false});let oldChanges=0;v1.gate.onChange(()=>oldChanges++);await v1.gate.refresh();v1.next({eligible:true,members:1,revision:'10',includes:()=>true});await v1.gate.refresh();assert.equal(oldChanges,1);v1.gate.close();
 });
 it('keeps an outside ordinal idle and does not turn inspection/startup availability into assignment admission',async()=>{
  const f=fixture({partitioned:true,ordinal:4});f.next({eligible:false,outside:true,reason:'POOL_PLACEMENT_COHORT_INCOMPLETE',members:3,revision:'10'});await f.gate.refresh();assert.equal(f.gate.admits(A),false);assert.equal(f.gate.admits(B),false);
  const view=await f.gate.inspect();assert.equal(view.gate.eligible,false);assert.equal(view.gate.reason,'POOL_PLACEMENT_COHORT_INCOMPLETE');assert.equal(view.configured.ordinal,4);assert.equal(view.observed.effectiveMembers,3);f.gate.close();
 });
 it('schedules heartbeat only for partitioned mode and preserves legacy standalone no-read behavior',async()=>{
  const f=fixture({partitioned:true});f.gate.start(300);assert.equal(f.timers.length,1);assert.equal(f.timers[0].every,100);f.timers[0].fn();await Promise.resolve();assert.equal(f.heartbeats(),1);f.gate.close();assert.equal(f.cancelled(),1);
  const legacy=fixture({requiresAssignmentRefresh:false});assert.equal(legacy.gate.admits(A),true);assert.equal(await legacy.gate.refresh(),null);legacy.gate.start(300);assert.equal(legacy.reads(),0);assert.equal(legacy.timers.length,0);const view=await legacy.gate.inspect();assert.equal(view.observed,null);assert.equal(view.gate.eligible,true);legacy.gate.close();
 });
});
