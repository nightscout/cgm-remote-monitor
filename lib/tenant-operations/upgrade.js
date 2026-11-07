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
async function upgrade (connection, { migrate, catalogues, sourceCatalogues = null, sourceCommit, backupSourceCommit = sourceCommit, registry = null, now, backup = backups.backup } = {}) {
  if (typeof migrate !== 'function') throw refuse('UPGRADE_MIGRATE_REQUIRED');
  const steps = common.plan(catalogues).map(step => ({ ...step, catalogue: catalogueOf(catalogues, step.kind) }));
  const sources = common.plan(sourceCatalogues || catalogues);
  for (const source of sources) {
    const target = steps.find(step => step.kind === source.kind);
    if (!target || target.namespace !== source.namespace || !common.ledgerPrefix(source.files, target.files).ok ||
        target.tables.filter(table => source.tables.includes(table)).join(',') !== source.tables.join(',')) {
      throw refuse('UPGRADE_NOT_APPEND_ONLY', source.kind);
    }
  }
  const startedAt = common.timestamp(now);
  const before = await precheck(migrate, steps);
  if (before.every(state => !state.pending.length)) throw refuse('UPGRADE_NOTHING_PENDING');
  for (const step of steps.filter(target => !sources.some(source => source.kind === target.kind))) {
    const exists = await connection.query('SELECT to_regnamespace($1) IS NOT NULL AS present', [step.namespace]);
    if (exists.rows[0].present) throw refuse('UPGRADE_NEW_NAMESPACE_NOT_FRESH', step.kind);
  }
  for (const source of sources) {
    const target = steps.find(step => step.kind === source.kind);
    for (const table of target.tables.filter(table => !source.tables.includes(table))) {
      const exists = await connection.query('SELECT to_regclass($1) IS NOT NULL AS present', [common.qualified(target.namespace, table)]);
      if (exists.rows[0].present) throw refuse('UPGRADE_NEW_TABLE_NOT_FRESH', target.kind + '.' + table);
    }
  }
  const artifact = await backup(connection, { catalogues: sourceCatalogues || catalogues, sourceCommit: backupSourceCommit, registry, now });
  if (artifact.manifest.catalogues.length !== sources.length) throw refuse('UPGRADE_SOURCE_INVENTORY_MISMATCH');
  for (const source of sources) {
    const captured = artifact.manifest.catalogues.find(c => c.kind === source.kind);
    const state = before.find(state => state.kind === source.kind);
    if (!captured || captured.tables.map(table => table.table).join(',') !== source.tables.join(',') ||
        captured.ledger.map(e => e.name).join(',') !== state.applied.join(',')) throw refuse('UPGRADE_LEDGER_MOVED', source.kind);
    if (sourceCatalogues && !common.ledgerEqual(captured.ledger, source.files)) throw refuse('UPGRADE_SOURCE_NOT_CURRENT', source.kind);
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
  let targetSummary;
  try {
    targetSummary = await common.summarize(connection, steps);
    for (const step of steps) {
      const state = targetSummary.catalogues.find(item => item.kind === step.kind);
      if (!common.ledgerEqual(state.ledger, step.files)) throw refuse('UPGRADE_TARGET_LEDGER_MISMATCH', step.kind);
    }
    // Compare source columns projected from the upgraded tables. Added columns
    // may change the full target digest; old identities/data must still survive.
    const preserved = { catalogues: [] };
    for (const captured of artifact.manifest.catalogues) {
      const target = steps.find(step => step.kind === captured.kind);
      const tables = [];
      for (const table of captured.tables) {
        const columns = await common.columnsOf(connection, target.namespace, table.table);
        for (const column of table.columns) {
          if (!columns.some(current => current.name === column.name && current.type === column.type)) throw refuse('UPGRADE_SOURCE_COLUMN_CHANGED', captured.kind + '.' + table.table);
        }
        const rows = await common.readRows(connection, target.namespace, table.table, table.columns);
        const encoded = common.encodeTable(rows);
        tables.push({ table: table.table, count: encoded.count, digest: encoded.digest, tenants: common.tenantCounts(rows) });
      }
      preserved.catalogues.push({ kind: captured.kind, ledger: captured.ledger, tables });
    }
    common.assertSameSummary(common.summaryOfManifest(artifact.manifest), preserved, 'UPGRADE_PRESERVATION_MISMATCH');
  } catch (error) {
    const failure = refuse('UPGRADE_TARGET_VALIDATION_FAILED');
    failure.cause = error; failure.artifact = artifact; failure.applied = applied;
    throw failure;
  }
  const describe = (step, ledger) => ({ kind: step.kind, namespace: step.namespace, tables: step.tables.slice(), ledger: common.ledgerOf(ledger) });
  const record = {
    format: 'nightscout-upgrade-record',
    version: 1,
    startedAt,
    finishedAt: common.timestamp(now),
    sourceCommit,
    backup: { name: backups.artifactName(artifact), digest: artifact.digest, takenAt: artifact.manifest.takenAt },
    sourceCatalogues: sources.map(step => describe(step, artifact.manifest.catalogues.find(item => item.kind === step.kind).ledger)),
    targetCatalogues: steps.map(step => describe(step, step.files)),
    targetSummary,
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

// Explicit operator readiness for the recorded deployment, including newly added
// kinds that an older binary's per-namespace migration checks cannot name.
function assertUpgradeCompatible (record, catalogues) {
  if (!record || record.format !== 'nightscout-upgrade-record' || record.version !== 1 || !Array.isArray(record.targetCatalogues)) {
    throw refuse('UPGRADE_RECORD_INVALID');
  }
  const steps = common.plan(catalogues);
  if (new Set(record.targetCatalogues.map(item => item.kind)).size !== record.targetCatalogues.length) throw refuse('UPGRADE_RECORD_INVALID');
  for (const target of record.targetCatalogues) {
    const known = steps.find(step => step.kind === target.kind);
    if (!known) throw refuse('OPERATIONS_BINARY_CATALOGUE_UNKNOWN', target.kind);
    if (!common.ledgerEqual(target.ledger, known.files) || common.canonical(target.tables) !== common.canonical(known.tables)) {
      throw refuse('OPERATIONS_BINARY_CATALOGUE_NEWER', target.kind);
    }
  }
  if (steps.length !== record.targetCatalogues.length) throw refuse('OPERATIONS_BINARY_CATALOGUE_INCOMPLETE');
  return true;
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
async function rollback (connection, { migrate, artifact, catalogues, upgraded, upgradeRecord = null, acl = null, restore = restores.restore } = {}) {
  if (typeof migrate !== 'function') throw refuse('ROLLBACK_MIGRATE_REQUIRED');
  const steps = common.plan(catalogues).map(step => ({ ...step, catalogue: catalogueOf(catalogues, step.kind) }));
  restores.verifyArtifact(artifact);
  restores.validateAcl(acl, steps);
  if (!upgraded || typeof upgraded !== 'object') throw refuse('ROLLBACK_UPGRADED_REQUIRED');
  for (const step of steps) {
    const captured = artifact.manifest.catalogues.find(c => c.kind === step.kind);
    if (!captured || !common.ledgerEqual(captured.ledger, step.files)) throw refuse('ROLLBACK_CATALOGUE_MISMATCH', step.kind);
    if (!common.namespaceValid(upgraded[step.kind])) throw refuse('ROLLBACK_UPGRADED_REQUIRED', step.kind);
    if (Object.values(upgraded).includes(step.namespace)) throw refuse('ROLLBACK_TARGET_NOT_FRESH', step.kind);
  }
  const refusal = {};
  if (upgradeRecord) {
    if (!upgradeRecord.backup || upgradeRecord.backup.digest !== artifact.digest || !Array.isArray(upgradeRecord.sourceCatalogues) ||
        upgradeRecord.sourceCatalogues.length !== steps.length || !Array.isArray(upgradeRecord.targetCatalogues)) throw refuse('ROLLBACK_RECORD_MISMATCH');
    for (const step of steps) {
      const source = upgradeRecord.sourceCatalogues.find(item => item.kind === step.kind);
      if (!source || !common.ledgerEqual(source.ledger, step.files) || common.canonical(source.tables) !== common.canonical(step.tables)) throw refuse('ROLLBACK_RECORD_MISMATCH', step.kind);
    }
    const targetNamespaces = new Set();
    for (const target of upgradeRecord.targetCatalogues) {
      if (!common.namespaceValid(target.namespace) || upgraded[target.kind] !== target.namespace || targetNamespaces.has(target.namespace)) throw refuse('ROLLBACK_RECORD_MISMATCH', target.kind);
      targetNamespaces.add(target.namespace);
      const ledger = await common.readLedger(connection, target.namespace);
      if (!common.ledgerEqual(ledger, target.ledger)) throw refuse('ROLLBACK_TARGET_LEDGER_MOVED', target.kind);
    }
    try { assertUpgradeCompatible(upgradeRecord, catalogues); } catch (error) {
      if (!['OPERATIONS_BINARY_CATALOGUE_UNKNOWN', 'OPERATIONS_BINARY_CATALOGUE_NEWER'].includes(error.code)) throw error;
      refusal.catalogue = error.code;
    }
  }
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

module.exports = { upgrade, rollback, assertUpgradeCompatible };
