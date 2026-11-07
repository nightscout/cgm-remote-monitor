'use strict';

// Upgrade and rollback over the migration runner. Down migrations are
// unsupported by the runner, so an upgrade is `status` (precheck) → backup →
// `up` → `check`, and a rollback is a restore of the pre-upgrade backup into
// fresh namespaces, with the older binary's `check` against the upgraded
// namespaces as the refusal oracle (MIG_UNKNOWN: the ledger is newer than
// the catalogue it knows). Writes committed after the backup are not in the
// rollback target; the record says so.
//
// `migrate(action, { namespace, catalogue })` is injected and closes over the
// connection URL and the `direct` attestation: lib/migrations/postgres.run
// partially applied. `backup` and `restore` default to this module's own.

const common = require('./common');
const backups = require('./backup');
const restores = require('./restore');

const { refuse } = common;

function migrationError (code, step, error) {
  const refusal = refuse(code, step.kind + (error && error.code ? ' ' + error.code : ''));
  refusal.cause = error;
  refusal.kind = step.kind;
  return refusal;
}

async function precheck (migrate, steps) {
  const states = [];
  for (const step of steps) {
    let state;
    try { state = await migrate('status', { namespace: step.namespace, catalogue: step.catalogue }); } catch (error) {
      throw migrationError('UPGRADE_PRECHECK_FAILED', step, error);
    }
    if (!state || !Array.isArray(state.applied) || !Array.isArray(state.pending)) throw migrationError('UPGRADE_PRECHECK_FAILED', step);
    states.push({ kind: step.kind, namespace: step.namespace, applied: state.applied.slice(), pending: state.pending.slice() });
  }
  return states;
}

// upgrade(connection, { migrate, catalogues, sourceCommit, registry?, now?, backup? })
//   catalogues: the new binary's admitted catalogues with their namespaces
// Returns { record, artifact }. The artifact is the operator's to keep: a
// failed `up` rethrows UPGRADE_FAILED with `.artifact` attached.
async function upgrade (connection, { migrate, catalogues, sourceCommit, registry = null, now, backup = backups.backup } = {}) {
  if (typeof migrate !== 'function') throw refuse('UPGRADE_MIGRATE_REQUIRED');
  const steps = common.plan(catalogues).map(step => ({ ...step, catalogue: catalogueOf(catalogues, step.kind) }));
  const startedAt = common.timestamp(now);
  const before = await precheck(migrate, steps);
  if (before.every(state => !state.pending.length)) throw refuse('UPGRADE_NOTHING_PENDING');
  const artifact = await backup(connection, { catalogues, sourceCommit, registry, now });
  for (const state of before) {
    const captured = artifact.manifest.catalogues.find(c => c.kind === state.kind);
    if (!captured || captured.ledger.map(e => e.name).join(',') !== state.applied.join(',')) throw refuse('UPGRADE_LEDGER_MOVED', state.kind);
  }
  const applied = {};
  for (const step of steps) {
    const state = before.find(s => s.kind === step.kind);
    if (!state.pending.length) { applied[step.kind] = []; continue; }
    let result;
    try { result = await migrate('up', { namespace: step.namespace, catalogue: step.catalogue }); } catch (error) {
      const failure = migrationError('UPGRADE_FAILED', step, error);
      failure.artifact = artifact;
      failure.applied = applied;
      throw failure;
    }
    applied[step.kind] = Array.isArray(result && result.done) ? result.done.slice() : [];
  }
  const after = [];
  for (const step of steps) {
    let state;
    try { state = await migrate('check', { namespace: step.namespace, catalogue: step.catalogue }); } catch (error) {
      const failure = migrationError('UPGRADE_POSTCHECK_FAILED', step, error);
      failure.artifact = artifact;
      failure.applied = applied;
      throw failure;
    }
    after.push({ kind: step.kind, applied: state.applied.slice() });
  }
  const record = {
    format: 'nightscout-upgrade-record',
    version: 1,
    startedAt,
    finishedAt: common.timestamp(now),
    sourceCommit,
    backup: { name: backups.artifactName(artifact), digest: artifact.digest, takenAt: artifact.manifest.takenAt },
    catalogues: steps.map(step => ({
      kind: step.kind,
      namespace: step.namespace,
      catalogueChecksum: step.catalogueChecksum,
      before: before.find(s => s.kind === step.kind).applied,
      applied: applied[step.kind],
      after: after.find(s => s.kind === step.kind).applied
    }))
  };
  return { record, artifact };
}

