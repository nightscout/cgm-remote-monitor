'use strict';

// Selected-v2 erasure is an actual maintenance DATA transaction. The separate
// claim commits the deletion cancellation boundary before tenant exclusion.
const profiles = require('../pgstream/pool-intake-profile');
const maintenance = require('./maintenance-window');
const cohort = require('../pool-membership/transaction-lock');
const { refuse } = require('./artifact');
function create ({ intakeProfile, notificationBindings = [] }) {
  const profile = profiles.validate(intakeProfile);
  if (!Array.isArray(notificationBindings)) throw refuse('LIFECYCLE_DELETION_BINDINGS_REQUIRED');
  // A complete immutable declaration, keyed by actual outbox namespace/route.
  const bindings = notificationBindings.map(value => {
    const { namespace, ...binding } = value;
    require('../tenant-notifications/partition-candidate').quote(namespace);
    return Object.freeze({ namespace, ...require('../tenant-notifications/partition-candidate').bindings(binding) });
  });
  if (new Set(bindings.map(binding => binding.namespace)).size !== bindings.length) throw refuse('LIFECYCLE_DELETION_BINDING_MISMATCH');
  for (const binding of bindings) if (binding.checkpointNamespace !== profile.binding.namespace ||
      binding.membershipNamespace !== profile.binding.membershipNamespace || binding.lifecycleNamespace !== profile.binding.lifecycleNamespace ||
      binding.evaluatorConsumer !== profile.binding.consumer + '-completed') throw refuse('LIFECYCLE_DELETION_BINDING_MISMATCH');
  async function beforeExecution (connection, options) {
    if (options.ledgerNamespace !== profile.binding.lifecycleNamespace) throw refuse('LIFECYCLE_DELETION_CONTROL_MISMATCH');
    const claim = { connection, tenant: options.tenant, artifactDigest: options.artifact.digest };
    await maintenance.assertHeld(options.maintenanceClaim, claim);
    // Lock order is tenant lifecycle exclusion, cohort exclusion, then rows.
    await cohort.lock(connection.query.bind(connection), profile.binding.membershipNamespace, 'evaluator', false);
    const rows = (await connection.query('SELECT /* deletion-maintenance-generation */ generation::text AS generation FROM "' +
      profile.binding.lifecycleNamespace + '".tenant_lifecycle_windows WHERE tenant_id=$1 AND phase=\'suspended\'', [options.tenant])).rows;
    if (rows.length !== 1) throw refuse('LIFECYCLE_DELETION_WINDOW_CHANGED');
    require('./generation-domain').assertGeneration(rows[0].generation);
    if (bindings.length) await require('../tenant-notifications/pool-notification-maintenance').prepareDelete(connection.query.bind(connection), {
      profile, bindings, tenant: options.tenant, generation: rows[0].generation
    });
    await maintenance.assertHeld(options.maintenanceClaim, claim);
  }
  async function run (connection, options, ceremony) {
    if (typeof options?.controller?.withRestore !== 'function') throw refuse('LIFECYCLE_DELETION_CONTROLLER_REQUIRED');
    const claim = options.claimId ? { claimId: options.claimId } : await ceremony.claimDeletion(connection, options);
    return options.controller.withRestore(options.tenant, { artifactDigest: options.artifact.digest }, ({ connection: writer, maintenanceClaim }) =>
      ceremony.executeDeletion(writer, { ...options, claimId: claim.claimId, maintenanceClaim }));
  }
  return Object.freeze({ beforeExecution, run });
}
module.exports = { create };
