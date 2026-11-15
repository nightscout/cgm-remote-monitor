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
  const p=profile.create(options),saved=JSON.parse(JSON.stringify(p));assert.equal(profile.validate(saved).digest,p.digest);const forged={...p,assignment:{...p.assignment,owner:()=>{throw new Error('FORGED_ASSIGNMENT_MUST_NOT_RUN');},select:()=>{throw new Error('FORGED_ASSIGNMENT_MUST_NOT_RUN');}}},normalized=profile.validate(forged);assert.notEqual(normalized.assignment,forged.assignment);assert.equal(normalized.assignment.owner(A),p.assignment.owner(A));assert.deepEqual(normalized.assignment.tenants,p.assignment.tenants);
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
function countedProfile(mutate=source=>source){
 const fs=require('node:fs'),Module=require('node:module'),path=require('node:path'),file=require.resolve('../lib/pgstream/intake-profile'),source=mutate(fs.readFileSync(file,'utf8')),m=new Module(file,module),fixed=require('../lib/pgstream/fixed-assignment');let rebuilds=0,entries=0;
 m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const original=m.require.bind(m);m.require=name=>name==='./fixed-assignment'?{create:options=>{rebuilds++;entries+=options.tenants.length;return fixed.create(options);}}:original(name);m._compile(source,file);return {api:m.exports,reset(){rebuilds=0;entries=0;},counts:()=>({rebuilds,entries})};
}
describe('immutable profile value ownership and fastpath',()=>{
 it('validates a known genuine immutable 10k profile without rebuilding its roster/hash',()=>{
  const f=countedProfile(),tenants=Array.from({length:10000},(_,i)=>'00000000-0000-4000-8000-'+(i+1).toString(16).padStart(12,'0')),p=f.api.create({...options,tenants});f.reset();for(let i=0;i<5;i++)assert.equal(f.api.validate(p).digest,p.digest);assert.deepEqual(f.counts(),{rebuilds:0,entries:0},'KNOWN_IMMUTABLE_PROFILE_MUST_NOT_REBUILD');
 });
 it('owns a namespace getter value once before validation/binding/branding',()=>{
  let reads=0;const source={...options};Object.defineProperty(source,'namespace',{enumerable:true,get(){return ++reads<=2?'intake_work':'pg_shadow';}});const p=profile.create(source);assert.equal(p.binding.namespace,'intake_work','ONLY_OWNED_VALIDATED_NAMESPACE_MAY_BE_BOUND');assert.equal(reads,1);assert.equal(profile.validate(p).binding.namespace,'intake_work');
 });
 it('owns each roster index once rather than accepting a later getter value',()=>{
  let reads=0;const tenants=[];Object.defineProperty(tenants,'0',{enumerable:true,configurable:true,get(){return ++reads===1?A:B;}});const p=profile.create({...options,tenants});assert.deepEqual(p.binding.tenants,[A],'ONLY_OWNED_VALIDATED_ROSTER_MAY_BE_BOUND');assert.equal(reads,1);assert.deepEqual(profile.validate(p).binding.tenants,[A]);
 });
 it('never invokes a caller roster iterator/species/toJSON while snapshotting bounded indexed entries',()=>{
  const tenants=[A],refuse=()=>{throw new Error('CALLER_ROSTER_HOOK_MUST_NOT_RUN');};tenants[Symbol.iterator]=refuse;tenants.toJSON=refuse;Object.defineProperty(tenants,'constructor',{get:refuse});const source={...options,tenants};Object.defineProperty(source,'toJSON',{value:refuse});const p=profile.create(source);assert.deepEqual(p.binding.tenants,[A]);assert.equal(profile.validate(p).digest,p.digest);
 });
 it('requires primitive scalar strings and safe fixed numeric values before any profile is branded',()=>{
  assert.throws(()=>profile.create({...options,consumer:{toString:()=> 'evaluator-intake'}}),/PROFILE/);assert.throws(()=>profile.create({...options,members:new Number(2)}));assert.throws(()=>profile.create({...options,revision:{toString:()=> '1'}}));
 });
 it('fully normalizes unknown JSON/clones/proxies, discards forged assignment functions and then recognizes only the safe returned value',()=>{
  const f=countedProfile(),p=f.api.create(options),clone=JSON.parse(JSON.stringify(p));clone.assignment={owner:()=>{throw new Error('FORGED_ASSIGNMENT_MUST_NOT_RUN');}};
  for(const unknown of [clone,{...p,assignment:clone.assignment},new Proxy(p,{})]){f.reset();const safe=f.api.validate(unknown);assert.deepEqual(f.counts(),{rebuilds:1,entries:2});assert.notEqual(safe,unknown);assert.equal(safe.assignment.owner(A),p.assignment.owner(A));f.reset();assert.strictEqual(f.api.validate(safe),safe);assert.deepEqual(f.counts(),{rebuilds:0,entries:0});}
  const bad=JSON.parse(JSON.stringify(p));bad.binding.role='changed_intake';assert.throws(()=>f.api.validate(bad),/PROFILE/);
 });
});
describe('immutable profile memoization controls and compatibility',()=>{
 it('retains the exact published ordinary binding digests and stable owner key',()=>{
  const p=profile.create(options);assert.equal(p.digest,'731c9aa4bdf4b8dee9a24acfe993705b3e90338465b2bbe77c54d647a0783ee0');assert.equal(p.contractDigest,'ad0c9de9f68a2dff9921545f6cf4bd0a5e3513c0dc9b37d20e1cbe9ba5e3f39d');assert.equal(p.ownerKey,'-5483210377315940895');assert.strictEqual(profile.validate(p),p);
 });
 it('control: removing genuine-value recognition rebuilds a known roster and makes the zero-rebuild criterion RED; restored GREEN',()=>{
  const needle='if(genuine.has(profile))return profile;',broken=countedProfile(source=>{assert.equal(source.split(needle).length,2);return source.replace(needle,'');});
  const criterion=f=>{const p=f.api.create(options);f.reset();f.api.validate(p);assert.deepEqual(f.counts(),{rebuilds:0,entries:0},'KNOWN_IMMUTABLE_PROFILE_MUST_NOT_REBUILD');};assert.throws(()=>criterion(broken),{code:'ERR_ASSERTION'});criterion(countedProfile());
 });
 it('control: removing owned snapshot permits an unvalidated getter-selected binding to be branded and makes criterion RED; restored GREEN',()=>{
  const broken=altered(' options=ownOptions(options);',''),criterion=api=>{let reads=0;const source={...options};Object.defineProperty(source,'namespace',{enumerable:true,get(){return ++reads<=2?'intake_work':'pg_shadow';}});const p=api.create(source);assert.equal(p.binding.namespace,'intake_work','ONLY_OWNED_VALIDATED_NAMESPACE_MAY_BE_BRANDED');assert.equal(api.validate(p).binding.namespace,'intake_work');};assert.throws(()=>criterion(broken),{code:'ERR_ASSERTION'});criterion(profile);
 });
 it('control: removing primitive consumer validation would retain caller mutable state and makes the refusal criterion RED; restored GREEN',()=>{
  const broken=altered("typeof options.consumer!=='string'||",''),criterion=api=>assert.throws(()=>api.create({...options,consumer:{toString:()=> 'evaluator-intake'}}),/PROFILE/);assert.throws(()=>criterion(broken),{code:'ERR_ASSERTION'});criterion(profile);
 });
});