function catalogueOf (catalogues, kind) {
  return catalogues.find(entry => entry && entry.kind === kind).catalogue;
}

// rollback(connection, { migrate, artifact, catalogues, upgraded, targets, acl?, restore? })
//   catalogues: the *older* binary's admitted catalogues; `namespace` on each
//               entry is the fresh target namespace the rollback restores into
//   upgraded:   { kind: namespace } the namespaces the upgrade changed; these
//               are left as they are (forensics), never written
// Steps: artifact ledgers equal the older catalogues (the older binary can
// serve what it restores); the older `check` refuses every upgraded namespace
// with MIG_UNKNOWN (or finds it current, in which case no rollback is needed);
// `up` prepares each fresh namespace; restore; the older `check` is current.
async function rollback (connection, { migrate, artifact, catalogues, upgraded, acl = null, restore = restores.restore } = {}) {
  if (typeof migrate !== 'function') throw refuse('ROLLBACK_MIGRATE_REQUIRED');
  const steps = common.plan(catalogues).map(step => ({ ...step, catalogue: catalogueOf(catalogues, step.kind) }));
  restores.verifyArtifact(artifact);
  restores.validateAcl(acl);
  if (!upgraded || typeof upgraded !== 'object') throw refuse('ROLLBACK_UPGRADED_REQUIRED');
  for (const step of steps) {
    const captured = artifact.manifest.catalogues.find(c => c.kind === step.kind);
    if (!captured || !common.ledgerEqual(captured.ledger, step.files)) throw refuse('ROLLBACK_CATALOGUE_MISMATCH', step.kind);
    if (!common.namespaceValid(upgraded[step.kind])) throw refuse('ROLLBACK_UPGRADED_REQUIRED', step.kind);
    if (Object.values(upgraded).includes(step.namespace)) throw refuse('ROLLBACK_TARGET_NOT_FRESH', step.kind);
  }
  const refusal = {};
  for (const step of steps) {
    try {
      await migrate('check', { namespace: upgraded[step.kind], catalogue: step.catalogue });
      refusal[step.kind] = 'current';
    } catch (error) {
      if (!error || error.code !== 'MIG_UNKNOWN') throw migrationError('ROLLBACK_REFUSAL_UNEXPECTED', step, error);
      refusal[step.kind] = 'MIG_UNKNOWN';
    }
  }
  if (Object.values(refusal).every(outcome => outcome === 'current')) throw refuse('ROLLBACK_NOT_NEEDED');
  for (const step of steps) {
    const existing = await connection.query('SELECT to_regnamespace($1) IS NOT NULL AS present', [step.namespace]);
    if (existing.rows[0].present) throw refuse('ROLLBACK_TARGET_NOT_FRESH', step.kind);
  }
  // Read all targets before preparing any. Preparation is separately committed
  // by the migration runner; later execution failures can still leave schemas.
  for (const step of steps) {
    try { await migrate('up', { namespace: step.namespace, catalogue: step.catalogue }); } catch (error) {
      throw migrationError('ROLLBACK_PREPARE_FAILED', step, error);
    }
  }
  const restored = await restore(connection, artifact, { catalogues, acl });
  const after = {};
  for (const step of steps) {
    try { after[step.kind] = (await migrate('check', { namespace: step.namespace, catalogue: step.catalogue })).applied; } catch (error) {
      throw migrationError('ROLLBACK_POSTCHECK_FAILED', step, error);
    }
  }
  return {
    format: 'nightscout-rollback-record',
    version: 1,
    backup: { name: backups.artifactName(artifact), digest: artifact.digest, takenAt: artifact.manifest.takenAt },
    refusal,
    upgraded: { ...upgraded },
    restored,
    after,
    lost: 'writes committed after takenAt ' + artifact.manifest.takenAt + ' are not in the restored namespaces'
  };
}

module.exports = { upgrade, rollback };
