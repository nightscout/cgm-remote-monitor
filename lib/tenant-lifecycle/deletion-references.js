'use strict';

// Only these derived tables can change after artifact capture. They are erased
// under actual exclusion and rebuilt from current source contracts, never replayed.
const { refuse } = require('./artifact');
const slice = require('../pool-membership/slice');
const OUTBOX = new Set(require('../tenant-notifications/partition-candidate').TABLES);
function currentCount ({ step, rows, tenant, descriptor, desired, notificationBindings }) {
  const profile = descriptor.profile;
  if (step.table === 'tenant_consumer_checkpoint' && ['checkpoint', 'evaluator_checkpoint'].includes(step.kind)) {
    const expected = new Map(descriptor.rows.filter(row => row.namespace === step.namespace).map(row => [row.consumer, row.digest]));
    const typed = step.namespace === profile.binding.namespace ? profile.binding.consumer + '-completed' : null;
    if (typed) expected.set(typed, profile.contractDigest);
    if (!expected.size || rows.length !== expected.size) throw refuse('LIFECYCLE_DELETION_CHECKPOINT_REQUIRED');
    const seen = new Set();
    for (const row of rows) {
      if (row.tenant_id !== tenant || !expected.has(row.consumer) || seen.has(row.consumer) || row.contract_digest !== expected.get(row.consumer)) throw refuse('LIFECYCLE_DELETION_CHECKPOINT_INVALID');
      seen.add(row.consumer);
      if (row.consumer === typed && !descriptor.nativeSelection) {
        if (!desired || !Number.isSafeInteger(desired.members) || desired.members < 1 || desired.members > slice.MAX_MEMBERS ||
            desired.rule !== slice.RULE || typeof desired.revision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(desired.revision) ||
            row.work_version !== 2 || row.work_assignment_revision !== desired.revision || row.work_owner_ordinal !== slice.bucket(tenant, desired.members)) throw refuse('LIFECYCLE_DELETION_CHECKPOINT_INVALID');
      }
    }
    return rows.length;
  }
  if (step.kind === 'notification_outbox' && OUTBOX.has(step.table)) {
    const binding = notificationBindings.find(value => value.namespace === step.namespace);
    if (!binding || rows.some(row => row.tenant_id !== tenant || row.consumer !== binding.consumer)) throw refuse('LIFECYCLE_DELETION_NOTIFICATION_INVALID');
    return rows.length;
  }
  return null;
}
module.exports = { currentCount };
