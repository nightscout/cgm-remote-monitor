'use strict';

// Private current deployment declaration. Tenant artifacts cannot select it.
// Native source admission uses the real database identity, a current caller
// configuration, and the existing lifecycle generation/maintenance claim.
const { createHash } = require('node:crypto');
const { canonical } = require('../server/serve/evaluator-runtime');
const { isDeepStrictEqual } = require('node:util');
const stream = require('../storage/clinical-stream-state');
const { refuse } = require('./artifact');
const genuine = new WeakSet();
const name = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(value) && !value.startsWith('pg_') && !['public','information_schema'].includes(value);
function create (options) {
  if (!options || Object.keys(options).sort().join(',') !== 'consumer,generation,lifecycleNamespace,namespace,source' ||
      !name(options.namespace) || !name(options.lifecycleNamespace) || options.namespace === options.lifecycleNamespace ||
      typeof options.consumer !== 'string' || !/^evaluator-[A-Za-z0-9_-]{1,100}$/.test(options.consumer) ||
      typeof options.generation !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(options.generation)) throw refuse('LIFECYCLE_NATIVE_SELECTION_INVALID');
  const source = Object.freeze(stream.sourceIdentity(options.source));
  if (source.system_id.length>20 || source.database.length>63 || !isDeepStrictEqual(source, options.source)) throw refuse('LIFECYCLE_NATIVE_SELECTION_INVALID');
  const binding = Object.freeze({ namespace:options.namespace, lifecycleNamespace:options.lifecycleNamespace, consumer:options.consumer, source, generation:options.generation });
  const contract=require('../pgstream/checkpoint').create({typed:true,connection:{},namespace:binding.namespace,consumer:binding.consumer,maxBytes:1});
  const selection = Object.freeze({binding,contractDigest:contract.digest,digest:createHash('sha256').update(canonical(['native-lifecycle-v1',binding])).digest('hex')});
  genuine.add(selection); return selection;
}
function validate (selection) {
  if (!genuine.has(selection)) throw refuse('LIFECYCLE_NATIVE_SELECTION_REQUIRED');
  return selection;
}
async function assertCurrent (connection, selection, configuration) {
  const b = validate(selection).binding;
  if (!isDeepStrictEqual(configuration?.nativeSource, {source:b.source,generation:b.generation})) throw refuse('LIFECYCLE_NATIVE_SOURCE_CHANGED');
  const rows = (await connection.query(`SELECT /* native-lifecycle-source */ s.system_identifier::text AS system_id,c.timeline_id::integer AS timeline,current_database() AS database,
    EXISTS(SELECT 1 FROM pg_catalog.pg_replication_slots WHERE slot_name=$1 AND slot_type='logical' AND database=current_database()) AS slot
    FROM pg_catalog.pg_control_system() s CROSS JOIN pg_catalog.pg_control_checkpoint() c`, [b.source.slot])).rows;
  if (rows.length !== 1 || rows[0].slot !== true || !stream.sameSource({...rows[0],slot:b.source.slot},b.source)) throw refuse('LIFECYCLE_NATIVE_SOURCE_CHANGED');
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
function grants ({namespace,role}) {
  if (!name(namespace) || !name(role)) throw refuse('LIFECYCLE_NATIVE_SELECTION_INVALID');
  return ['GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system(),pg_catalog.pg_control_checkpoint() TO "'+role+'"'];
}
function isNative(value){return genuine.has(value);}
function catalogue(value){validate(value);return require('./recommission-candidate').extend(require('./postgres-candidate.json'));}
function servingGrants({namespace,role}){if(!name(namespace)||!name(role))throw refuse('LIFECYCLE_NATIVE_SELECTION_INVALID');const columns=require('./pool-authority').READS[require('./recommission-candidate').TABLE];return ['GRANT SELECT ('+columns.join(',')+') ON \"'+namespace+'\".tenant_lifecycle_recommission TO \"'+role+'\"'];}
module.exports={create,validate,isNative,bind,catalogue,servingGrants,assertCurrent,notificationBindings,grants};
