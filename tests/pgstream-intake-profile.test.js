'use strict';
// Default-off source identity only; no encoder/controller/runtime activation.
const assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const profile=require('../lib/pgstream/intake-profile');
const {canonical}=require('../lib/server/serve/evaluator-runtime');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const options={namespace:'intake_work',membershipNamespace:'intake_members',lifecycleNamespace:'intake_control',consumer:'evaluator-intake',role:'intake_writer',revision:'9007199254740993',members:2,tenants:[B,A],codec:'canonical-maintenance-active-plus2-v1',generationDomain:'positive-int8-complete-pair-max-4611686018427387902-v1'};
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
function altered(needle,replacement){const fs=require('node:fs'),Module=require('node:module'),path=require('node:path'),file=require.resolve('../lib/pgstream/intake-profile'),source=fs.readFileSync(file,'utf8');assert.equal(source.split(needle).length,2);const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(source.replace(needle,replacement),file);return m.exports;}
describe('proposed source-recognized immutable intake profile (no activation)',()=>{
 it('recognizes exactly the proposed codec/domain pair, deriving its exact complete generation domain without a caller maximum',()=>{
  const p=profile.create(options);assert.equal(p.binding.codec,'canonical-maintenance-active-plus2-v1');assert.equal(p.binding.generationDomain,'positive-int8-complete-pair-max-4611686018427387902-v1');assert.deepEqual(profile.DOMAIN,{minimum:'1',completeMaximum:'4611686018427387902'});assert(Object.isFrozen(profile.DOMAIN));
  for(const change of [{codec:undefined},{generationDomain:undefined},{codec:'research-codec'},{generationDomain:'research-domain'},{completeMaximum:'1'},{maxGeneration:'4611686018427387902'}])assert.throws(()=>profile.create({...options,...change}),/PGSTREAM_INTAKE_PROFILE/);
 });
 it('binds exact layout/principal/completed-consumer source/fixed assignment into canonical profile and typed row digests',()=>{
  const p=profile.create(options);assert.equal(p.digest,hash(p.binding));assert.equal(p.contractDigest,hash(['evaluator-work-v2','intake_work','evaluator-intake','pgstream-intake-v1',p.digest]));assert.deepEqual(p.binding.tenants,[A,B]);assert.equal(p.binding.revision,'9007199254740993');assert.equal(p.binding.policy,'active-or-suspended-metadata-v1');
  for(const change of [{namespace:'another_work'},{lifecycleNamespace:'another_control'},{membershipNamespace:'another_members'},{consumer:'evaluator-another'},{role:'another_intake'},{revision:'9007199254740994'},{members:1},{tenants:[A]}]){const other=profile.create({...options,...change});assert.notEqual(other.digest,p.digest);assert.notEqual(other.contractDigest,p.contractDigest);}
  assert.equal(profile.create({...options,tenants:[A,B]}).digest,p.digest);
 });
 it('declares canonical read-only control metadata and exact read-only work catalogue fields in the immutable binding',()=>{
  const p=profile.create(options);assert.deepEqual(Object.keys(p.binding.controlReads),['schema_migrations','tenant_lifecycle_windows','tenant_lifecycle_operations']);assert.deepEqual(p.binding.controlReads.tenant_lifecycle_windows,['tenant_id','lock_key','phase','generation','claim_id','artifact_digest']);assert.deepEqual(p.binding.controlReads.tenant_lifecycle_operations,['tenant_id','operation_id','generation','finished','owner_pid','owner_birth']);assert.deepEqual(p.binding.workCatalogueRead,['name','checksum']);
  assert(Object.isFrozen(p.binding)&&Object.isFrozen(p.binding.tenants)&&Object.isFrozen(p.binding.controlReads)&&Object.isFrozen(p.binding.controlReads.tenant_lifecycle_windows)&&Object.isFrozen(p.binding.workCatalogueRead));
 });
 it('revalidates retained JSON exactly, refusing forged metadata/roster/profile/digest while accepting a canonical round trip',()=>{
  const p=profile.create(options),saved=JSON.parse(JSON.stringify(p));assert.equal(profile.validate(saved).digest,p.digest);
  for(const change of [{digest:'0'.repeat(64)},{contractDigest:'0'.repeat(64)},{ownerKey:'17'},{binding:{...p.binding,controlReads:{}}},{binding:{...p.binding,workCatalogueRead:[]}},{binding:{...p.binding,tenants:[A]}},{binding:{...p.binding,codec:'research-codec'}},{binding:{...p.binding,extra:true}}])assert.throws(()=>profile.validate({...saved,...change}),/PROFILE/);
 });
 it('keeps the legacy global owner key stable across revision/profile changes and distinct across deployment/consumer',()=>{
  const p=profile.create(options),expected=BigInt.asIntN(64,BigInt('0x'+hash(['pgstream-evaluator-owner-v1',options.namespace,options.consumer]).slice(0,16))).toString();assert.equal(p.ownerKey,expected);for(const change of [{revision:'2'},{members:1},{role:'another_intake'},{tenants:[A]}])assert.equal(profile.create({...options,...change}).ownerKey,p.ownerKey);assert.notEqual(profile.create({...options,namespace:'another_work'}).ownerKey,p.ownerKey);assert.notEqual(profile.create({...options,consumer:'evaluator-another'}).ownerKey,p.ownerKey);
 });
 it('refuses namespace collisions/system names, unknown options and invalid/duplicate/out-of-domain fixed assignments',()=>{
  for(const change of [{namespace:'pg_shadow'},{lifecycleNamespace:'public'},{membershipNamespace:'intake_work'},{role:'bad-role'},{revision:9007199254740992},{revision:'9223372036854775808'},{revision:'0'},{tenants:[]},{tenants:[A,A]},{tenants:['not-uuid']},{unknown:true}])assert.throws(()=>profile.create({...options,...change}));
 });
 it('control: removing recognized-pair refusal makes unknown-pair criterion RED; restored source GREEN',()=>{
  const broken=altered('options.codec!==CODEC||options.generationDomain!==GENERATION_DOMAIN','false');
  const criterion=api=>{assert.throws(()=>api.create({...options,codec:'unrecognized-codec'}),/PROFILE/);assert.throws(()=>api.create({...options,generationDomain:'unrecognized-domain'}),/PROFILE/);};assert.throws(()=>criterion(broken),{code:'ERR_ASSERTION'});criterion(profile);
 });
 it('control: removing exact retained-binding comparison accepts a tampered control-read projection and makes criterion RED; restoration GREEN',()=>{
  const broken=altered('canonical(b)!==canonical(actual.binding)||',''),p=profile.create(options),criterion=api=>assert.throws(()=>api.validate({...p,binding:{...p.binding,controlReads:{}}}),/PROFILE/);assert.throws(()=>criterion(broken),{code:'ERR_ASSERTION'});criterion(profile);
 });
});
