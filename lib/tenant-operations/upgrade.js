'use strict';

// The operator takes a platform PostgreSQL and Vault backup before upgrading.
const common = require('./common');

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

async function checkRelations (connection, step) {
  await common.assertRelationInventory(connection, step);
  if (step.files.some(migration => migration.operation?.kind === 'tenant-insertion-v1')) {
    await require('../storage/postgres-insertion-readiness').schemaMetadata(connection, { namespace: step.namespace, domain: step.kind });
  }
}

async function upgrade (connection, { migrate, catalogues, sourceCatalogues = null, sourceCommit, now } = {}) {
  if (typeof sourceCommit !== 'string' || !common.COMMIT.test(sourceCommit)) throw refuse('UPGRADE_SOURCE_COMMIT_INVALID');
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
  const sourceLedgers = new Map();
  for (const source of sources) {
    const ledger = await common.readLedger(connection, source.namespace);
    if (!ledger.length || !common.ledgerPrefix(ledger, source.files).ok) throw refuse('UPGRADE_SOURCE_NOT_CURRENT', source.kind);
    await checkRelations(connection, source);
    const state = before.find(item => item.kind === source.kind);
    if (ledger.map(row => row.name).join(',') !== state.applied.join(',')) throw refuse('UPGRADE_LEDGER_MOVED', source.kind);
    if (sourceCatalogues && !common.ledgerEqual(ledger, source.files)) throw refuse('UPGRADE_SOURCE_NOT_CURRENT', source.kind);
    sourceLedgers.set(source.kind, ledger);
  }
  const applied = {};
  for (const step of steps) {
    const state = before.find(s => s.kind === step.kind);
    if (!state.pending.length) { applied[step.kind] = []; continue; }
    let result;
    try { result = await migrate('up', { namespace: step.namespace, catalogue: step.catalogue }); } catch (error) {
      const failure = migrationError('UPGRADE_FAILED', step, error);
      failure.applied = applied;
      throw failure;
    }
    applied[step.kind] = Array.isArray(result && result.done) ? result.done.slice() : [];
  }
  const after = [];
  for (const step of steps) {
    let state;
    try {
      state = await migrate('check', { namespace: step.namespace, catalogue: step.catalogue });
      await checkRelations(connection, step);
      if (!common.ledgerEqual(await common.readLedger(connection, step.namespace), step.files)) throw refuse('UPGRADE_TARGET_LEDGER_MISMATCH', step.kind);
    } catch (error) {
      const failure = migrationError('UPGRADE_POSTCHECK_FAILED', step, error);
      failure.applied = applied;
      throw failure;
    }
    after.push({ kind: step.kind, applied: state.applied.slice() });
  }
  const describe = (step, ledger) => ({ kind: step.kind, namespace: step.namespace, tables: step.tables.slice(), ledger: common.ledgerOf(ledger) });
  const record = {
    format: 'nightscout-upgrade-record',
    version: 1,
    startedAt,
    finishedAt: common.timestamp(now),
    sourceCommit,
    sourceCatalogues: sources.map(step => describe(step, sourceLedgers.get(step.kind))),
    targetCatalogues: steps.map(step => describe(step, step.files)),
    catalogues: steps.map(step => ({
      kind: step.kind,
      namespace: step.namespace,
      catalogueChecksum: step.catalogueChecksum,
      before: before.find(s => s.kind === step.kind).applied,
      applied: applied[step.kind],
      after: after.find(s => s.kind === step.kind).applied
    }))
  };
  return { record };
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

module.exports = { upgrade, assertUpgradeCompatible };
