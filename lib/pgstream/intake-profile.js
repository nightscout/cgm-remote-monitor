'use strict';
// Proposed explicit source capability. No constructor or boot path selects it.
const {createHash}=require('node:crypto');
const {canonical}=require('../server/serve/evaluator-runtime');
const fixed=require('./fixed-assignment');
const PROTOCOL='pgstream-intake-v1',POLICY='active-or-suspended-metadata-v1';
const CODEC='canonical-maintenance-active-plus2-v1',GENERATION_DOMAIN='positive-int8-complete-pair-max-4611686018427387902-v1';
const WORK_CATALOGUE_READ=Object.freeze(['name','checksum']);
const DOMAIN=Object.freeze({minimum:'1',completeMaximum:'4611686018427387902'});
const layouts=require('../tenant-lifecycle/operation-window-readiness').layouts;
const CONTROL_READS=Object.freeze(Object.fromEntries(['schema_migrations','tenant_lifecycle_windows','tenant_lifecycle_operations'].map(table=>[table,Object.freeze(layouts[table].map(c=>c[0]))])));
const FIELDS=['codec','consumer','generationDomain','lifecycleNamespace','members','membershipNamespace','namespace','revision','role','tenants'];
const name=value=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(value)&&!value.startsWith('pg_')&&!['public','information_schema'].includes(value);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
function create(options){
 if(!options||Object.keys(options).sort().join(',')!==FIELDS.join(',')||!['namespace','membershipNamespace','lifecycleNamespace','role'].every(key=>name(options[key]))||new Set([options.namespace,options.membershipNamespace,options.lifecycleNamespace]).size!==3||!/^evaluator-[A-Za-z0-9_-]{1,100}$/.test(options.consumer)||options.codec!==CODEC||options.generationDomain!==GENERATION_DOMAIN)throw new TypeError('PGSTREAM_INTAKE_PROFILE');
 const assignment=fixed.create(options),binding=Object.freeze({protocol:PROTOCOL,codec:CODEC,generationDomain:GENERATION_DOMAIN,controlReads:CONTROL_READS,workCatalogueRead:WORK_CATALOGUE_READ,policy:POLICY,namespace:options.namespace,membershipNamespace:options.membershipNamespace,lifecycleNamespace:options.lifecycleNamespace,role:options.role,consumer:options.consumer,revision:assignment.revision,members:assignment.members,tenants:assignment.tenants});
 const digest=hash(binding),contractDigest=hash(['evaluator-work-v2',options.namespace,options.consumer,PROTOCOL,digest]);
 const ownerKey=BigInt.asIntN(64,BigInt('0x'+hash(['pgstream-evaluator-owner-v1',options.namespace,options.consumer]).slice(0,16))).toString();
 return Object.freeze({binding,digest,contractDigest,ownerKey,assignment});
}
function validate(profile){
 const b=profile?.binding;if(!b||b.protocol!==PROTOCOL||b.policy!==POLICY)throw new TypeError('PGSTREAM_INTAKE_PROFILE');
 const copy={...b};delete copy.protocol;delete copy.policy;delete copy.controlReads;delete copy.workCatalogueRead;const actual=create(copy);
 if(canonical(b)!==canonical(actual.binding)||profile.digest!==actual.digest||profile.contractDigest!==actual.contractDigest||profile.ownerKey!==actual.ownerKey)throw new TypeError('PGSTREAM_INTAKE_PROFILE');return actual;
}
module.exports={create,validate,PROTOCOL,POLICY,CODEC,GENERATION_DOMAIN,DOMAIN,CONTROL_READS,WORK_CATALOGUE_READ,name};
