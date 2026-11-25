'use strict';
// Actual source helper and guard generator with recording SQL protocols. Native
// maintenance DATA-commit, RLS and INSERT-trigger evidence is separate.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createRequire}=require('node:module');
const profiles=require('../lib/pgstream/pool-intake-profile'),definition=require('../lib/pgstream/pool-checkpoint-provision-candidate');
const profile=profiles.create({namespace:'test_work',membershipNamespace:'test_members',lifecycleNamespace:'test_lifetime',operatorRole:'pool_operator',role:'intake_writer',consumer:'evaluator-provision',codec:profiles.CODEC,generationDomain:profiles.GENERATION_DOMAIN,sliceRule:require('../lib/pool-membership/slice').RULE});
const binding=profile.binding,TENANT='00000000-0000-4000-8000-000000000001',CLAIM='10000000-0000-4000-8000-000000000001';
const legacy=require('../lib/pgstream/assignment-candidate').build(binding),pool=require('../lib/pgstream/pool-assignment-candidate').build({base:legacy,...binding}),intake=require('../lib/pgstream/pool-intake-candidate').build({base:pool,intakeProfile:profile});
const full=require('../lib/pgstream/pool-catalogue').build(profile);
function moduleOf(replace){
 const file=require.resolve('../lib/pgstream/pool-checkpoint-provision');let source=fs.readFileSync(file,'utf8');
 if(replace){assert.equal(source.split(replace[0]).length,2);source=source.replace(...replace);}
 const output={exports:{}},original=createRequire(file);
 const requireOf=name=>name==='./assignment-protocol'?{async assertInstalled(query,value){assert.equal(value.poolIntake,true);assert.equal(value.poolProfile,profile);await query('SELECT /* recording-assignment-protocol */ 1');}}:original(name);
 vm.runInThisContext('(function(require,module,exports){'+source+'\n})',{filename:file})(requireOf,output,output.exports);return output.exports;
}
const helper=moduleOf();
function model({authorityPatch,cohortPatch,lockPatch,existing=false,protocolPatch,ledgerPatch,profilePatch,failAfterInsert=false,desiredPatch}={}){
 const calls=[],inserts=[];let n=0,context;
 const authority={pid:41,xid:'501',tenant:TENANT,role_oid:'9001',birth:'synthetic-original-birth',generation:'7',claim_id:CLAIM,artifact_digest:'a'.repeat(64),phase:'suspended',audit_role:'9001',owner_pid:41,owner_birth:'synthetic-original-birth',state:'suspended',unrestored:true,unactivated:true,authorized:true,lifetime_held:true,rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,owns_checkpoint:false,owns_lifecycle:false};
 const protocol=()=>[false,true].map(deferred=>({name:deferred?'pgstream_checkpoint_provision_commit':'pgstream_checkpoint_provision',type:deferred?5:7,enabled:'A',deferrable:deferred,deferred,arguments:0,unconditional:true,columns:'',source:full.provisionBody,function_name:'pgstream_checkpoint_provision_required',definer:false,config:['search_path=pg_catalog'],function_arguments:0,trigger_result:true,language:'plpgsql'}));
 async function query(sql,values){calls.push({sql,values});
  if(sql.includes('pool-checkpoint-provision-authority')){n++;if(failAfterInsert&&inserts.length)throw Error('SYNTHETIC_DRIVER_FAILURE');return {rows:[{...authority,...(typeof authorityPatch==='function'?authorityPatch(n):authorityPatch)}]};}
  if(sql.includes('recording-assignment-protocol'))return {rows:[]};
  if(sql.includes('pool-checkpoint-provision-protocol'))return {rows:protocol().map(row=>({...row,...protocolPatch}))};
  if(sql.includes('pool-checkpoint-provision-ledger'))return {rows:full.catalogue.migrations.map(m=>({name:m.name,checksum:m.checksum,...ledgerPatch}))};
  if(sql.includes('pool-checkpoint-provision-profile'))return {rows:[{consumer:binding.consumer+'-completed',profile:binding,digest:profile.digest,contract_digest:profile.contractDigest,...profilePatch}]};
  if(sql.includes('pg_advisory_xact_lock('))return {rows:[{backend_pid:41,transaction_id:'501',...lockPatch}]};
  if(sql.includes('pool-checkpoint-provision-desired'))return {rows:[{members:3,revision:'9007199254740993',rule:binding.sliceRule,partitioned:true,...desiredPatch}]};
  if(sql.includes('pool-checkpoint-provision-cohort')){const rows=[0,1,2].map(ordinal=>({ordinal,member_id:'20000000-0000-4000-8000-'+(ordinal+1).toString().padStart(12,'0'),rule:binding.sliceRule,applied:3}));return {rows:cohortPatch?cohortPatch(rows):rows};}
  if(sql.includes('pool-checkpoint-provision-existing'))return {rows:existing?[{consumer:binding.consumer+'-completed'}]:[]};
  if(sql.startsWith("SELECT set_config('app.pgstream_checkpoint_provision'")){context=JSON.parse(values[0]);return {rows:[]};}
  if(sql.startsWith('INSERT INTO ')){const match=/\(([^)]+)\) VALUES/.exec(sql);assert(match);const row=Object.fromEntries(match[1].split(',').map((key,i)=>[key,values[i]]));inserts.push(row);return {rowCount:1,rows:[{tenant:row.tenant_id,consumer:row.consumer,contract_digest:row.contract_digest,ordinal:row.work_owner_ordinal,revision:row.work_assignment_revision}]};}
  assert.fail('Unexpected SQL protocol path');
 }
 return {query,calls,inserts,context:()=>context};
}
const options=()=>({tenant:TENANT,generation:'7',enabled:false});
describe('fresh suspended-claim typed checkpoint provisioning (source SQL protocol)',()=>{
 it('validates authority/lifetime before cohort, stages clean current assignment and preserves caller-owned transaction',async()=>{
  const lab=model(),before=Date.now();const result=await helper.provisionCheckpoint(lab.query,profile,options());
  assert.equal(result.staged,true);assert.equal(lab.inserts.length,1);const row=lab.inserts[0];
  assert.equal(row.contract_digest,profile.contractDigest);assert.equal(row.consumer,binding.consumer+'-completed');assert.equal(row.work_assignment_revision,'9007199254740993');assert.equal(row.work_owner_ordinal,require('../lib/pool-membership/slice').bucket(TENANT,3));
  assert.deepEqual(row.work_observed,[null,null,null,null,'15','1']);assert.deepEqual(row.work_completed,Array(6).fill(null));
  assert.equal(row.work_observed_at[4],row.work_pending_at);assert.equal(row.work_observed_at[5],row.work_pending_at);assert(Number(row.work_pending_at)>=before&&Number(row.work_pending_at)<=Date.now());
  for(const key of ['work_enabled','work_activity_enabled','work_lifecycle_enabled'])assert.equal(row[key],false);
  for(const key of ['checkpoint','delivery_revision','delivery_ack_revision','output_revision'])assert.equal(row[key],'0');
  for(const key of ['work_due_at','work_completed_at','output_identity','output_digest','output_restore_generation'])assert.equal(row[key],null);
  assert.deepEqual(JSON.parse(row.projection),[{kind:'evaluator-work-v2',output:null}]);assert.equal(Object.keys(row).length,definition.INSERTS.length);
  const life=lab.calls.findIndex(row=>row.sql.includes('pool-checkpoint-provision-authority')),cohort=lab.calls.findIndex(row=>row.sql.includes('pg_advisory_xact_lock(')),insert=lab.calls.findIndex(row=>row.sql.startsWith('INSERT'));
  assert(life>=0&&cohort>life&&insert>cohort);assert.equal(lab.calls.filter(row=>row.sql.includes('pool-checkpoint-provision-authority')).length,3);
  assert(lab.calls.every(row=>!/^(BEGIN|COMMIT|ROLLBACK|DELETE|UPDATE)\b/i.test(row.sql)));assert(!lab.calls.some(row=>/ON CONFLICT|UPSERT/i.test(row.sql)));
  assert.equal(lab.context().generation,'7');assert.equal(lab.context().roleOID,'9001');assert.equal(lab.context().profile,profile.digest);
 });
 it('refuses wrong tenant/generation/claim/principal/audit phase or missing exclusive lifetime before any insert',async()=>{
  for(const patch of [{tenant:'00000000-0000-4000-8000-000000000002'},{generation:'8'},{claim_id:null},{authorized:false},{audit_role:'9002'},{owner_pid:42},{owner_birth:'different'},{state:'restored'},{unrestored:false},{unactivated:false},{phase:'active'},{lifetime_held:false},{rolsuper:true},{owns_checkpoint:true}]){
   const lab=model({authorityPatch:patch});await assert.rejects(helper.provisionCheckpoint(lab.query,profile,options()),/AUTHORITY/);assert.equal(lab.inserts.length,0);assert(!lab.calls.some(row=>row.sql.includes('pg_advisory_xact_lock(')));
  }
 });
 it('actual lifetime-check omission admits an unsafe recording actor and makes refusal criterion RED, then restoration GREEN',async()=>{
  const criterion=async module=>{const lab=model({authorityPatch:{lifetime_held:false}});await assert.rejects(module.provisionCheckpoint(lab.query,profile,options()),/AUTHORITY/);assert.equal(lab.inserts.length,0);};
  await criterion(helper);const broken=moduleOf(['row.lifetime_held !== true || ','']);await assert.rejects(criterion(broken),{code:'ERR_ASSERTION'});await criterion(helper);
 });
 it('refuses foreign/autocommit backend or changed transaction before insert',async()=>{
  for(const lockPatch of [{backend_pid:42},{transaction_id:'502'}]){const lab=model({lockPatch});await assert.rejects(helper.provisionCheckpoint(lab.query,profile,options()),/TRANSACTION/);assert.equal(lab.inserts.length,0);}
  const lab=model({authorityPatch:n=>n===1?{}:{xid:'502'}});await assert.rejects(helper.provisionCheckpoint(lab.query,profile,options()),/IDENTITY_CHANGED/);assert.equal(lab.inserts.length,0);
 });
 it('rejects NULL/duplicate/outside/missing/foreign-rule incarnation coverage before insert',async()=>{
  for(const cohortPatch of [rows=>rows.slice(1),rows=>[...rows,{...rows[0],member_id:'30000000-0000-4000-8000-000000000001'}],rows=>rows.map((row,i)=>i===1?{...row,applied:null}:row),rows=>rows.map((row,i)=>i===1?{...row,ordinal:4}:row),rows=>rows.map(row=>({...row,rule:'foreign'}))]){const lab=model({cohortPatch});await assert.rejects(helper.provisionCheckpoint(lab.query,profile,options()),/COHORT/);assert.equal(lab.inserts.length,0);}
 });
 it('off singleton stages ordinal zero only with no live membership, and rejects absent/bad mode or incompatible cohorts',async()=>{
  const lab=model({desiredPatch:{members:1,partitioned:false},cohortPatch:()=>[]});const result=await helper.provisionCheckpoint(lab.query,profile,options());assert.equal(result.ordinal,0);assert.equal(lab.inserts[0].work_owner_ordinal,0);assert.equal(lab.context().members,1);
  for(const patch of [{desiredPatch:{partitioned:null}},{desiredPatch:{partitioned:undefined}},{desiredPatch:{partitioned:false}},{desiredPatch:{members:1,partitioned:false}},{desiredPatch:{members:1,partitioned:true},cohortPatch:()=>[]}]){const bad=model(patch);await assert.rejects(helper.provisionCheckpoint(bad.query,profile,options()),/ASSIGNMENT|COHORT/);assert.equal(bad.inserts.length,0);}
 });
 it('actual singleton live-member refusal omission makes its source contract RED, then restored GREEN',async()=>{
  const qualify=async module=>{const lab=model({desiredPatch:{members:1,partitioned:false}});await assert.rejects(module.provisionCheckpoint(lab.query,profile,options()),/COHORT/);assert.equal(lab.inserts.length,0);};
  await qualify(helper);const broken=moduleOf([': live.length!==0',': false']);await assert.rejects(qualify(broken),{code:'ERR_ASSERTION'});await qualify(helper);
 });
 it('requires exact installed guard, ledger and profile; existing rows cannot be reset',async()=>{
  for(const patch of [{protocolPatch:{source:full.provisionBody+' '}},{protocolPatch:{enabled:'O'}},{ledgerPatch:{checksum:'0'.repeat(64)}},{profilePatch:{digest:'0'.repeat(64)}},{existing:true}]){const lab=model(patch);await assert.rejects(helper.provisionCheckpoint(lab.query,profile,options()),/PGSTREAM_POOL_PROVISION_/);assert.equal(lab.inserts.length,0);}
 });
 it('rejects archive/extra options, activation, forged profile and out-of-domain generation without SQL',async()=>{
  for(const value of [{...options(),archivedCheckpoint:{}},{...options(),enabled:true},{...options(),generation:'4611686018427387903'}]){const lab=model();await assert.rejects(helper.provisionCheckpoint(lab.query,profile,value));assert.equal(lab.calls.length,0);}
  const lab=model();await assert.rejects(helper.provisionCheckpoint(lab.query,{...profile,digest:'0'.repeat(64)},options()));assert.equal(lab.calls.length,0);
 });
 it('post-insert authority/driver failure propagates without commit or compensating reset',async()=>{
  for(const patch of [{authorityPatch:n=>n===3?{generation:'8'}:{}},{failAfterInsert:true}]){const lab=model(patch);await assert.rejects(helper.provisionCheckpoint(lab.query,profile,options()));assert.equal(lab.inserts.length,1);assert(!lab.calls.some(row=>/^(COMMIT|ROLLBACK|DELETE|UPDATE)\b/i.test(row.sql)));}
 });
 it('appends a separate exact BEFORE/deferred INSERT guard without modifying any earlier migration or UPDATE body',()=>{
  const original=JSON.stringify(intake),out=definition.build({base:intake,intakeProfile:profile});assert.equal(JSON.stringify(intake),original);assert.deepEqual(out.catalogue.migrations.slice(0,-1),intake.catalogue.migrations);assert.equal(out.effectBody,intake.effectBody);assert.equal(out.assignmentBody,intake.assignmentBody);
  assert.equal(out.catalogue.migrations.at(-1).name,'0009_evaluator_pool_checkpoint_provision');assert.equal(out.provisionMigration.checksum,require('../lib/migrations/catalogue').checksum(out.provisionMigration.up));
  assert(out.provisionBody.includes("TG_WHEN='BEFORE' AND (lifetime.state<>'suspended'"));assert(out.provisionBody.includes("TG_WHEN='AFTER' AND (lifetime.state<>'restored'"));assert(out.provisionBody.includes("mode='ExclusiveLock'"));assert(out.provisionBody.includes('to_jsonb(NEW) IS DISTINCT FROM jsonb_build_object'));assert(out.provisionBody.includes('applied_members=desired.members'));
  assert(out.provisionBody.includes('lifetime.owner_pid IS DISTINCT FROM pg_backend_pid()'));assert(out.provisionBody.includes('lifetime.owner_birth IS DISTINCT FROM actual_birth'));assert(out.provisionBody.includes("NEW.work_owner_ordinal IS NULL THEN RETURN NEW"));
  assert(out.provisionMigration.up.some(sql=>sql.includes('AFTER INSERT')&&sql.includes('DEFERRABLE INITIALLY DEFERRED')));assert(!out.provisionMigration.up.some(sql=>/DISABLE|GRANT|DROP|UPDATE|DELETE/.test(sql)));
 });
});
