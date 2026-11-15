'use strict';
// Selected source capability only. This module never executes DDL or converts state.
// Load the profile lazily: its control-read description imports readiness layouts.
const {checksum,validateCatalogue}=require('../migrations/catalogue');
const legacy=require('./postgres-candidate.json');
const fail=()=>Object.assign(new Error('LIFECYCLE_GENERATION_DOMAIN_UNSUPPORTED'),{code:'LIFECYCLE_GENERATION_DOMAIN_UNSUPPORTED'});
function bind(value,namespace,tenants){
 if(value===undefined)return undefined;
 const profile=require('../pgstream/intake-profile').validate(value);
 if(profile.binding.lifecycleNamespace!==namespace||tenants&&JSON.stringify([...tenants].sort())!==JSON.stringify(profile.binding.tenants))throw new TypeError('LIFECYCLE_INTAKE_PROFILE_BINDING');
 return profile;
}
function constraint(){return "CHECK ('"+require('../pgstream/intake-profile').DOMAIN.completeMaximum+"'::bigint >= generation)";}
function catalogue(profile){
 if(!profile)throw new TypeError('LIFECYCLE_INTAKE_PROFILE_REQUIRED');
 require('../pgstream/intake-profile').validate(profile);
 const up=["ALTER TABLE tenant_lifecycle_windows ADD CONSTRAINT tenant_lifecycle_complete_generation "+constraint()];
 return Object.freeze({version:1,migrations:Object.freeze([...validateCatalogue(legacy),Object.freeze({name:'0010_selected_lifecycle_generation_domain',up:Object.freeze(up),checksum:checksum(up)})])});
}
function assertGeneration(generation,{next=false}={}){
 const {minimum,completeMaximum}=require('../pgstream/intake-profile').DOMAIN;
 if(typeof generation!=='string'||!/^[1-9][0-9]{0,18}$/.test(generation)||BigInt(generation)<BigInt(minimum)||BigInt(generation)+(next?1n:0n)>BigInt(completeMaximum))throw fail();
 return generation;
}
function validateRoster(profile,rows){
 const selected=require('../pgstream/intake-profile').validate(profile);
 if(!Array.isArray(rows)||rows.length!==selected.binding.tenants.length||new Set(rows.map(row=>row?.tenant)).size!==rows.length||JSON.stringify(rows.map(row=>row?.tenant).sort())!==JSON.stringify(selected.binding.tenants))throw new TypeError('LIFECYCLE_DOMAIN_FULL_NAMESPACE_COVERAGE');
 for(const row of rows){if(!['active','suspended'].includes(row.phase))throw new TypeError('LIFECYCLE_DOMAIN_PHASE');assertGeneration(row.generation);}
 return selected;
}
function adoptionPlan(value){
 const selected=require('../pgstream/intake-profile').validate(value),namespace=selected.binding.lifecycleNamespace;
 return Object.freeze({kind:'DECLARED_LIFECYCLE_ADOPTION_PLAN_NOT_INSTALLER',profile:selected,catalogue:catalogue(selected),namespace,
  lockSQL:'LOCK TABLE "'+namespace+'".tenant_lifecycle_windows IN ACCESS EXCLUSIVE MODE',
  rosterSQL:'SELECT tenant_id::text AS tenant,phase,generation::text FROM "'+namespace+'".tenant_lifecycle_windows ORDER BY tenant_id',
  requiredAuthority:'existing migration-owner/admin with independently verified full-namespace visibility; serving operator has no ALTER',
  transaction:'one externally owned transaction: lock, full namespace/declared coverage validation, validated CHECK, selected ledger and immutable intake profile; rollback everything on refusal',
  integration:'OPEN: immutable intake SQL installation is not adopted here; do not execute lifecycle-only DDL as complete profile adoption'});
}
module.exports={bind,constraint,catalogue,assertGeneration,validateRoster,adoptionPlan};
