'use strict';

// Private current deployment declaration. Tenant artifacts cannot select it.
// Native source admission uses the real database identity, a current caller
// configuration, and the existing lifecycle generation/maintenance claim.
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
  const selection = Object.freeze({binding,contractDigest:contract.digest});
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
  const q = table => '"'+namespace+'"."'+table+'"', who='"'+role+'"';
  return [
    'GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system(),pg_catalog.pg_control_checkpoint() TO '+who,
    'GRANT SELECT ON '+q('tenant_lifecycle_requests')+','+q('tenant_lifecycle_key_retention')+','+q('tenant_activity')+' TO '+who,
    'GRANT UPDATE(version,paused,suspended,deletion_request_id,paused_before_deletion) ON '+q('tenant_activity')+' TO '+who,
    'GRANT INSERT(tenant_id,version,verb,authority,principal,consumer,paused,suspended) ON '+q('tenant_activity_audit')+' TO '+who
  ];
}
async function activate (query, {namespace,tenant,claimId,generation,artifactDigest,required=false}) {
  if(!name(namespace)||![tenant,claimId].every(value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))||typeof generation!=='string'||!/^[1-9][0-9]{0,18}$/.test(generation)||typeof artifactDigest!=='string'||!/^[a-f0-9]{64}$/.test(artifactDigest)||typeof required!=='boolean')throw refuse('LIFECYCLE_NATIVE_SELECTION_INVALID');
  const q = table => '"'+namespace+'"."'+table+'"';
  const rows = (await query('SELECT /* native-recommission-activation */ t.deletion_request_id AS request_id,t.version::text AS version,t.paused_before_deletion FROM '+q('tenant_activity')+' t JOIN '+q('tenant_lifecycle_requests')+' r ON r.tenant_id=t.tenant_id AND r.request_id=t.deletion_request_id JOIN '+q('tenant_lifecycle_key_retention')+' k ON k.tenant_id=r.tenant_id AND k.request_id=r.request_id AND k.artifact_digest=r.artifact_digest JOIN '+q('tenant_lifecycle_restore_audit')+" a ON a.tenant_id=r.tenant_id AND a.artifact_digest=r.artifact_digest WHERE t.tenant_id=$1 AND EXISTS(SELECT 1 FROM "+q('tenant_lifecycle_windows')+" w WHERE w.tenant_id=t.tenant_id AND w.phase='active' AND w.generation=$3::bigint AND w.claim_id IS NULL AND w.artifact_digest IS NULL) AND t.suspended AND r.phase='executed' AND k.phase='restored' AND a.claim_id=$2 AND a.generation=$3::bigint AND a.artifact_digest=$4 AND a.role_oid=CURRENT_USER::regrole::oid AND ((a.state='activated' AND a.owner_pid=pg_backend_pid() AND a.owner_birth="+q('tenant_lifecycle_backend_birth')+"()) OR (a.state='restored' AND EXISTS(SELECT 1 FROM "+q('tenant_lifecycle_restore_resume')+" s WHERE s.tenant_id=a.tenant_id AND s.claim_id=a.claim_id AND s.generation=a.generation AND s.artifact_digest=a.artifact_digest AND s.interrupted='data-replaced' AND s.role_oid=CURRENT_USER::regrole::oid AND s.owner_pid=pg_backend_pid() AND s.owner_birth="+q('tenant_lifecycle_backend_birth')+"()))) FOR UPDATE OF t",[tenant,claimId,generation,artifactDigest])).rows;
  if (!rows.length && !required) return false;
  if (rows.length !== 1 || typeof rows[0].paused_before_deletion !== 'boolean') throw refuse('LIFECYCLE_NATIVE_RECOMMISSION_ACTIVATION_CHANGED');
  const row=rows[0],updated=await query('UPDATE '+q('tenant_activity')+' SET version=version+1,paused=$3,suspended=false,deletion_request_id=NULL,paused_before_deletion=NULL WHERE tenant_id=$1 AND version=$2::bigint AND deletion_request_id=$4 RETURNING version::text AS version,paused',[tenant,row.version,row.paused_before_deletion,row.request_id]);
  if (updated.rowCount!==1) throw refuse('LIFECYCLE_NATIVE_RECOMMISSION_ACTIVATION_CHANGED');
  const audit=await query('INSERT INTO '+q('tenant_activity_audit')+" (tenant_id,version,verb,authority,principal,consumer,paused,suspended) VALUES ($1,$2::bigint,'unsuspend','operator',CURRENT_USER::text,'recommission',$3,false)",[tenant,updated.rows[0].version,updated.rows[0].paused]);
  if(audit.rowCount!==1) throw refuse('LIFECYCLE_NATIVE_RECOMMISSION_ACTIVATION_CHANGED');
  return true;
}
module.exports={create,validate,bind,assertCurrent,notificationBindings,grants,activate};
