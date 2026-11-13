'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const c = require('../server/realtime/contract');
const placement = require('./index');
const publication = require('./publication-lock');
const fail = code => { throw Object.assign(new Error(code), { code }); };
// The caller supplies a dedicated direct PostgreSQL client, a narrowly admitted
// registry page reader and an actual platform termination/fence verifier. This is
// operator control, never an endpoint selected by an untrusted client request.
async function perform ({ file, candidate, internal, client, controlNamespace, registry, registryNamespace, maxTenants = 10000, confirmStopped, stopOwners, afterAssignment, maxBytes = 1048576, source = process.env, recoveryLimits }, recoveryConsumer, activityMode = false) {
  if (activityMode) { require('./activity').neutral(); if (placement.ownershipVersion(source) !== 2) fail('REALTIME_RECOVERY_ACTIVITY_PROFILE'); if (registry !== undefined || typeof registryNamespace !== 'string') fail('REALTIME_RECOVERY_REGISTRY_REQUIRED'); }
  if (typeof file !== 'string' || !path.isAbsolute(file) || !activityMode && (!registry || typeof registry.page !== 'function' || typeof registry.revision !== 'function') || !c.integer(maxTenants, 100000) || typeof confirmStopped !== 'function' || !client || typeof client.query !== 'function') throw new TypeError('Explicit bounded publication inputs required');
  if (stopOwners !== undefined && typeof stopOwners !== 'function') throw new TypeError('Explicit platform stop callback required');
  if (afterAssignment !== undefined && typeof afterAssignment !== 'function') throw new TypeError('Explicit target preparation callback required');
  candidate = structuredClone(candidate);
  const bytes = Buffer.from(JSON.stringify(candidate) + '\n');
  if (bytes.length > maxBytes) fail('REALTIME_PLACEMENT_OVER_BOUND');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('REALTIME_PLACEMENT_FILE_REFUSED');
  const lock = publication.key(controlNamespace), next = placement.parse(candidate, { internal, maxBytes, ownershipVersion: placement.ownershipVersion(source) });
  // v1 worker owner keys are stable across assignment incarnations. Holding
  // that old key while warming a same-ID replacement would block the target.
  // Refuse before BEGIN/map effects; versioned assignment keys are separate work.
  if (recoveryConsumer !== undefined && next.ownershipVersion === 1 && next.stopped.some(owner => next.workers.has(owner.worker))) fail('REALTIME_RECOVERY_WORKER_REUSE_UNSUPPORTED');
  if (next.ownershipVersion === 2) {
    if (recoveryConsumer === undefined) fail('REALTIME_ASSIGNMENT_PUBLISH_REQUIRES_RECOVERY');
    if (typeof afterAssignment !== 'function') fail('REALTIME_RECOVERY_READINESS_REQUIRED');
    if (!c.exact(recoveryLimits, ['maxLogicalMoves','maxAssignmentChanges','maxAffectedTenants']) ||
        !c.integer(recoveryLimits.maxLogicalMoves, 65536) || !c.integer(recoveryLimits.maxAssignmentChanges, 65536) ||
        !c.integer(recoveryLimits.maxAffectedTenants, 100000)) fail('REALTIME_RECOVERY_LIMITS_REQUIRED');
  }
  let temporary, began = false, activity;
  try {
    await client.query(activityMode ? 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY' : 'BEGIN READ ONLY'); began = true;
    const held = (await client.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS held', [lock])).rows[0];
    if (held?.held !== true) fail('REALTIME_PLACEMENT_MAINTENANCE_PINNED');
    await require('../tenant-lifecycle/operation-window-readiness').admit(client, controlNamespace);
    if (activityMode) { activity = await require('./activity').create({client,namespace:controlNamespace,registryNamespace}); registry = activity.registry; }
    const previous = placement.parse(c.file(file, { label: 'MULTITENANT_REALTIME_PLACEMENT', source }), { internal, maxBytes, ownershipVersion: next.ownershipVersion });
    let selected = previous;
    const revisions = placement.create({ read: () => selected, continuous: true }); revisions.current(); selected = next; revisions.current();
    if (next.generation !== previous.generation + 1) fail('REALTIME_PLACEMENT_REVISION_REFUSED');
    const registryRevision = await registry.revision(), tenants = []; let after = null;
    for (;;) {
      const limit = Math.min(1000, maxTenants + 1 - tenants.length);
      const page = await registry.page(after, limit);
      if (page.revision !== registryRevision || page.tenants.some(tenant => !c.uuid(tenant) || after !== null && tenant <= after)) fail('REALTIME_PLACEMENT_REGISTRY_CHANGED');
      tenants.push(...page.tenants);
      if (tenants.length > maxTenants || new Set(tenants).size !== tenants.length) fail('REALTIME_PLACEMENT_OVER_BOUND');
      if (page.tenants.length < limit) break;
      after = page.tenants.at(-1);
    }
    let affected = 0, logicalMovedTenants = 0; const affectedIds = [];
    const logicalMoves = previous.owners.reduce((n, owner, index) => n + (owner?.worker !== next.owners[index]?.worker ? 1 : 0), 0);
    const assignmentChanges = previous.owners.reduce((n, owner, index) => n + (!placement.sameOwner(owner, next.owners[index]) ? 1 : 0), 0);
    for (const tenant of tenants) {
      const shard = placement.shard(tenant, next.shardCount), a = previous.owners[shard], b = next.owners[shard];
      if (a?.worker === b?.worker && a?.incarnation === b?.incarnation) continue;
      affected++; affectedIds.push(tenant);
      if (a?.worker !== b?.worker) logicalMovedTenants++;
      if (!activityMode) {
      await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
      const row = (await client.query('SELECT phase,lock_key::text AS lock_key FROM "' + controlNamespace + '".tenant_lifecycle_windows WHERE tenant_id=$1', [tenant])).rows[0];
      if (row?.phase !== 'active' || row.lock_key !== require('../tenant-registry/rules').lockKey(tenant)) fail('LIFECYCLE_WINDOW_SUSPENDED');
      }
    }
    if (await registry.revision() !== registryRevision) fail('REALTIME_PLACEMENT_REGISTRY_CHANGED');
    if (next.ownershipVersion === 2 && (logicalMoves > recoveryLimits.maxLogicalMoves ||
        assignmentChanges > recoveryLimits.maxAssignmentChanges || affected > recoveryLimits.maxAffectedTenants)) fail('REALTIME_RECOVERY_WORK_OVER_BOUND');
    if (activityMode) { activity.bindAffected(affectedIds); for (const tenant of affectedIds) await activity.assertActive(tenant); }
    // Planned drain/termination happens INSIDE the publication fence, before a
    // pinned restore can select the old actor. Already-confirmed crash recovery
    // needs no stop callback; an ambiguous live owner remains unavailable.
    for (const owner of candidate.transition.stopped) {
      if (await confirmStopped(Object.freeze({ ...owner })) !== true) {
        if (!stopOwners) fail('REALTIME_PLACEMENT_OLD_OWNER_UNCONFIRMED');
        await stopOwners(Object.freeze({ ...owner }));
      }
    }
    // Confirm again immediately before publication; an old owner that may still
    // run cannot be replaced. DB resource expiry/readiness is never this proof.
    for (const owner of candidate.transition.stopped) if (await confirmStopped(Object.freeze({ ...owner })) !== true) fail('REALTIME_PLACEMENT_OLD_OWNER_UNCONFIRMED');
    // Recovery requires BOTH exact platform exclusion above and the old owner's
    // actual lock, on this same admitted publication client/transaction. Hold it
    // through target warming and route publication; a census is not lock proof.
    if (recoveryConsumer !== undefined) {
      for (const owner of candidate.transition.stopped) {
        const ownerKey = require('./owner').key({worker: owner.worker, consumer: recoveryConsumer, ownershipVersion: previous.ownershipVersion, ...(previous.ownershipVersion === 2 ? {assignmentIncarnation: owner.incarnation} : {})});
        const proof = await client.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS held', [ownerKey]);
        if (proof.rows?.length !== 1 || proof.rows[0].held !== true) fail('REALTIME_RECOVERY_OWNER_LOCK_HELD');
      }
    }
    if (await registry.revision() !== registryRevision) fail('REALTIME_PLACEMENT_REGISTRY_CHANGED');
    temporary = path.join(path.dirname(file), '.realtime-placement-' + randomBytes(12).toString('hex'));
    const handle = await fs.open(temporary, 'wx', stat.mode & 0o777);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file); temporary = null;
    const directory = await fs.open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); }
    const result = Object.freeze({ generation: next.generation, digest: next.digest, affectedTenants: affected, ...(recoveryConsumer !== undefined ? {logicalMoves, assignmentChanges, logicalMovedTenants, retainedWarmTenantUpperBound: affected - logicalMovedTenants, warmWorkBasis: 'affected-registry-tenants-upper-bound'} : {}) });
    // New processes warm and the matching route view is published while this
    // same fence still excludes maintenance. Failure retains the new intended
    // assignment as an explicit uncertain transition, never an old-map rollback.
    if (afterAssignment) await afterAssignment(result, ...(activity ? [Object.freeze({readActivity:activity.readActivity,registry:activity.registry})] : []));
    if (activity) { await activity.finish(); activity.assertBeforeCommit(); }
    await client.query('COMMIT'); began = false;
    if (activity) activity.assertClosed();
    return result;
  } catch (error) {
    // A failure after rename is uncertain publication, never an instruction to
    // restore an old generation. Read the authoritative file and recover through
    // a fresh confirmed generation; maintenance stays conservatively refused.
    if (!activityMode) { if (began) await client.query('ROLLBACK').catch(() => {}); throw error; }
    if (activity) {
      try { await activity.finish(); } catch (cleanup) { if (cleanup !== error && Object.isExtensible(error)) error.activityCleanupError = cleanup; }
    }
    let rollbackSafe = !activityMode;
    if (activityMode) {
      if (activity) rollbackSafe = activity.rollbackSafe();
      else { try { require('../storage/connection-admission').assertRecoveryTransaction(client); rollbackSafe = true; } catch { rollbackSafe = false; } }
    }
    // Never queue ROLLBACK behind an unknown/pending GUC write. The fixed
    // entry must retain uncertainty until actual physical retirement is proved.
    if (began && rollbackSafe) {
      try { await client.query(activityMode ? {text:'ROLLBACK',query_timeout:1000} : 'ROLLBACK'); }
      catch (cleanup) { if (Object.isExtensible(error)) { error.publicationCleanupUncertain = true; error.publicationCleanupError = cleanup; } }
    } else if (began && Object.isExtensible(error)) error.publicationCleanupUncertain = true;
    throw error;
  } finally { if (temporary) await fs.unlink(temporary).catch(() => {}); }
}
function publish (options) { return perform(options); }
function publishRecovery (options) {
  // Fixed recovery entry: there is no caller-selected bypass of the old-owner
  // proof. Existing controlled publications retain their original contract.
  require('./owner').key({worker: 'validation', consumer: options?.consumer});
  const {consumer, ...publicationOptions} = options;
  return perform(publicationOptions, consumer);
}
function publishRecoveryActivity (options) {
  require('./owner').key({worker:'validation',consumer:options?.consumer});
  const {consumer,...publicationOptions}=options;
  return perform(publicationOptions,consumer,true);
}
module.exports = { publish, publishRecovery, publishRecoveryActivity };
