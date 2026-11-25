'use strict';
// Selected source capability only. This module never executes DDL or converts state.
// Load the profile lazily: its control-read description imports readiness layouts.
const {checksum,validateCatalogue}=require('../migrations/catalogue');
const legacy=require('./postgres-candidate.json');
// Complete-pair generation domain shared by every lifecycle selection.
const DOMAIN=Object.freeze({minimum:'1',completeMaximum:'4611686018427387902'});
const fail=()=>Object.assign(new Error('LIFECYCLE_GENERATION_DOMAIN_UNSUPPORTED'),{code:'LIFECYCLE_GENERATION_DOMAIN_UNSUPPORTED'});
function recognize(value){
 if(require('./native-selection').isNative(value))return value;
 if(value?.binding?.protocol===require('../pgstream/pool-intake-profile').PROTOCOL)return require('../pgstream/pool-intake-profile').validate(value);
 return require('../pgstream/intake-profile').validate(value);
}
function isPool(profile){return profile.binding.protocol===require('../pgstream/pool-intake-profile').PROTOCOL;}
function bind(value,namespace,tenants){
 if(value===undefined)return undefined;
 const profile=recognize(value);
 if(profile.binding.lifecycleNamespace!==namespace||!isPool(profile)&&!require('./native-selection').isNative(profile)&&tenants&&JSON.stringify([...tenants].sort())!==JSON.stringify(profile.binding.tenants))throw new TypeError('LIFECYCLE_INTAKE_PROFILE_BINDING');
 return profile;
}
function constraint(){return "CHECK ('"+DOMAIN.completeMaximum+"'::bigint >= generation)";}
function catalogue(profile){
 if(!profile)throw new TypeError('LIFECYCLE_INTAKE_PROFILE_REQUIRED');
 profile=recognize(profile);
 if(require('./native-selection').isNative(profile))return require('./native-selection').catalogue(profile);
 const up=["ALTER TABLE tenant_lifecycle_windows ADD CONSTRAINT tenant_lifecycle_complete_generation "+constraint()];
 const selected=Object.freeze({version:1,migrations:Object.freeze([...validateCatalogue(legacy),Object.freeze({name:'0010_selected_lifecycle_generation_domain',up:Object.freeze(up),checksum:checksum(up)})])});
 return isPool(profile)?require('./recommission-candidate').extend(selected):selected;
}
function assertGeneration(generation,{next=false}={}){
 const {minimum,completeMaximum}=DOMAIN;
 if(typeof generation!=='string'||!/^[1-9][0-9]{0,18}$/.test(generation)||BigInt(generation)<BigInt(minimum)||BigInt(generation)+(next?1n:0n)>BigInt(completeMaximum))throw fail();
 return generation;
}
function validateRoster(profile,rows){
 const selected=recognize(profile);
 if(!Array.isArray(rows)||rows.length>10000||isPool(selected)&&rows.some(row=>typeof row?.tenant!=='string'||!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(row.tenant))||!isPool(selected)&&rows.length!==selected.binding.tenants.length||new Set(rows.map(row=>row?.tenant)).size!==rows.length||!isPool(selected)&&JSON.stringify(rows.map(row=>row?.tenant).sort())!==JSON.stringify(selected.binding.tenants))throw new TypeError('LIFECYCLE_DOMAIN_FULL_NAMESPACE_COVERAGE');
 for(const row of rows){if(!['active','suspended'].includes(row.phase))throw new TypeError('LIFECYCLE_DOMAIN_PHASE');assertGeneration(row.generation);}
 return selected;
}
function adoptionPlan(value){
 const selected=recognize(value),namespace=selected.binding.lifecycleNamespace;
 return Object.freeze({kind:'DECLARED_LIFECYCLE_ADOPTION_PLAN_NOT_INSTALLER',profile:selected,catalogue:catalogue(selected),namespace,
  lockSQL:'LOCK TABLE "'+namespace+'".tenant_lifecycle_windows IN ACCESS EXCLUSIVE MODE',
  rosterSQL:'SELECT tenant_id::text AS tenant,phase,generation::text FROM "'+namespace+'".tenant_lifecycle_windows ORDER BY tenant_id',
  requiredAuthority:'existing migration-owner/admin with independently verified full-namespace visibility; serving operator has no ALTER',
  transaction:'one externally owned transaction: lock, full namespace/declared coverage validation, validated CHECK, selected ledger and immutable intake profile; rollback everything on refusal',
  integration:'OPEN: immutable intake SQL installation is not adopted here; do not execute lifecycle-only DDL as complete profile adoption'});
}
module.exports={DOMAIN,recognize,isPool,bind,constraint,catalogue,assertGeneration,validateRoster,adoptionPlan};
