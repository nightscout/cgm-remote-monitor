'use strict';
// Infrastructure compatibility only. Tenant eligibility and pool assignments
// remain current transaction inputs, never authority cached in this value.
const {createHash}=require('node:crypto');
const {canonical}=require('../server/serve/evaluator-runtime');
const {RULE}=require('../pool-membership/slice');
const {POLICY,CODEC,GENERATION_DOMAIN,DOMAIN,CONTROL_READS:LEGACY_CONTROL_READS,WORK_CATALOGUE_READ}=require('./intake-profile');
const PROTOCOL='pgstream-pool-intake-v2';
const AUTHORITY_READS=require('../tenant-lifecycle/pool-authority').READS;
const CONTROL_READS=Object.freeze(Object.fromEntries([...new Set([...Object.keys(LEGACY_CONTROL_READS),...Object.keys(AUTHORITY_READS)])].map(table=>[table,Object.freeze([...new Set([...(LEGACY_CONTROL_READS[table]||[]),...(AUTHORITY_READS[table]||[])])])])));

const FIELDS=Object.freeze(['codec','consumer','generationDomain','lifecycleNamespace','membershipNamespace','namespace','operatorRole','role','sliceRule']);
const PROFILE_FIELDS=Object.freeze(['binding','contractDigest','digest','ownerKey']);
const genuine=new WeakSet();
const refuse=()=>new TypeError('PGSTREAM_POOL_INTAKE_PROFILE');
const name=value=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(value)&&!value.startsWith('pg_')&&!['public','information_schema'].includes(value);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
function plain(value){return value!==null&&typeof value==='object'&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
function exact(value,fields){
 if(!plain(value))throw refuse();
 const keys=Reflect.ownKeys(value);
 if(keys.length!==fields.length||keys.some(key=>typeof key!=='string'||!fields.includes(key)||!Object.prototype.propertyIsEnumerable.call(value,key)))throw refuse();
}
function ownOptions(options){
 exact(options,FIELDS);
 // Access each caller field once; validation and hashing use this owned copy.
 return Object.fromEntries(FIELDS.map(key=>[key,options[key]]));
}
// Retained JSON may contain getters or proxies. Traverse a bounded plain shape
// by keys/indices, without calling caller iterators, species or toJSON hooks.
function ownJSON(value,state={remaining:256},depth=0){
 if(--state.remaining<0||depth>6)throw refuse();
 if(typeof value==='string'){if(value.length>4096)throw refuse();return value;}
 if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
 if(Array.isArray(value)){
  const length=value.length,keys=Reflect.ownKeys(value);
  if(!Number.isSafeInteger(length)||length>32||keys.length!==length+1||keys.some(key=>key!=='length'&&(typeof key!=='string'||!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=length)))throw refuse();
  const copy=new Array(length);for(let i=0;i<length;i++)copy[i]=ownJSON(value[i],state,depth+1);return copy;
 }
 if(!plain(value))throw refuse();
 const keys=Reflect.ownKeys(value);if(keys.length>32||keys.some(key=>typeof key!=='string'||key.length>128||['toJSON','constructor','__proto__','prototype'].includes(key)||!Object.prototype.propertyIsEnumerable.call(value,key)))throw refuse();
 const copy=Object.create(null);for(const key of keys)copy[key]=ownJSON(value[key],state,depth+1);return copy;
}
function create(options){
 options=ownOptions(options);
 if(!['namespace','membershipNamespace','lifecycleNamespace','role','operatorRole'].every(key=>name(options[key]))||new Set([options.namespace,options.membershipNamespace,options.lifecycleNamespace]).size!==3||options.role===options.operatorRole||typeof options.consumer!=='string'||!/^evaluator-[A-Za-z0-9_-]{1,100}$/.test(options.consumer)||options.codec!==CODEC||options.generationDomain!==GENERATION_DOMAIN||options.sliceRule!==RULE)throw refuse();
 const binding=Object.freeze({protocol:PROTOCOL,codec:CODEC,generationDomain:GENERATION_DOMAIN,controlReads:CONTROL_READS,workCatalogueRead:WORK_CATALOGUE_READ,policy:POLICY,namespace:options.namespace,membershipNamespace:options.membershipNamespace,lifecycleNamespace:options.lifecycleNamespace,role:options.role,operatorRole:options.operatorRole,consumer:options.consumer,sliceRule:RULE});
 const digest=hash(binding),contractDigest=hash(['evaluator-work-v2',options.namespace,options.consumer,PROTOCOL,digest]);
 // Both protocol versions contend for the same sole-intake owner resource.
 const ownerKey=BigInt.asIntN(64,BigInt('0x'+hash(['pgstream-evaluator-owner-v1',options.namespace,options.consumer]).slice(0,16))).toString();
 const profile=Object.freeze({binding,digest,contractDigest,ownerKey});genuine.add(profile);return profile;
}
function validate(profile){
 // Recognition caches immutable source-owned values, never SQL admission.
 if(genuine.has(profile))return profile;
 exact(profile,PROFILE_FIELDS);
 const saved=ownJSON(profile),b=saved.binding;
 if(!b||b.protocol!==PROTOCOL||b.policy!==POLICY)throw refuse();
 const options=Object.fromEntries(FIELDS.map(key=>[key,b[key]])),actual=create(options);
 if(canonical(b)!==canonical(actual.binding)||saved.digest!==actual.digest||saved.contractDigest!==actual.contractDigest||saved.ownerKey!==actual.ownerKey)throw refuse();
 return actual;
}
module.exports={create,validate,PROTOCOL,POLICY,CODEC,GENERATION_DOMAIN,DOMAIN,CONTROL_READS,WORK_CATALOGUE_READ,AUTHORITY_READS};
