'use strict';
// Exact catalogue source for admitting an explicitly bound predecessor.
const profiles=require('./pool-intake-profile'),legacyProfiles=require('./intake-profile');
const catalogue=require('../migrations/catalogue');
const {canonical}=require('../server/serve/evaluator-runtime');
const literal=value=>"'"+String(value).replace(/'/g,"''")+"'";
const fail=code=>Object.assign(new Error(code),{code});
const PROFILE_CHECK='pgstream_intake_profile_check',ORIGIN_MIGRATION='0008_evaluator_pool_intake_from_selected_v1';
function binding(profile,predecessorProfile){
 const p=profiles.validate(profile),old=legacyProfiles.validate(predecessorProfile),b=p.binding,previous=old.binding;
 if(['namespace','membershipNamespace','lifecycleNamespace','consumer','codec','generationDomain'].some(key=>b[key]!==previous[key]))throw fail('PGSTREAM_POOL_ADOPTION_BINDING');return {profile:p,predecessorProfile:old};
}
function fresh(value){
 const b=value.binding,legacy=require('./assignment-candidate').build(b),assignment=require('./pool-assignment-candidate').build({base:legacy,membershipNamespace:b.membershipNamespace,lifecycleNamespace:b.lifecycleNamespace,operatorRole:b.operatorRole});
 const intake=require('./pool-intake-candidate').build({base:assignment,intakeProfile:value});return require('./pool-checkpoint-provision-candidate').build({base:intake,intakeProfile:value});
}
function profileCheck(migration){const statement=migration.up.find(sql=>sql.startsWith('CREATE TABLE pgstream_intake_profile ')),match=statement&&/CHECK \((.*)\)\)$/.exec(statement);if(!match)throw fail('PGSTREAM_POOL_ADOPTION_PROFILE_SOURCE');return match[1];}
function extendCatalogue({base,profile,predecessorProfile}){
 const pair=binding(profile,predecessorProfile),p=pair.profile,old=pair.predecessorProfile,b=p.binding,expected=fresh(p);
 if(!base||canonical(base.catalogue)!==canonical(expected.catalogue)||base.effectBody!==expected.effectBody||base.assignmentBody!==expected.assignmentBody||base.intakeAssertBody!==expected.intakeAssertBody||base.provisionBody!==expected.provisionBody)throw fail('PGSTREAM_POOL_ADOPTION_FRESH_SOURCE');
 const previous=require('./assignment-candidate').build({...old.binding,intakeProfile:old});
 const original=expected.catalogue.migrations.find(m=>m.name==='0008_evaluator_pool_intake');if(!original||original.up.length!==7)throw fail('PGSTREAM_POOL_ADOPTION_PROFILE_SOURCE');
 const up=[
  'ALTER TABLE pgstream_intake_profile DROP CONSTRAINT '+PROFILE_CHECK,
  'UPDATE pgstream_intake_profile SET profile='+literal(JSON.stringify(b))+'::jsonb,digest='+literal(p.digest)+',contract_digest='+literal(p.contractDigest)+' WHERE consumer='+literal(b.consumer+'-completed')+' AND profile='+literal(JSON.stringify(old.binding))+'::jsonb AND digest='+literal(old.digest)+' AND contract_digest='+literal(old.contractDigest),
  'ALTER TABLE pgstream_intake_profile ADD CONSTRAINT '+PROFILE_CHECK+' CHECK ('+profileCheck(original)+')',
  ...original.up.slice(3).map(sql=>sql.startsWith('CREATE FUNCTION pgstream_intake_assert()')?sql.replace('CREATE FUNCTION ','CREATE OR REPLACE FUNCTION '):sql)
 ];
 const replacement={name:ORIGIN_MIGRATION,up,checksum:catalogue.checksum(up)},tail=expected.catalogue.migrations.filter(m=>m.name>='0006').map(m=>m===original?replacement:m);
 const result={...expected,predecessorProfile:old,catalogue:{version:1,migrations:[...previous.catalogue.migrations,...tail]}};catalogue.validateCatalogue(result.catalogue);return result;
}
module.exports = { extendCatalogue };
