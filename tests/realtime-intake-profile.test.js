'use strict';
// Strict DB-free source protocol. Actual PostgreSQL/role authority remains a
// native qualification criterion; these replies never claim to establish it.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const profiles=require('../lib/pgstream/intake-profile'),admissions=require('../lib/pgstream/realtime-output-profile'),completed=require('../lib/pgstream/realtime-output');
const options=require('./fixtures/intake-source-protocol').options,A=options.tenants[0],B=options.tenants[1],scope=require('../lib/storage/tenant-scope');
const p=extra=>profiles.create({...options,lifecycleNamespace:'synthetic_window',...extra});
async function fixture(){
 const profile=p(),life=require('./fixtures/operation-window-runtime-protocol')({trustedWorker:true,intakeProfile:profile,generation:'7'});await life.window.ready();await life.window.verifyOperational();
 const built=require('../lib/pgstream/assignment-candidate').build({...profile.binding,intakeProfile:profile}),candidate=require('../lib/pgstream/assignment-candidate'),calls=[],state={mode:null,digest:profile.contractDigest,snapshots:0,physical:0};
 const config={intakeProfile:profile,consumer:'realtime-selected',completedOutput:{namespace:profile.binding.namespace,consumer:profile.binding.consumer},maxRows:100,maxBytes:100000};
 const effect=(name,type,source,fn,columns,deferred)=>({name,type,source,function_name:fn,columns,deferrable:deferred,deferred,enabled:'A',arguments:0,unconditional:true,function_arguments:0,trigger_result:true,definer:false,language:'plpgsql',config:['search_path=pg_catalog']});
 const connection={async readOnly(text,values){
  calls.push({text,values});assert.match(text,/^SELECT/,'READ_ONLY_SOURCE_PROTOCOL');
  if(text.includes('/* realtime-installed-intake-profile */'))return{rows:[{consumer:profile.binding.consumer+'-completed',profile:profile.binding,digest:state.mode==='profile'?'0'.repeat(64):profile.digest,contract_digest:profile.contractDigest}]};
  if(text.startsWith('SELECT to_regclass'))return{rows:[{present:true}]};
  if(text.startsWith('SELECT name, checksum'))return{rows:built.catalogue.migrations.map((migration,i)=>({name:migration.name,checksum:state.mode==='ledger'&&i===0?'0'.repeat(64):migration.checksum}))};
  if(text.includes('FROM pg_trigger'))return{rows:[effect('pgstream_assignment_protocol',31,built.assignmentBody,'pgstream_assignment_required',candidate.ASSIGNMENT_COLUMNS,false),effect('pgstream_effect_protocol',19,state.mode==='effect'?'changed':built.effectBody,'pgstream_assigned_effect_required',candidate.EFFECT_COLUMNS,false),effect('pgstream_effect_commit',17,built.effectBody,'pgstream_assigned_effect_required',[],true)]};
  if(text.includes('/* intake-assert-function */'))return{rows:[{source:state.mode==='assert'?'changed':built.intakeAssertBody,definer:false,config:['search_path=pg_catalog'],arguments:0,void_result:true,executes:false,language:'plpgsql'}]};
  if(text.includes('FROM pg_index'))return{rows:candidate.INDEXES.map(index=>({...index,valid:true,ready:true,unique:false,method:'btree'}))};
  if(text.includes('/* realtime-intake-source-readonly */'))return{rows:['schema_migrations','pgstream_intake_profile','tenant_consumer_checkpoint'].map((name,i)=>({relation:profile.binding.namespace+'.'+name,kind:'r',persistence:'p',owns:false,creates:false,writes:state.mode==='writes'&&i===1,reads:true,inherited:false}))};
  if(text.includes('output_revision::text AS revision')){assert(text.includes('contract_digest,work_version,work_owner_ordinal,work_assignment_revision::text'));return{rows:values[1].map(tenant=>({tenant,revision:'3',work_enabled:true,contract_digest:state.digest,work_version:2,work_owner_ordinal:profile.assignment.owner(tenant),work_assignment_revision:profile.binding.revision}))};}
  throw Error('UNEXPECTED_REALTIME_PROFILE_PROTOCOL_QUERY');
 },async snapshotTransaction(fn){state.snapshots++;return fn();},async query(text,values){
  calls.push({text,values});assert.equal(scope.currentTenant(),A);assert.equal(values[0],A);
  const body={tenant:A,inputCheckpoint:2,checkpoint:2,trigger:'input',rows:[],frame:{lastUpdated:100,sgvs:[]}};
  if(text.includes(' AS output_summary')){const summary={...body};delete summary.rows;delete summary.frame;return{rows:[{tenant:A,contract_digest:state.digest,work_version:2,work_observed:['1',null,null,null,null,null],work_completed:['1',null,null,null,null,null],work_enabled:true,output_identity:'current',output_digest:'a'.repeat(64),output_revision:'3',output_restore_generation:'7',output_summary:summary,frame_at:100}]};}
  assert.match(text,/SELECT \(projection->0->'output'\)-'result' AS output/);state.physical++;return{rows:[{output:body}]};
 }};
 return{profile,config,connection,state,calls,window:life.window,close:()=>life.window.close()};
}
function alter(file,needle,replacement){const name=require.resolve(file),source=fs.readFileSync(name,'utf8');assert.equal(source.split(needle).length,2,'UNIQUE_SOURCE_ABLATION');const changed=new Module(name,module);changed.filename=name;changed.paths=Module._nodeModulePaths(path.dirname(name));changed._compile(source.replace(needle,replacement),name);return changed.exports;}
describe('selected realtime intake-profile source capability',()=>{
 it('parses only a known safe profile bound to the completed source and lifecycle metadata',()=>{
  const input=require('./fixtures/realtime-completed-config')(),value=input.value,profile=p({namespace:value.completedOutput.namespace,consumer:value.completedOutput.consumer,lifecycleNamespace:value.activity.namespace});
  const parsed=require('../lib/server/realtime/config').parse({...value,intakeProfile:JSON.parse(JSON.stringify(profile))},input.source);assert.equal(parsed.intakeProfile.digest,profile.digest);assert.equal(profiles.validate(parsed.intakeProfile),parsed.intakeProfile);
  for(const bad of [p(),{...profile,digest:'0'.repeat(64)},p({namespace:value.completedOutput.namespace,consumer:value.completedOutput.consumer,lifecycleNamespace:'foreign_window'})])assert.throws(()=>require('../lib/server/realtime/config').parse({...value,intakeProfile:bad},input.source));
  assert.deepEqual(Object.keys(require('../lib/server/realtime/config').parse(value,input.source)).includes('intakeProfile'),false,'UNSELECTED_OBJECT_SHAPE_UNCHANGED');
 });
 it('requires actual branded selected window/profile agreement even when catalogue OID identity matches',async()=>{
  const f=await fixture(),otherProfile=p({role:'other_intake'}),other=require('./fixtures/operation-window-runtime-protocol')({trustedWorker:true,intakeProfile:otherProfile});
  try{await other.window.ready();assert.deepEqual(other.window.identity,f.window.identity);assert.throws(()=>admissions.binding(f.config,other.window),/PROFILE_REFUSED/);assert.throws(()=>admissions.binding(f.config,{...f.window}),/PROFILE_REFUSED/);assert.throws(()=>admissions.binding(f.config,undefined),/PROFILE_REFUSED/);assert.equal(admissions.binding(f.config,f.window),f.profile);}finally{await other.window.close();await f.close();}
 });
 it('executes readonly installed profile/ledger/source/rights admission before creating a source-bound reader token',async()=>{
  const f=await fixture();try{const admission=await admissions.open({config:f.config,connection:f.connection,operationWindow:f.window});assert.equal(admissions.admitted({config:f.config,connection:f.connection,operationWindow:f.window,admission}),f.profile);assert(f.calls.some(row=>row.text.includes('realtime-installed-intake-profile')));assert(f.calls.some(row=>row.text.includes('FROM pg_trigger')));assert(f.calls.every(row=>row.text.startsWith('SELECT')));assert.throws(()=>admissions.admitted({config:f.config,connection:{...f.connection},operationWindow:f.window,admission}),/PROFILE_REFUSED/);admission.close();assert.throws(()=>admissions.admitted({config:f.config,connection:f.connection,operationWindow:f.window,admission}),/PROFILE_REFUSED/);}finally{await f.close();}
 });
 it('same identity is insufficient after installed profile, ledger, effect/assert source or readonly rights drift; failed recovery withdraws the token',async()=>{
  for(const mode of ['profile','ledger','effect','assert','writes']){const f=await fixture();try{const admission=await admissions.open({config:f.config,connection:f.connection,operationWindow:f.window});f.state.mode=mode;await assert.rejects(admission.verify());assert.throws(()=>admissions.admitted({config:f.config,connection:f.connection,operationWindow:f.window,admission}),/PROFILE_REFUSED/);f.state.mode=null;await admission.verify();assert.equal(admissions.admitted({config:f.config,connection:f.connection,operationWindow:f.window,admission}),f.profile);}finally{await f.close();}}
 });
 it('removing actual installed-source admission makes wrong-profile refusal RED; restored SQL-reading path refuses',async()=>{
  const broken=alter('../lib/pgstream/realtime-output-profile','await installed(connection,p);','');
  async function criterion(module){const f=await fixture();try{f.state.mode='profile';await assert.rejects(module.open({config:f.config,connection:f.connection,operationWindow:f.window}),/PROFILE_REFUSED/);}finally{await f.close();}}
  await assert.rejects(criterion(broken),{code:'ERR_ASSERTION'});await criterion(admissions);
 });
 it('removing actual window digest agreement makes same-OID wrong-profile refusal RED; exact restoration refuses',async()=>{
  const broken=alter('../lib/pgstream/realtime-output-profile','||window.intakeProfileDigest!==p.digest','');
  async function criterion(module){const f=await fixture(),other=require('./fixtures/operation-window-runtime-protocol')({trustedWorker:true,intakeProfile:p({role:'other_intake'})});try{await other.window.ready();assert.deepEqual(other.window.identity,f.window.identity);assert.throws(()=>module.binding(f.config,other.window),/PROFILE_REFUSED/);}finally{await other.window.close();await f.close();}}
  await assert.rejects(criterion(broken),{code:'ERR_ASSERTION'});await criterion(admissions);
 });
 it('consumes selected typed output and validates detector contract/assignment without per-frame catalogue scans',async()=>{
  const previous=scope.getTenancyMode();scope.setTenancyMode('multi');const f=await fixture();try{
   const admission=await admissions.open({config:f.config,connection:f.connection,operationWindow:f.window}),metadata=f.calls.length,current={tenant:A,identity:'current'};
   const reader=completed.projection({config:f.config,connection:f.connection,current,operationWindow:f.window,admission});assert.equal((await f.window.run(A,()=>reader.acquire())).checkpoint,3);assert.equal((await f.window.run(A,()=>reader.acquire())).checkpoint,3);assert.equal(f.state.physical,1);assert.equal(f.calls.slice(metadata).filter(row=>row.text.includes('FROM pg_trigger')||row.text.includes('realtime-installed-intake-profile')).length,0);
   const detector=completed.detector({config:f.config,connection:f.connection,operationWindow:f.window,admission,trusted:{scan:async tenants=>new Map(tenants.map(tenant=>[tenant,{activity:{state:'active'}}]))},readAll:async tenants=>new Map(tenants.map(tenant=>[tenant,{identity:tenant}])),owner:()=>{},onIneligible:()=>{throw Error('UNEXPECTED_INELIGIBLE');}});
   assert.equal((await detector([A,B])).get(B).stamp,'3');const before=f.calls.length;await assert.rejects(detector(['33333333-3333-4333-8333-333333333333']),/PROFILE_REFUSED/);assert.equal(f.calls.length,before,'FOREIGN_ROSTER_REFUSES_BEFORE_SQL');
   f.state.digest=require('../lib/pgstream/checkpoint').create({connection:f.connection,namespace:f.profile.binding.namespace,consumer:f.profile.binding.consumer,maxBytes:1000,typed:true}).digest;await assert.rejects(detector([A]),/PROFILE_REFUSED/);await assert.rejects(f.window.run(A,()=>reader.acquire()),/OUTPUT_CONTRACT/);
  }finally{await f.close();scope.setTenancyMode(previous);}
 });
 it('omitting safe profile propagation makes selected output consumption RED; restored reader passes',async()=>{
  const broken=alter('../lib/pgstream/realtime-output','...(profile?{intakeProfile:profile}:{})','');
  async function criterion(module){const previous=scope.getTenancyMode();scope.setTenancyMode('multi');const f=await fixture();try{const admission=await admissions.open({config:f.config,connection:f.connection,operationWindow:f.window});const reader=module.projection({config:f.config,connection:f.connection,current:{tenant:A,identity:'current'},operationWindow:f.window,admission});assert.equal((await f.window.run(A,()=>reader.acquire())).checkpoint,3);}finally{await f.close();scope.setTenancyMode(previous);}}
  await assert.rejects(criterion(broken),/OUTPUT_CONTRACT/);await criterion(completed);
 });
 it('keeps source grants readonly and refuses assigning them to the receipt principal',()=>{const profile=p(),sql=admissions.grants({profile,role:'rt_reader'}).join('\n');assert(sql.includes('SELECT(name,checksum)'));assert(sql.includes('SELECT(consumer,profile,digest,contract_digest)'));assert(!/GRANT.*(?:UPDATE|INSERT|DELETE|EXECUTE)/.test(sql));assert.throws(()=>admissions.grants({profile,role:profile.binding.role}),/PROFILE_REFUSED/);});
});
