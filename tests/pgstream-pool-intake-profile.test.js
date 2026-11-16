'use strict';
const assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const profile=require('../lib/pgstream/pool-intake-profile'),legacy=require('../lib/pgstream/intake-profile');
const {RULE}=require('../lib/pool-membership/slice'),{canonical}=require('../lib/server/serve/evaluator-runtime');
const options={namespace:'pool_work',membershipNamespace:'pool_members',lifecycleNamespace:'pool_control',role:'pool_intake',operatorRole:'pool_operator',consumer:'evaluator-pool',codec:legacy.CODEC,generationDomain:legacy.GENERATION_DOMAIN,sliceRule:RULE};
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
function altered(needle,replacement){
 const fs=require('node:fs'),Module=require('node:module'),path=require('node:path'),file=require.resolve('../lib/pgstream/pool-intake-profile'),source=fs.readFileSync(file,'utf8');
 assert.equal(source.split(needle).length,2);const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(source.replace(needle,replacement),file);return m.exports;
}
function v1(){const {operatorRole,sliceRule,...old}=options;assert(operatorRole&&sliceRule);return legacy.create({...old,members:2,revision:'9007199254740993',tenants:['11111111-1111-4111-8111-111111111111']});}
describe('versioned pool intake infrastructure profile (not runtime authority)',()=>{
 it('binds both principals, layout, exact codec/domain, consumer and shared slice rule',()=>{
  const p=profile.create(options);assert.equal(p.binding.protocol,'pgstream-pool-intake-v2');assert.equal(p.binding.policy,legacy.POLICY);assert.equal(p.binding.sliceRule,RULE);
  assert.equal(p.digest,hash(p.binding));assert.equal(p.contractDigest,hash(['evaluator-work-v2',options.namespace,options.consumer,profile.PROTOCOL,p.digest]));
  assert.deepEqual(p.binding.controlReads,{...legacy.CONTROL_READS,tenant_lifecycle_requests:['tenant_id','request_id','artifact_digest','phase'],tenant_lifecycle_ceremony:['tenant_id','request_id','phase'],tenant_lifecycle_recommission:['tenant_id','request_id','generation','artifact_digest','activated']});assert.deepEqual(p.binding.workCatalogueRead,legacy.WORK_CATALOGUE_READ);assert.deepEqual(profile.DOMAIN,legacy.DOMAIN);
  assert.deepEqual(Object.keys(p).sort(),['binding','contractDigest','digest','ownerKey']);assert.strictEqual(profile.validate(p),p);
  assert(Object.isFrozen(p)&&Object.isFrozen(p.binding)&&Object.isFrozen(p.binding.controlReads)&&Object.isFrozen(p.binding.controlReads.tenant_lifecycle_windows)&&Object.isFrozen(p.binding.workCatalogueRead));
 });
 it('has no tenant population, assignment count or revision input and refuses these instead of ignoring them',()=>{
  for(const change of [{tenants:[]},{members:3},{revision:'7'},{assignment:{}},{currentGeneration:()=> '2'},{eligibility:'active'},{protocol:profile.PROTOCOL},{policy:profile.POLICY}])assert.throws(()=>profile.create({...options,...change}),/PGSTREAM_POOL_INTAKE_PROFILE/);
  const p=profile.create(options);for(const key of ['tenants','members','revision','assignment','currentGeneration','eligibility'])assert(!Object.hasOwn(p.binding,key)&&!Object.hasOwn(p,key));
 });
 it('changes infrastructure digest for each principal, namespace or consumer change',()=>{
  const p=profile.create(options);
  for(const change of [{namespace:'another_work'},{membershipNamespace:'another_members'},{lifecycleNamespace:'another_control'},{role:'another_intake'},{operatorRole:'another_operator'},{consumer:'evaluator-another'}]){
   const other=profile.create({...options,...change});assert.notEqual(other.digest,p.digest);assert.notEqual(other.contractDigest,p.contractDigest);
  }
 });
 it('keeps the v1 sole-intake owner resource while separating contract versions',()=>{
  const old=v1(),p=profile.create(options);assert.equal(p.ownerKey,old.ownerKey);assert.notEqual(p.digest,old.digest);assert.notEqual(p.contractDigest,old.contractDigest);
  assert.throws(()=>profile.validate(old),/PROFILE/);assert.throws(()=>legacy.validate(p),/PROFILE/);
  for(const change of [{operatorRole:'another_operator'},{role:'another_intake'}])assert.equal(profile.create({...options,...change}).ownerKey,p.ownerKey);
  for(const change of [{namespace:'another_work'},{consumer:'evaluator-another'}])assert.notEqual(profile.create({...options,...change}).ownerKey,p.ownerKey);
 });
 it('owns scalar getter values once before validating and branding',()=>{
  const counts={},source={};for(const key of Object.keys(options))Object.defineProperty(source,key,{enumerable:true,get(){counts[key]=(counts[key]||0)+1;return counts[key]===1?options[key]:'invalid-after-first-read';}});
  const p=profile.create(source);assert.equal(p.binding.namespace,options.namespace);assert.equal(p.binding.operatorRole,options.operatorRole);assert.deepEqual(counts,Object.fromEntries(Object.keys(options).map(key=>[key,1])));
  assert.strictEqual(profile.validate(p),p);
 });
 it('normalizes retained plain JSON with exact owned fields and rejects all authority/digest confusion',()=>{
  const p=profile.create(options),saved=JSON.parse(JSON.stringify(p)),safe=profile.validate(saved);assert.notStrictEqual(safe,saved);assert.equal(safe.digest,p.digest);assert.strictEqual(profile.validate(safe),safe);
  for(const patch of [{digest:'0'.repeat(64)},{contractDigest:'0'.repeat(64)},{ownerKey:'1'},{assignment:{owner:()=>0}},{binding:{...saved.binding,operatorRole:'another_operator'}},{binding:{...saved.binding,controlReads:{}}},{binding:{...saved.binding,workCatalogueRead:[]}},{binding:{...saved.binding,tenants:[]}},{binding:{...saved.binding,sliceRule:'different-rule'}},{binding:{...saved.binding,protocol:legacy.PROTOCOL}}])assert.throws(()=>profile.validate({...saved,...patch}),/PROFILE/);
 });
 it('copies retained getters once and never invokes caller iteration, species or toJSON',()=>{
  const p=profile.create(options),saved=JSON.parse(JSON.stringify(p));let reads=0;const binding=saved.binding;
  Object.defineProperty(saved,'binding',{enumerable:true,get(){reads++;return reads===1?binding:null;}});assert.equal(profile.validate(saved).digest,p.digest);assert.equal(reads,1);
  const refuse=()=>assert.fail('CALLER_HOOK_MUST_NOT_RUN');
  for(const hook of ['toJSON','constructor',Symbol.iterator]){
   const bad=JSON.parse(JSON.stringify(p)),array=bad.binding.workCatalogueRead;Object.defineProperty(array,hook,{get:refuse,enumerable:false});assert.throws(()=>profile.validate(bad),/PROFILE/);
  }
  const bad=JSON.parse(JSON.stringify(p));Object.defineProperty(bad,'toJSON',{get:refuse,enumerable:false});assert.throws(()=>profile.validate(bad),/PROFILE/);
  for(const key of ['toJSON','constructor','__proto__','prototype']){const nested=JSON.parse(JSON.stringify(p));Object.defineProperty(nested.binding,key,{get:refuse,enumerable:true});assert.throws(()=>profile.validate(nested),/PROFILE/);}
 });
 it('refuses nonprimitive scalars, unsafe names, duplicate principals, malformed plain values and oversized retained shapes',()=>{
  for(const patch of [{namespace:'pg_shadow'},{membershipNamespace:'public'},{lifecycleNamespace:options.namespace},{role:options.operatorRole},{operatorRole:'bad-role'},{operatorRole:options.role},{consumer:new String(options.consumer)},{codec:'another-codec'},{generationDomain:'another-domain'},{sliceRule:'another-rule'}])assert.throws(()=>profile.create({...options,...patch}),/PROFILE/);
  assert.throws(()=>profile.create(Object.create(options)),/PROFILE/);assert.throws(()=>profile.create({...options,[Symbol('extra')]:true}),/PROFILE/);
  const p=profile.create(options),bad=JSON.parse(JSON.stringify(p));bad.binding.controlReads.tenant_lifecycle_windows=new Array(33).fill('x');assert.throws(()=>profile.validate(bad),/PROFILE/);
  const cyclic=JSON.parse(JSON.stringify(p));cyclic.binding.controlReads.cycle=cyclic;assert.throws(()=>profile.validate(cyclic),/PROFILE/);
 });
 it('control: removing either principal from the binding makes incompatible-role separation RED, then restored GREEN',()=>{
  for(const [key,needle] of [['role','role:options.role,'],['operatorRole','operatorRole:options.operatorRole,']]){
   const broken=altered(needle,''),criterion=api=>assert.notEqual(api.create(options).digest,api.create({...options,[key]:'another_principal'}).digest,'PRINCIPAL_MUST_CHANGE_INFRASTRUCTURE_DIGEST');
   assert.throws(()=>criterion(broken),{code:'ERR_ASSERTION'});criterion(profile);
  }
 });
 it('control: removing exact retained-binding equality accepts forged catalogue metadata; intended refusal is RED then restored GREEN',()=>{
  const broken=altered('canonical(b)!==canonical(actual.binding)||',''),p=profile.create(options),criterion=api=>assert.throws(()=>api.validate({...p,binding:{...p.binding,controlReads:{}}}),/PROFILE/);
  assert.throws(()=>criterion(broken),{code:'ERR_ASSERTION'});criterion(profile);
 });
 it('control: bypassing the owned scalar snapshot fails getter ownership; restoration is GREEN',()=>{
  const broken=altered(' options=ownOptions(options);',''),criterion=api=>{let reads=0;const source={...options};Object.defineProperty(source,'operatorRole',{enumerable:true,get(){return ++reads===1?options.operatorRole:'unvalidated_changed_principal';}});const p=api.create(source);assert.equal(p.binding.operatorRole,options.operatorRole);assert.equal(reads,1,'ONLY_OWNED_PRINCIPAL_MAY_BE_BRANDED');};
  assert.throws(()=>criterion(broken),{code:'ERR_ASSERTION'});criterion(profile);
 });
});
