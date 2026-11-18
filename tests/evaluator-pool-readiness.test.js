'use strict';
// Execute actual screen/catalogue functions with recorded bounded SELECT ports;
// these checks do not establish native PostgreSQL role/grant or cohort liveness.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createRequire}=require('node:module');
const pool=require('../lib/pgstream/pool-intake-profile'),legacy=require('../lib/pgstream/intake-profile');
const grants=require('../lib/pgstream/pool-worker-grants');
const COMMON={namespace:'test_work',membershipNamespace:'test_pool',lifecycleNamespace:'test_lifetime',role:'intake_writer',consumer:'evaluator-readiness',codec:pool.CODEC,generationDomain:pool.GENERATION_DOMAIN};
const profile=pool.create({...COMMON,operatorRole:'pool_operator',sliceRule:'sha256-modulo-v1'});
const predecessor=legacy.create({...COMMON,role:'legacy_intake',tenants:['00000000-0000-4000-8000-000000000001'],members:2,revision:'7'});
function config(selected=profile){return {connectionString:'postgres://worker_one:synthetic@127.0.0.1/synthetic',consumer:COMMON.consumer,namespaces:{entries:'test_entries',profile:'test_profile',clock:'test_clock',checkpoint:'test_work'},pgstream:{},selectedIntake:{profile:selected},tenants:new Map()};}
function load({mutate,workerFailure=false,policyFailure=false}={}){
 const file=require.resolve('../lib/server/serve/evaluator-readiness'),original=createRequire(file),calls=[];let source=fs.readFileSync(file,'utf8');
 if(mutate){assert.equal(source.split(mutate[0]).length,2,'one exact mutation anchor');source=source.replace(...mutate);}
 const output={exports:{}},requireOf=name=>{
  if(name==='../../data/tenant-projection-evaluator')return {domains:['entries','profile']};
  if(name==='../../storage/postgres-insertion-readiness')return {isOrderedCatalogue:()=>false};
  if(name==='../../pgstream/pool-worker-grants')return {lifecycleReads:grants.lifecycleReads,async assertReady(query,options){calls.push({kind:'pool-worker',options});assert.equal(options.profile,profile);if(workerFailure)throw Error('PGSTREAM_POOL_GRANT_RELATIONS');}};
  if(name==='../../pgstream/worker-grants')return {...original(name),async assertReady(query,options){calls.push({kind:'v1-worker',options});}};
  if(name==='../../pgstream/assignment-protocol')return {async assertInstalled(query,options){calls.push({kind:'protocol',options});if(policyFailure)throw Error('EVALUATOR_ASSIGNMENT_PROTOCOL_UNQUALIFIED');}};
  if(name==='../../pgstream/pool-catalogue')return {build(value,options){calls.push({kind:'pool-catalogue',value,options});return original(name).build(value,options);}};
  return original(name);
 };
 vm.runInThisContext('(function(require,module,exports){'+source+'\n})',{filename:file})(requireOf,output,output.exports);return {readiness:output.exports,calls};
}
function connection({knownMetadata=[],extraRead,unsafeIdentity=false,clinicalWrite=false}={}){
 const calls=[];
 return {calls,async query(sql,values){calls.push({sql,values});
  if(sql.includes('FROM pg_roles WHERE rolname=current_user'))return {rows:[{rolsuper:unsafeIdentity,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,operator:false}]};
  if(sql.startsWith('WITH identities AS')){const allowed=values[1],needed=[...knownMetadata,...(extraRead?[extraRead]:[])];return {rows:[{creates:false,unrelated:needed.some(table=>!allowed.includes(table))}]};}
  if(sql.includes('has_table_privilege(c.oid,\'SELECT\') AS reads')){const bookkeeping=values[0]==='test_work.tenant_consumer_checkpoint';return {rows:[{secured:true,reads:true,forbidden:false,updates:bookkeeping||clinicalWrite,bookkeeping,extra:false}]};}
  assert.fail('unexpected readiness SQL');
 }};
}
function metadata(){return ['test_pool.pool_desired','test_pool.pool_membership','test_pool.schema_migrations','test_work.schema_migrations','test_work.pgstream_intake_profile',...Object.keys(grants.lifecycleReads(profile)).map(table=>'test_lifetime.'+table)];}
describe('selected-v2 evaluator readiness and catalogue dispatch',()=>{
 it('screens v2 source capabilities/metadata with expected worker principal and exact protocol without waiting for live cohort coverage',async()=>{
  const loaded=load(),client=connection({knownMetadata:metadata()}),cfg=config();cfg.selectedIntake.predecessorProfile=predecessor;
  await loaded.readiness.screen(client,cfg,{lifecycle:{controlReads:async()=>[],intakeProfileDigest:profile.digest},intakeProfile:profile,ordinal:2});
  const worker=loaded.calls.find(call=>call.kind==='pool-worker'),protocol=loaded.calls.find(call=>call.kind==='protocol');
  assert.equal(worker.options.ordinal,2);assert.equal(worker.options.expectedRole,'worker_one');assert.equal(protocol.options.poolIntake,true);assert.equal(protocol.options.poolProfile,profile);assert.equal(protocol.options.predecessorProfile,predecessor);
  assert(client.calls.every(call=>call.sql.startsWith('SELECT')||call.sql.startsWith('WITH')));assert(!client.calls.some(call=>/lease_expires_at|pool_membership.*count|POOL_SELF_NOT_LIVE/.test(call.sql)));
  assert(!loaded.calls.some(call=>call.kind==='v1-worker'));
 });
 it('requires the actual v2 metadata allowlist; omission of membership ledger makes scope criterion RED, then restoration GREEN',async()=>{
  const qualify=async loaded=>loaded.readiness.screen(connection({knownMetadata:metadata() }),config(),{lifecycle:{controlReads:async()=>[],intakeProfileDigest:profile.digest},intakeProfile:profile,ordinal:0});
  await qualify(load());const broken=load({mutate:["b.membershipNamespace+'.schema_migrations',",'']});await assert.rejects(qualify(broken),/unsafe evaluator scope/);await qualify(load());
 });
 it('refuses wrong installed bindings, worker privilege failures and source protocol drift before clinical admission',async()=>{
  await assert.rejects(load().readiness.screen(connection(),config(),{lifecycle:{controlReads:async()=>[],intakeProfileDigest:'0'.repeat(64)},intakeProfile:profile,ordinal:0}),/BINDING/);
  await assert.rejects(load({workerFailure:true}).readiness.screen(connection(),config(),{lifecycle:{controlReads:async()=>[],intakeProfileDigest:profile.digest},intakeProfile:profile,ordinal:0}),/GRANT_RELATIONS/);
  await assert.rejects(load({policyFailure:true}).readiness.screen(connection(),config(),{lifecycle:{controlReads:async()=>[],intakeProfileDigest:profile.digest},intakeProfile:profile,ordinal:0}),/PROTOCOL_UNQUALIFIED/);
 });
 it('retains identity, clinical read scope and no-clinical-write checks for v2',async()=>{
  for(const value of [{unsafeIdentity:true},{extraRead:'foreign.outbox'},{clinicalWrite:true}])await assert.rejects(load().readiness.screen(connection(value),config(),{lifecycle:{controlReads:async()=>[],intakeProfileDigest:profile.digest},intakeProfile:profile,ordinal:0}),/unsafe evaluator/);
 });
 it('uses the actual common v2 catalogue through singleton00010 and forwards optional predecessor origin unchanged',()=>{
  const loaded=load(),fresh=loaded.readiness.cataloguesFor(config());assert.equal(fresh.checkpoint.migrations.at(-1).name,'0010_pool_singleton_effects');
  assert.deepEqual(fresh.checkpoint,require('../lib/pgstream/pool-catalogue').build(profile).catalogue);
  const cfg=config();cfg.selectedIntake.predecessorProfile=predecessor;const adopted=loaded.readiness.cataloguesFor(cfg);assert.deepEqual(adopted.checkpoint,require('../lib/pgstream/pool-catalogue').build(profile,{predecessorProfile:predecessor}).catalogue);
  assert.equal(loaded.calls.filter(call=>call.kind==='pool-catalogue').at(-1).options.predecessorProfile,predecessor);
 });
 it('keeps selected-v1 catalogue and readiness paths exact while unselected maintained path remains unchanged',async()=>{
  const loaded=load(),cfg=config(predecessor),catalogues=loaded.readiness.cataloguesFor(cfg);
  assert.deepEqual(catalogues.checkpoint,require('../lib/pgstream/assignment-candidate').build({membershipNamespace:COMMON.membershipNamespace,lifecycleNamespace:COMMON.lifecycleNamespace,intakeProfile:predecessor}).catalogue);
  await loaded.readiness.screen(connection(),cfg,{lifecycle:{controlReads:async()=>[],intakeProfileDigest:predecessor.digest},intakeProfile:predecessor,ordinal:0});
  assert(loaded.calls.some(call=>call.kind==='v1-worker'));assert(!loaded.calls.some(call=>call.kind==='pool-worker'));const p=loaded.calls.find(call=>call.kind==='protocol').options;assert.equal(p.intakeProfile,predecessor);assert.equal(p.poolProfile,undefined);
  delete cfg.selectedIntake;assert.deepEqual(loaded.readiness.cataloguesFor(cfg).checkpoint,require('../migrations/candidates/postgres-evaluator-work-v2.json'));
 });
});
