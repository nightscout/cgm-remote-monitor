'use strict';

// The native lifecycle selection: the evaluator checkpoint namespace and
// consumer that the lifecycle control namespace serves. Built by the role from
// its settings (lib/server/serve/deployment-settings.js); tenant artifacts
// cannot select it. It names no database identity: the stream state each
// tenant records in PostgreSQL is the only source identity
// (decision stream-source-identity-in-data).
const { createHash } = require('node:crypto');
const { canonical } = require('../server/serve/evaluator-runtime');
const { refuse } = require('./artifact');
const genuine = new WeakSet();
const name = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(value) && !value.startsWith('pg_') && !['public','information_schema'].includes(value);
function create (options) {
  if (!options || Object.keys(options).sort().join(',') !== 'consumer,lifecycleNamespace,namespace' ||
      !name(options.namespace) || !name(options.lifecycleNamespace) || options.namespace === options.lifecycleNamespace ||
      typeof options.consumer !== 'string' || !/^evaluator-[A-Za-z0-9_-]{1,100}$/.test(options.consumer)) throw refuse('LIFECYCLE_NATIVE_SELECTION_INVALID');
  const binding = Object.freeze({ namespace:options.namespace, lifecycleNamespace:options.lifecycleNamespace, consumer:options.consumer });
  const {CODEC,GENERATION_DOMAIN}=require('../pgstream/intake-profile');
  const contractDigest=createHash('sha256').update(canonical(['evaluator-work-v2',binding.namespace,binding.consumer,CODEC,GENERATION_DOMAIN])).digest('hex');
  const selectionDigest=createHash('sha256').update(canonical(['native-lifecycle-v1',binding,selectedCatalogue()])).digest('hex');
  const selection = Object.freeze({binding,contractDigest,selectionDigest,digest:selectionDigest});
  genuine.add(selection); return selection;
}
function validate (selection) {
  if (!genuine.has(selection)) throw refuse('LIFECYCLE_NATIVE_SELECTION_REQUIRED');
  return selection;
}
function bind (selection, namespace) {
  const value = validate(selection);
  if (value.binding.lifecycleNamespace !== namespace) throw refuse('LIFECYCLE_NATIVE_SELECTION_INVALID');
  return value;
}
function notificationBindings (values, selection) {
  const b=validate(selection).binding;
  if(!Array.isArray(values)||values.length>32)throw refuse('LIFECYCLE_NATIVE_SELECTION_INVALID');
  const rows=values.map(value=>{
    if(!value||Object.keys(value).sort().join(',')!=='consumer,namespace'||!name(value.namespace)||[b.namespace,b.lifecycleNamespace].includes(value.namespace)||typeof value.consumer!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value.consumer))throw refuse('LIFECYCLE_NATIVE_SELECTION_INVALID');
    return Object.freeze({namespace:value.namespace,consumer:value.consumer});
  });
  if(new Set(rows.map(value=>value.namespace)).size!==rows.length)throw refuse('LIFECYCLE_NATIVE_SELECTION_INVALID');
  return Object.freeze(rows);
}
function isNative(value){return genuine.has(value);}
function selectedCatalogue(){
 const base=require('./recommission-candidate').extend(require('./postgres-candidate.json'));
 const up=["ALTER TABLE tenant_lifecycle_windows ADD CONSTRAINT tenant_lifecycle_complete_generation "+require('./generation-domain').constraint()];
 const migration=Object.freeze({name:'0012_native_lifecycle_receipt_domain',up:Object.freeze(up),checksum:require('../migrations/catalogue').checksum(up)});
 return Object.freeze({version:1,migrations:Object.freeze([...base.migrations,migration])});
}
function catalogue(value){validate(value);return selectedCatalogue();}
function servingGrants({namespace,role}){if(!name(namespace)||!name(role))throw refuse('LIFECYCLE_NATIVE_SELECTION_INVALID');const columns=require('./pool-authority').READS[require('./recommission-candidate').TABLE];return ['GRANT SELECT ('+columns.join(',')+') ON "'+namespace+'".tenant_lifecycle_recommission TO "'+role+'"'];}
module.exports={create,validate,isNative,bind,catalogue,servingGrants,notificationBindings};
