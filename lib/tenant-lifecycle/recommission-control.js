'use strict';

// The link is historical evidence that a particular deletion was superseded,
// never a replacement for the current physical lifecycle generation/authority.
// Called only inside the controller's final activation/resume transaction.
const { TABLE } = require('./recommission-candidate');
const { refuse } = require('./artifact');
const MODE = 'exact-artifact-recommission';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const q = (namespace, table) => '"' + namespace + '"."' + table + '"';
function selected (profile) {
  if(require('./native-selection').isNative(profile))return true;
  const source = require('../pgstream/pool-intake-profile');
  if (profile?.binding?.protocol !== source.PROTOCOL) return false;
  source.validate(profile); return true;
}
async function activate (query, { namespace, tenant, claimId, generation, artifactDigest, required = false }) {
  if (typeof query !== 'function' || typeof namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) ||
      namespace === 'public' || namespace.startsWith('pg_') || namespace === 'information_schema' || !UUID.test(tenant || '') || !UUID.test(claimId || '') || !/^[a-f0-9]{64}$/.test(artifactDigest || '') || typeof required !== 'boolean') throw refuse('LIFECYCLE_RECOMMISSION_INPUT_INVALID');
  require('./generation-domain').assertGeneration(generation);
  const result = await query('UPDATE /* recommission-activate */ ' + q(namespace, TABLE) +
    ' SET activated=true WHERE tenant_id=$1 AND claim_id=$2 AND generation=$3::bigint AND artifact_digest=$4 AND NOT activated RETURNING request_id',
  [tenant, claimId, generation, artifactDigest]);
  if (result.rowCount === 0 && !required) return false;
  if (result.rowCount !== 1 || result.rows.length !== 1) throw refuse('LIFECYCLE_RECOMMISSION_ACTIVATION_CHANGED');
  const requestId = result.rows[0].request_id;
  if (!UUID.test(requestId || '')) throw refuse('LIFECYCLE_RECOMMISSION_ACTIVATION_CHANGED');
  const activity = (await query('SELECT /* recommission-current-activity */ version::text AS version,paused,suspended,deletion_request_id,paused_before_deletion FROM ' +
    q(namespace, 'tenant_activity') + ' WHERE tenant_id=$1 FOR UPDATE', [tenant])).rows;
  if (activity.length !== 1 || activity[0].deletion_request_id !== requestId || activity[0].suspended !== true || typeof activity[0].paused_before_deletion !== 'boolean') {
    throw refuse('LIFECYCLE_RECOMMISSION_ACTIVITY_CHANGED');
  }
  const changed = await query('UPDATE /* recommission-restore-activity */ ' + q(namespace, 'tenant_activity') +
    ' SET version=version+1,paused=$3,suspended=false,deletion_request_id=NULL,paused_before_deletion=NULL WHERE tenant_id=$1 AND version=$2::bigint AND deletion_request_id=$4 RETURNING version::text AS version,paused',
  [tenant, activity[0].version, activity[0].paused_before_deletion, requestId]);
  if (changed.rowCount !== 1 || changed.rows.length !== 1) throw refuse('LIFECYCLE_RECOMMISSION_ACTIVITY_CHANGED');
  const audited = await query('INSERT /* recommission-activity-audit */ INTO ' + q(namespace, 'tenant_activity_audit') +
    " (tenant_id,version,verb,authority,principal,consumer,paused,suspended) VALUES ($1,$2::bigint,'unsuspend','operator',CURRENT_USER::text,'recommission',$3,false)",
  [tenant, changed.rows[0].version, changed.rows[0].paused]);
  if (audited.rowCount !== 1) throw refuse('LIFECYCLE_RECOMMISSION_ACTIVITY_CHANGED');
  return true;
}
function grants ({ namespace, role }) {
  // Reuse the source-owned identifier validation and link grants.
  const result = require('./recommission-readiness').operatorGrants({ namespace, role });
  const who = '"' + role + '"';
  return Object.freeze([...result,
    'GRANT SELECT (tenant_id,version,paused,suspended,deletion_request_id,paused_before_deletion), UPDATE (version,paused,suspended,deletion_request_id,paused_before_deletion) ON ' + q(namespace, 'tenant_activity') + ' TO ' + who,
    'GRANT INSERT (tenant_id,version,verb,authority,principal,consumer,paused,suspended) ON ' + q(namespace, 'tenant_activity_audit') + ' TO ' + who
  ]);
}
module.exports = { MODE, selected, activate, grants };
