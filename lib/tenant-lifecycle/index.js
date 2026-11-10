'use strict';

// Explicit private-plane tenant export, same-ID logical clinical reconciliation
// and confirmed deletion. Current-counter clock-bearing restore requires a real
// branded maintenance transaction and preserves current nonclinical authority.
// Legacy shared-identity import remains unsupported. The caller supplies a
// NOSUPERUSER NOBYPASSRLS lower-port connection; tenant binding and forced RLS
// bound reads and writes. Vault provider keys are never exported or deleted here.

const createCeremony = require('./ceremony');
const tenantScope = require('../storage/tenant-scope');
const { assertRelationInventory } = require('../storage/postgres-relation-inventory');
const artifacts = require('./artifact');
const { validateCatalogue } = require('../migrations/catalogue');
const insertionInventory = require('./insertion-inventory');

const { refuse, tableKey } = artifacts;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAMESPACE = /^[a-z][a-z0-9_]{0,62}$/;

// The admitted catalogue: every tenant-bound table this tree's reviewed
// candidates create, in foreign-key order (parents first). Deletion walks it
// in reverse. A table absent from this list is not exported or deleted.
const DEFAULT_CATALOGUE = Object.freeze([
  { kind: 'entries', candidate: require('../../migrations/candidates/postgres-entries-v1.json'), tables: ['entries'] },
  { kind: 'treatments', candidate: require('../../migrations/candidates/postgres-treatments-v1.json'), tables: ['treatments'] },
  { kind: 'devicestatus', candidate: require('../../migrations/candidates/postgres-devicestatus-v1.json'), tables: ['devicestatus'] },
  { kind: 'profile', candidate: require('../../migrations/candidates/postgres-profile-v1.json'), tables: ['profile'] },
  { kind: 'food', candidate: require('../../migrations/candidates/postgres-food-v1.json'), tables: ['food'] },
  { kind: 'activity', candidate: require('../../migrations/candidates/postgres-activity-v1.json'), tables: ['activity'] },
  { kind: 'settings', candidate: require('../../migrations/candidates/postgres-settings-v1.json'), tables: ['settings'] },
  { kind: 'clock', candidate: require('../../migrations/candidates/postgres-write-clock-v1.json'), tables: ['tenant_write_clock'] },
  { kind: 'checkpoint', candidate: require('../../migrations/candidates/postgres-consumer-checkpoint-v1.json'), tables: ['tenant_consumer_checkpoint'] },
  { kind: 'authorization',
    candidate: require('../tenant-authorization/postgres-candidate.json'),
    tables: ['tenant_authorization_config', 'tenant_authorization_roles', 'tenant_authorization_subjects',
      'tenant_authorization_subject_roles', 'tenant_subject_admin_audit', 'tenant_owner_policy', 'tenant_owner_actors'] },
  { kind: 'access',
    candidate: require('../tenant-authorization/access-candidate.json'),
    tables: ['access_tenants', 'access_credentials', 'access_sessions', 'access_keys'] },
  { kind: 'human_session', candidate: require('../human-session/candidate.json'),
    tables: ['human_identities', 'human_sessions', 'human_access_tokens', 'human_logout_events'] },
  { kind: 'subject_policy', candidate: require('../subject-policy/postgres-candidate.json'), tables: ['subject_policy', 'subject_policy_audit'] },
  { kind: 'operator_policy', candidate: require('../operator-policy/postgres-candidate.json'), tables: ['tenant_operator_policy'] },
  { kind: 'tenant_settings', candidate: require('../tenant-settings/postgres-candidate.json'), tables: ['tenant_settings', 'tenant_settings_history'] },
  { kind: 'owner_configuration', candidate: require('../tenant-settings/owner-authority-candidate.json'), tables: ['tenant_owner_configuration_authority'] },
  { kind: 'legacy', candidate: require('../secrets/legacy-credentials-candidate.json'), tables: ['legacy_credential_config', 'legacy_credential_subjects'] },
  { kind: 'secrets', candidate: require('../secrets/postgres-candidate.json'), tables: ['secret_records', 'secret_audit'], secrets: ['secret_records'] }
].map(entry => Object.freeze({ ...entry, tables: Object.freeze(insertionInventory.tableOrder(entry.kind, entry.candidate, entry.tables)), secrets: Object.freeze(entry.secrets || []) })));

