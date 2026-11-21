'use strict';
// Fresh disabled typed checkpoint only. The existing maintenance wrapper owns
// transaction/claim/commit/activation; BASE replay provisioning stays its caller's.
const profiles = require('./pool-intake-profile');
const { RULE, MAX_MEMBERS, bucket } = require('../pool-membership/slice');
const transactionLock = require('../pool-membership/transaction-lock');
const definition = require('./pool-checkpoint-provision-candidate');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = code => Object.assign(new Error(code), { code });
const q = value => '"' + value + '"';
function authoritySQL (profile) {
  const l = q(profile.binding.lifecycleNamespace), n = q(profile.binding.namespace);
  return `SELECT /* pool-checkpoint-provision-authority */ pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid,current_setting('app.current_tenant_id',true) AS tenant,CURRENT_USER::regrole::oid::text AS role_oid,${l}.tenant_lifecycle_backend_birth()::text AS birth,
    w.generation::text AS generation,w.claim_id::text AS claim_id,w.artifact_digest,w.phase,
    a.role_oid::text AS audit_role,a.owner_pid,a.owner_birth::text AS owner_birth,a.state,a.restored_at IS NULL AS unrestored,a.activated_at IS NULL AS unactivated,
    EXISTS(SELECT 1 FROM ${l}.tenant_lifecycle_restore_authority r WHERE r.tenant_id=w.tenant_id AND r.role_oid=CURRENT_USER::regrole::oid AND r.active) AS authorized,
    EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid=pg_backend_pid() AND classid=((w.lock_key>>32)&4294967295)::oid AND objid=(w.lock_key&4294967295)::oid AND objsubid=1 AND mode='ExclusiveLock' AND granted) AS lifetime_held,
    r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication,
    pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid=to_regclass('${n}.tenant_consumer_checkpoint')),'MEMBER') AS owns_checkpoint,
    pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid=to_regclass('${l}.tenant_lifecycle_windows')),'MEMBER') AS owns_lifecycle
    FROM ${l}.tenant_lifecycle_windows w JOIN ${l}.tenant_lifecycle_restore_audit a ON a.tenant_id=w.tenant_id AND a.claim_id=w.claim_id AND a.generation=w.generation AND a.artifact_digest=w.artifact_digest JOIN pg_roles r ON r.oid=CURRENT_USER::regrole WHERE w.tenant_id=$1`;
}
async function provisionCheckpoint (query, suppliedProfile, options, {predecessorProfile} = {}) {
  const profile = profiles.validate(suppliedProfile), b = profile.binding;
  if (typeof query !== 'function' || !options || Object.keys(options).sort().join(',') !== 'enabled,generation,tenant' || options.enabled !== false || typeof options.tenant !== 'string' || !UUID.test(options.tenant) || options.tenant === '00000000-0000-0000-0000-000000000000') throw new TypeError('PGSTREAM_POOL_PROVISION_INPUT');
  const tenant = options.tenant, generation = require('../tenant-lifecycle/generation-domain').assertGeneration(options.generation);
  const observedAt = Date.now();
  if (!Number.isSafeInteger(observedAt) || observedAt < 0 || observedAt >= 8640000000000000) throw fail('PGSTREAM_POOL_PROVISION_TIME');
  let original;
  async function authority () {
    const rows = (await query(authoritySQL(profile), [tenant])).rows, row = rows[0];
    if (rows.length !== 1 || !row || !Number.isSafeInteger(row.pid) || row.pid < 1 || typeof row.xid !== 'string' || !/^[1-9][0-9]*$/.test(row.xid) || row.tenant !== tenant || row.generation !== generation || row.phase !== 'suspended' || typeof row.claim_id !== 'string' || !UUID.test(row.claim_id) || typeof row.artifact_digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.artifact_digest) || typeof row.role_oid !== 'string' || !/^[1-9][0-9]*$/.test(row.role_oid) || typeof row.birth !== 'string' || !row.birth || row.audit_role !== row.role_oid || row.owner_pid !== row.pid || row.owner_birth !== row.birth || row.state !== 'suspended' || row.unrestored !== true || row.unactivated !== true || row.authorized !== true || row.lifetime_held !== true || ['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'owns_checkpoint', 'owns_lifecycle'].some(key => row[key] !== false)) throw fail('PGSTREAM_POOL_PROVISION_AUTHORITY');
    const identity = Object.freeze({ pid: row.pid, xid: row.xid, roleOID: row.role_oid, birth: row.birth, claimId: row.claim_id, artifactDigest: row.artifact_digest });
    if (original && JSON.stringify(identity) !== JSON.stringify(original)) throw fail('PGSTREAM_POOL_PROVISION_IDENTITY_CHANGED');
    original = identity; return identity;
  }
  // This observes the existing caller-held exclusive lifetime before any pool
  // acquisition. Autocommit or a routed backend fails the next xid comparison.
  await authority();
  await require('./assignment-protocol').assertInstalled(query, { namespace: b.namespace, membershipNamespace: b.membershipNamespace, lifecycleNamespace: b.lifecycleNamespace, poolProfile: profile, poolIntake: true, predecessorProfile });
  await definition.assertInstalled(query, profile, {predecessorProfile});
  const held = await transactionLock.lock(query, b.membershipNamespace, 'evaluator');
  if (held.backend_pid !== original.pid || held.transaction_id !== original.xid) throw fail('PGSTREAM_POOL_PROVISION_TRANSACTION');
  const desired = q(b.membershipNamespace) + '.pool_desired', members = q(b.membershipNamespace) + '.pool_membership', table = q(b.namespace) + '.tenant_consumer_checkpoint';
  let assignment;
  async function cohort () {
    const rows = (await query('SELECT /* pool-checkpoint-provision-desired */ members,revision::text AS revision,slice_rule AS rule,partitioned FROM ' + desired + ' WHERE pool_kind=$1', ['evaluator'])).rows;
    const target = rows[0];
    if (rows.length !== 1 || !target || typeof target.partitioned!=='boolean' || !target.partitioned&&target.members!==1 || !Number.isSafeInteger(target.members) || target.members < 1 || target.members > MAX_MEMBERS || target.rule !== RULE || typeof target.revision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(target.revision) || BigInt(target.revision) > 9223372036854775807n) throw fail('PGSTREAM_POOL_PROVISION_ASSIGNMENT');
    const live = (await query('SELECT /* pool-checkpoint-provision-cohort */ ordinal,member_id::text AS member_id,slice_rule AS rule,applied_members AS applied FROM ' + members + " WHERE pool_kind=$1 AND lease_expires_at>clock_timestamp() ORDER BY ordinal,member_id", ['evaluator'])).rows;
    if (target.partitioned ? live.length !== target.members || new Set(live.map(row => row.ordinal)).size !== target.members || live.some(row => !Number.isSafeInteger(row.ordinal) || row.ordinal < 0 || row.ordinal >= target.members || typeof row.member_id !== 'string' || !UUID.test(row.member_id) || row.rule !== RULE || row.applied !== target.members) : live.length!==0) throw fail('PGSTREAM_POOL_PROVISION_COHORT');
    const next = Object.freeze({ members: target.members, partitioned:target.partitioned, revision: target.revision, ordinal: bucket(tenant, target.members) });
    if (assignment && JSON.stringify(assignment) !== JSON.stringify(next)) throw fail('PGSTREAM_POOL_PROVISION_ASSIGNMENT_CHANGED');
    assignment = next; return next;
  }
  await cohort();
  if ((await query('SELECT /* pool-checkpoint-provision-existing */ consumer FROM ' + table + ' WHERE tenant_id=$1 AND consumer=$2', [tenant, b.consumer + '-completed'])).rows.length) throw fail('PGSTREAM_POOL_PROVISION_EXISTS');
  await authority();
  const context = { artifactDigest: original.artifactDigest, backendPid: original.pid, birth: original.birth, claimId: original.claimId, consumer: b.consumer + '-completed', generation, members: assignment.members, observedAt: String(observedAt), ordinal: assignment.ordinal, profile: profile.digest, revision: assignment.revision, roleOID: original.roleOID, tenant, transactionId: original.xid };
  await query("SELECT set_config('app.pgstream_checkpoint_provision',$1,true)", [JSON.stringify(context)]);
  const empty = Array(6).fill(null), observed = [...empty], at = [...empty];
  observed[4] = require('./intake-profile').lifecycleStamp(generation,'suspended'); observed[5] = '1'; at[4] = String(observedAt); at[5] = String(observedAt);
  const values = { tenant_id: tenant, consumer: b.consumer + '-completed', contract_digest: profile.contractDigest, checkpoint: '0', projection: JSON.stringify([{ kind: 'evaluator-work-v2', output: null }]), work_version: 2, work_observed: observed, work_completed: empty, work_observed_at: at, work_pending_at: String(observedAt), work_due_at: null, work_completed_at: null, work_enabled: false, work_activity_enabled: false, work_lifecycle_enabled: false, delivery_revision: '0', delivery_ack_revision: '0', output_identity: null, output_digest: null, output_revision: '0', output_restore_generation: null, work_owner_ordinal: assignment.ordinal, work_assignment_revision: assignment.revision };
  const columns = definition.INSERTS;
  const inserted = await query('INSERT INTO ' + table + ' (' + columns.join(',') + ') VALUES (' + columns.map((column, i) => '$' + (i + 1) + (column === 'projection' ? '::jsonb' : '')).join(',') + ') RETURNING tenant_id::text AS tenant,consumer,contract_digest,work_owner_ordinal AS ordinal,work_assignment_revision::text AS revision', columns.map(column => values[column]));
  const row = inserted.rows?.[0];
  if (inserted.rowCount !== 1 || inserted.rows?.length !== 1 || row.tenant !== tenant || row.consumer !== b.consumer + '-completed' || row.contract_digest !== profile.contractDigest || row.ordinal !== assignment.ordinal || row.revision !== assignment.revision) throw fail('PGSTREAM_POOL_PROVISION_INSERT');
  await authority(); await cohort();
  // No commit/activation or BASE digest is inferred here. The caller's DATA
  // commit is guarded by 0009 and must mark its same audit restored first.
  return Object.freeze({ tenant, generation, consumer: b.consumer + '-completed', ordinal: assignment.ordinal, revision: assignment.revision, staged: true });
}
module.exports = { provisionCheckpoint, authoritySQL, INSERTS: definition.INSERTS, AUTHORITY_READS: definition.AUTHORITY_READS };