const LEDGER_TABLE = 'tenant_lifecycle_requests';

// Explicit reviewed extensions share the deployment admission; no runtime schema discovery.
function createLifecycle ({ catalogues = DEFAULT_CATALOGUE, authorize = null, verifyDurableArtifact = null, executionWindow = null, admissionCheck = null } = {}) {
  if (!Array.isArray(catalogues) || !catalogues.length) throw refuse('LIFECYCLE_CATALOGUE_INVALID');
  const kinds = new Set();
  const CATALOGUE = Object.freeze(catalogues.map(entry => {
    if (!entry || !NAMESPACE.test(entry.kind) || kinds.has(entry.kind) || !Array.isArray(entry.tables) || !entry.tables.length ||
        entry.tables.some(table => !NAMESPACE.test(table)) || new Set(entry.tables).size !== entry.tables.length ||
        !Array.isArray(entry.secrets || []) || (entry.secrets || []).some(table => !entry.tables.includes(table))) {
      throw refuse('LIFECYCLE_CATALOGUE_INVALID');
    }
    validateCatalogue(entry.candidate);
    insertionInventory.assertTables(entry.kind, entry.candidate, entry.tables);
    kinds.add(entry.kind);
    return Object.freeze({ ...entry, tables: Object.freeze(entry.tables.slice()), secrets: Object.freeze((entry.secrets || []).slice()) });
  }));

function admittedCatalogue () {
  return CATALOGUE.map(entry => ({ kind: entry.kind, candidate: entry.candidate, tables: entry.tables.slice(), secrets: entry.secrets.slice() }));
}

function tenantId (tenant) {
  if (typeof tenant !== 'string' || !UUID.test(tenant)) throw refuse('LIFECYCLE_TENANT_INVALID');
  return tenant;
}

function namespaceOf (namespaces, kind) {
  const namespace = namespaces && namespaces[kind];
  if (typeof namespace !== 'string' || !NAMESPACE.test(namespace) || namespace === 'public' ||
      namespace.startsWith('pg_') || namespace === 'information_schema') {
    throw refuse('LIFECYCLE_CATALOGUE_UNMAPPED', kind);
  }
  return namespace;
}

const qualified = (namespace, table) => '"' + namespace + '"."' + table + '"';

function timestamp (now) {
  const value = typeof now === 'function' ? now() : Date.now();
  if (!Number.isSafeInteger(value) || value < 0) throw refuse('LIFECYCLE_CLOCK_INVALID');
  return value;
}

async function columnsOf (connection, namespace, table) {
  const result = await connection.query(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
       a.attidentity <> '' AS identity
     FROM pg_attribute a
     WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
     ORDER BY a.attnum`, [qualified(namespace, table)]);
  if (!result.rows.length) throw refuse('LIFECYCLE_TABLE_MISSING', qualified(namespace, table));
  if (!result.rows.some(column => column.name === 'tenant_id')) throw refuse('LIFECYCLE_TABLE_UNBOUND', qualified(namespace, table));
  return result.rows.map(column => ({ name: column.name, type: column.type, identity: column.identity === true }));
}

async function readLedger (connection, namespace) {
  const result = await connection.query('SELECT name, checksum FROM ' + qualified(namespace, 'schema_migrations') +
    ' ORDER BY name COLLATE "C"');
  return result.rows.map(row => ({ name: row.name, checksum: row.checksum }));
}

// This inventory names current tables/columns, so a known prefix is insufficient.
// Neither agreement with an artifact nor a live ledger makes unknown DDL reviewed.
function assertCurrentLedger (entry, ledger) {
  const reviewed = validateCatalogue(entry.candidate);
  for (const [index, row] of ledger.entries()) {
    const known = reviewed.find(migration => migration.name === row.name);
    if (!known) throw refuse('LIFECYCLE_SCHEMA_UNKNOWN', entry.kind);
    if (known.checksum !== row.checksum) throw refuse('LIFECYCLE_SCHEMA_DRIFT', entry.kind);
    if (reviewed[index]?.name !== row.name) throw refuse('LIFECYCLE_SCHEMA_HISTORY', entry.kind);
  }
  if (ledger.length !== reviewed.length) throw refuse('LIFECYCLE_SCHEMA_STALE', entry.kind);
}

async function readRows (connection, tenant, namespace, table, columns) {
  const result = await connection.query('SELECT ' + columns.map(column => '"' + column.name + '"').join(', ') +
    ' FROM ' + qualified(namespace, table) + ' WHERE tenant_id = $1', [tenant]);
  for (const row of result.rows) {
    if (row.tenant_id !== tenant) throw refuse('LIFECYCLE_ROW_TENANT_MISMATCH', qualified(namespace, table));
  }
  return result.rows.map(row => ({ ...row }));
}

async function countRows (connection, tenant, namespace, table) {
  const result = await connection.query('SELECT count(*)::int AS n FROM ' + qualified(namespace, table) +
    ' WHERE tenant_id = $1', [tenant]);
  return result.rows[0].n;
}

// Reads every admitted table under the tenant binding inside one REPEATABLE
// READ snapshot, so the artifact describes one consistent moment.
async function captureCatalogues (connection, tenant, namespaces) {
  const captured = [], admitted = [];
  for (const entry of CATALOGUE) {
    const namespace = namespaceOf(namespaces, entry.kind);
    const ledger = await readLedger(connection, namespace);
    assertCurrentLedger(entry, ledger);
    await assertRelationInventory(connection, { namespace, tables: entry.tables, fail: (reason, name) => refuse('LIFECYCLE_RELATION_' + reason, entry.kind + '.' + name) });
    admitted.push({ entry, namespace, ledger });
  }
  for (const { entry, namespace, ledger } of admitted) {
    const tables = [];
    for (const table of entry.tables) {
      const columns = await columnsOf(connection, namespace, table);
      const rows = await readRows(connection, tenant, namespace, table, columns);
      tables.push({ table, columns, rows, secrets: entry.secrets.includes(table) });
    }
    captured.push({ kind: entry.kind, namespace, ledger, tables });
  }
  return captured;
}

async function exportTenant (connection, { tenant, namespaces, sourceCommit, keyNames = null, now } = {}) {
  tenantId(tenant);
  const exportedAt = timestamp(now);
  return tenantScope.withTenant(tenant, () => connection.snapshotTransaction(async () => {
    const ordered = CATALOGUE.filter(entry => insertionInventory.hasCounter(entry.candidate, entry.kind));
    for (const entry of ordered) {
      const namespace = namespaceOf(namespaces, entry.kind);
      await require('../storage/postgres-insertion-readiness').schemaMetadata(connection, { namespace, domain: entry.kind });
      await require('../storage/postgres-insertion-readiness').floor(connection, { namespace, domain: entry.kind, tenant });
    }
    const catalogues = await captureCatalogues(connection, tenant, namespaces);
    const artifact = artifacts.buildArtifact({ tenant, sourceCommit, exportedAt, catalogues, keyNames });
    for (const entry of ordered) insertionInventory.assertArtifact(artifact, entry.kind);
    return artifact;
  }));
}

// Target-dependent refusals, evaluated inside the operation's transaction and
// before any write: catalogue mapping, ledger equality, column equality.
async function verifyTarget (connection, artifact, namespaces) {
  const plan = [];
  const manifestKinds = new Map(artifact.manifest.catalogues.map(catalogue => [catalogue.kind, catalogue]));
  for (const entry of CATALOGUE) {
    const described = manifestKinds.get(entry.kind);
    if (!described || described.tables.map(t => t.table).join(',') !== entry.tables.join(',')) {
      throw refuse('LIFECYCLE_CATALOGUE_INCOMPLETE', entry.kind);
    }
    assertCurrentLedger(entry, described.ledger);
    const namespace = namespaceOf(namespaces, entry.kind);
    const ledger = await readLedger(connection, namespace);
    assertCurrentLedger(entry, ledger);
    if (!artifacts.ledgerEqual(described.ledger, ledger)) throw refuse('LIFECYCLE_LEDGER_MISMATCH', entry.kind);
    await assertRelationInventory(connection, { namespace, tables: entry.tables, fail: (reason, name) => refuse('LIFECYCLE_RELATION_' + reason, entry.kind + '.' + name) });
    for (const table of described.tables) {
      const columns = await columnsOf(connection, namespace, table.table);
      if (!artifacts.columnsEqual(table.columns, columns)) throw refuse('LIFECYCLE_COLUMNS_MISMATCH', tableKey(entry.kind, table.table));
      plan.push({ kind: entry.kind, namespace, table: table.table, columns, described, key: tableKey(entry.kind, table.table) });
    }
  }
  if (manifestKinds.size !== CATALOGUE.length) throw refuse('LIFECYCLE_CATALOGUE_UNKNOWN');
  return plan;
}

function insertStatement (namespace, table, columns) {
  const identity = columns.some(column => column.identity);
  return 'INSERT INTO ' + qualified(namespace, table) + ' (' + columns.map(column => '"' + column.name + '"').join(', ') + ')' +
    (identity ? ' OVERRIDING SYSTEM VALUE' : '') + ' VALUES (' +
    columns.map((column, index) => '$' + (index + 1) + '::' + column.type).join(', ') + ')';
}

function insertValues (columns, row) {
  return columns.map(column => {
    const value = row[column.name];
    if (value === null || value === undefined) return null;
    return column.type === 'jsonb' || column.type === 'json' ? JSON.stringify(value) : value;
  });
}

// One transaction for the whole import: an interruption leaves nothing behind.
// onRow({ key, written, total }) is awaited after each row; a throw rolls back.
async function importArtifact (connection, artifact, { tenant, namespaces, onRow, maintenanceClaim, onCommitted } = {}) {
  tenantId(tenant);
  artifacts.validateArtifact(artifact);
  if (artifact.manifest.tenant !== tenant) throw refuse('LIFECYCLE_TENANT_MISMATCH');
  const ordered = CATALOGUE.filter(entry => insertionInventory.hasCounter(entry.candidate, entry.kind));
  if (ordered.length && !maintenanceClaim) throw refuse('LIFECYCLE_MAINTENANCE_REQUIRED');
  // Full clock-bearing restore is a forward clinical reconciliation. Raw backup
  // fidelity stays in tenant-operations; stale authority/checkpoints are not replayed.
  if (ordered.length && CATALOGUE.some(entry => entry.kind === 'clock')) {
    return require('./logical-restore').restore(connection, artifact, { tenant, namespaces, onRow, maintenanceClaim, onCommitted, catalogues: CATALOGUE });
  }
  return tenantScope.withTenant(tenant, () => connection.transaction(async () => {
    const claim = { connection, tenant, artifactDigest: artifact.digest };
    if (ordered.length) await require('./maintenance-window').assertHeld(maintenanceClaim, claim);
    const plan = await verifyTarget(connection, artifact, namespaces);
    // Shared sequences are global, while this bound role sees only one tenant.
    // No reviewed allocator-exclusion/global-maintenance authority exists here.
    // Refuse the complete import before any row or sequence effect; never infer
    // a safe allocator counter from a tenant-local MAX or regenerate ordinals.
    const identity = plan.find(step => step.columns.some(column => column.identity));
    if (identity) throw refuse('LIFECYCLE_IDENTITY_IMPORT_UNSUPPORTED', identity.key);
    for (const entry of ordered) {
      insertionInventory.assertArtifact(artifact, entry.kind);
      const namespace = namespaceOf(namespaces, entry.kind);
      const readiness = require('../storage/postgres-insertion-readiness');
      await readiness.metadata(connection, { namespace, domain: entry.kind, mode: 'restore' });
      await readiness.floor(connection, { namespace, domain: entry.kind, tenant });
    }
    for (const step of plan) {
      if (await countRows(connection, tenant, step.namespace, step.table) !== 0) throw refuse('LIFECYCLE_TARGET_NOT_EMPTY', step.key);
    }
    const written = {};
    let total = 0;
    for (const step of plan) {
      const statement = insertStatement(step.namespace, step.table, step.columns);
      written[step.key] = 0;
      for (const row of artifact.tables[step.key]) {
        const result = await connection.query(statement, insertValues(step.columns, row));
        if (result.rowCount !== 1) throw refuse('LIFECYCLE_IMPORT_COUNT', step.key);
        written[step.key] += 1;
        total += 1;
        if (onRow) await onRow({ key: step.key, written: written[step.key], total });
      }
    }
    let oracle = null;
    if (ordered.length) {
      for (const step of plan) {
        const actual = await readRows(connection, tenant, step.namespace, step.table, step.columns);
        if (artifacts.digestRows(actual) !== artifacts.digestRows(artifact.tables[step.key])) {
          throw refuse('LIFECYCLE_IMPORT_ORACLE_MISMATCH', step.key);
        }
      }
      for (const entry of ordered) await require('../storage/postgres-insertion-readiness').floor(connection, {
        namespace: namespaceOf(namespaces, entry.kind), domain: entry.kind, tenant
      });
      await require('./maintenance-window').assertHeld(maintenanceClaim, claim);
      oracle = { tables: plan.length, differences: 0, counters: ordered.length };
    }
    return { tenant, written, total, ...(oracle ? { oracle } : {}) };
  }));
}

// Revalidate the exact tenant artifact immediately before destructive effects.
async function verifyDeletionRows (connection, { tenant, namespaces, artifact }) {
    if (typeof admissionCheck !== 'function') throw refuse('LIFECYCLE_FULL_ADMISSION_REQUIRED');
    await admissionCheck({ catalogues: CATALOGUE, namespaces });
    const plan = await verifyTarget(connection, artifact, namespaces);
    const entries = new Map(CATALOGUE.map(entry => [entry.kind, entry]));
    for (const step of plan) {
      const rows = await readRows(connection, tenant, step.namespace, step.table, step.columns);
      const described = step.described.tables.find(t => t.table === step.table);
      if (rows.length !== described.count || artifacts.digestRows(rows) !== described.digest) {
        throw refuse('LIFECYCLE_ARTIFACT_STALE', step.key);
      }
      if (entries.get(step.kind).secrets.includes(step.table)) {
        const references = new Map((described.keyReferences || []).map(reference => [reference.id, reference]));
        for (const row of rows) {
          const reference = references.get(row.id);
          const stored = artifact.tables[step.key].find(candidate => candidate.id === row.id);
          if (!reference || !stored || stored.ciphertext !== row.ciphertext ||
              artifacts.keyReference(row.ciphertext).keyVersion !== reference.keyReference.keyVersion) {
            throw refuse('LIFECYCLE_KEY_MATERIAL_UNVERIFIED', step.key + '.' + row.id);
          }
        }
      }
    }
    return plan;
}

async function eraseDeletionRows (connection, { tenant, ledgerNamespace, requestId, onRow, now }, plan) {
    const ledger = namespaceOf({ ledger: ledgerNamespace }, 'ledger');
    const deleted = {};
    let total = 0;
    for (const step of plan.slice().reverse()) {
      const result = await connection.query('DELETE FROM ' + qualified(step.namespace, step.table) + ' WHERE tenant_id = $1', [tenant]);
      const expected = step.described.tables.find(t => t.table === step.table).count;
      if (result.rowCount !== expected) throw refuse('LIFECYCLE_DELETE_COUNT', step.key);
      deleted[step.key] = result.rowCount;
      total += result.rowCount;
      if (onRow) await onRow({ key: step.key, deleted: result.rowCount, total });
    }
    const executed = await connection.query('UPDATE ' + qualified(ledger, LEDGER_TABLE) +
      ' SET phase = $3, executed_at = $4 WHERE request_id = $1 AND tenant_id = $2', [requestId, tenant, 'executed', timestamp(now)]);
    if (executed.rowCount !== 1) throw refuse('LIFECYCLE_REQUEST_NOT_RECORDED');
    return { requestId, tenant, deleted, total };
}

const ceremony = createCeremony({ authorize, verifyDurableArtifact, executionWindow,
  namespaceOf, timestamp, verifyRows: verifyDeletionRows, eraseRows: eraseDeletionRows });

return {
  CATALOGUE, LEDGER_TABLE, admittedCatalogue, exportTenant, importArtifact,
  restoreLogical: (connection, artifact, options) => require('./logical-restore').restore(connection, artifact, { ...options, catalogues: CATALOGUE }), ...ceremony,
  withCapabilities: capabilities => createLifecycle({ ...capabilities, catalogues: CATALOGUE, admissionCheck }),
  insertStatement, insertValues, columnsOf, readLedger
};
}

module.exports = { ...createLifecycle(), createLifecycle, ...require('./filesystem-artifact') };
