'use strict';

// Restore of a deployment backup into fresh namespaces: one transaction, every
// validation refusal before the first write, ACL recreation for the application role,
// and an oracle that recomputes counts, digests and per-tenant counts from
// the restored tables before COMMIT. The target namespaces are prepared by
// the migration runner (`migrate up` with the artifact's catalogue) and their
// ledgers must equal the artifact's exactly: this module never writes a
// ledger row. A target with an empty ledger is unprepared; a target whose
// ledger is longer or different is another schema, and restore-then-upgrade
// is the supported order.

const common = require('./common');

const { refuse, tableKey, qualified } = common;

// Structural and self-consistency checks, without a database: format,
// manifest digest, per-table count and digest from the file text, tenant
// binding of every row, the tenants section, and key references.
function verifyArtifact (artifact) {
  if (!artifact || artifact.format !== common.FORMAT || artifact.version !== common.VERSION || !artifact.manifest ||
      !artifact.tables || typeof artifact.tables !== 'object') {
    throw refuse('RESTORE_ARTIFACT_INVALID', 'format');
  }
  const manifest = artifact.manifest;
  if (manifest.format !== common.FORMAT || manifest.version !== common.VERSION || !Array.isArray(manifest.catalogues) ||
      !Array.isArray(manifest.tenants) || typeof manifest.sourceCommit !== 'string' || !common.COMMIT.test(manifest.sourceCommit)) {
    throw refuse('RESTORE_ARTIFACT_INVALID', 'manifest');
  }
  if (typeof artifact.digest !== 'string' || !common.DIGEST.test(artifact.digest) || artifact.digest !== common.manifestDigest(manifest)) {
    throw refuse('RESTORE_ARTIFACT_INVALID', 'digest');
  }
  const rowsByKey = {};
  const seen = new Set();
  const tenantRows = {};
  for (const catalogue of manifest.catalogues) {
    if (typeof catalogue.kind !== 'string' || !Array.isArray(catalogue.ledger) || !Array.isArray(catalogue.tables)) {
      throw refuse('RESTORE_ARTIFACT_INVALID', catalogue.kind);
    }
    for (const entry of catalogue.tables) {
      const key = tableKey(catalogue.kind, entry.table);
      if (seen.has(key)) throw refuse('RESTORE_ARTIFACT_INVALID', key);
      seen.add(key);
      const text = artifact.tables[key];
      let rows;
      try { rows = common.decodeTable(text); } catch { throw refuse('RESTORE_ARTIFACT_INVALID', key); }
      if (rows.length !== entry.count) throw refuse('RESTORE_COUNT_MISMATCH', key);
      if (common.sha256(text) !== entry.digest) throw refuse('RESTORE_DIGEST_MISMATCH', key);
      if (!Array.isArray(entry.columns)) throw refuse('RESTORE_ARTIFACT_INVALID', key);
      for (const row of rows) {
        if (!row || typeof row !== 'object' || typeof row.tenant_id !== 'string' || !common.UUID.test(row.tenant_id)) {
          throw refuse('RESTORE_ROW_UNBOUND', key);
        }
        for (const column of entry.columns) {
          if (!Object.hasOwn(row, column.name)) throw refuse('RESTORE_ARTIFACT_INVALID', key + '.' + column.name);
        }
        tenantRows[row.tenant_id] = tenantRows[row.tenant_id] || {};
        tenantRows[row.tenant_id][key] = (tenantRows[row.tenant_id][key] || 0) + 1;
      }
      if (entry.keyReferences !== undefined) {
        const expected = common.keyReferences(rows, key);
        if (common.canonical(expected) !== common.canonical(entry.keyReferences)) throw refuse('RESTORE_KEY_REFERENCE_MISMATCH', key);
      }
      rowsByKey[key] = rows;
    }
  }
  if (Object.keys(artifact.tables).some(key => !seen.has(key))) throw refuse('RESTORE_ARTIFACT_INVALID', 'unlisted table');
  const listed = Object.fromEntries(manifest.tenants.map(tenant => [tenant.tenant_id, tenant.rows]));
  if (common.canonical(listed) !== common.canonical(tenantRows)) throw refuse('RESTORE_ARTIFACT_INVALID', 'tenants');
  return rowsByKey;
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

// Target-dependent refusals, inside the transaction and before any write.
async function verifyTarget (connection, artifact, steps) {
  const described = new Map(artifact.manifest.catalogues.map(catalogue => [catalogue.kind, catalogue]));
  const work = [];
  for (const step of steps) {
    const catalogue = described.get(step.kind);
    if (!catalogue || catalogue.tables.map(t => t.table).join(',') !== step.tables.join(',')) throw refuse('RESTORE_CATALOGUE_MISMATCH', step.kind);
    if (!common.ledgerPrefix(catalogue.ledger, step.files).ok) throw refuse('RESTORE_CATALOGUE_MISMATCH', step.kind);
    const ledger = await common.readLedger(connection, step.namespace);
    if (!ledger.length) throw refuse('RESTORE_TARGET_UNPREPARED', step.kind);
    if (!common.ledgerEqual(ledger, catalogue.ledger)) throw refuse('RESTORE_LEDGER_MISMATCH', step.kind);
    for (const table of catalogue.tables) {
      const key = tableKey(step.kind, table.table);
      const columns = await common.columnsOf(connection, step.namespace, table.table);
      if (!common.columnsEqual(table.columns, columns)) throw refuse('RESTORE_COLUMNS_MISMATCH', key);
      work.push({ kind: step.kind, namespace: step.namespace, table: table.table, columns, key });
    }
  }
  if (described.size !== steps.length) throw refuse('RESTORE_CATALOGUE_MISMATCH', 'artifact lists a catalogue the plan does not');
  for (const item of work) {
    const result = await connection.query('SELECT count(*)::int AS n FROM ' + qualified(item.namespace, item.table));
    if (result.rows[0].n !== 0) throw refuse('RESTORE_TARGET_NOT_EMPTY', item.key);
  }
  return work;
}

// After OVERRIDING SYSTEM VALUE inserts the identity sequence still starts at
// 1; move it past the restored maximum so the next insert cannot collide.
async function advanceIdentity (connection, item) {
  for (const column of item.columns.filter(c => c.identity)) {
    await connection.query('SELECT setval(pg_get_serial_sequence($1, $2), (SELECT max("' + column.name + '") FROM ' +
      qualified(item.namespace, item.table) + '), true)', [qualified(item.namespace, item.table), column.name]);
  }
}

// The lab's explicit ACL recreation: the dump never carried privileges, and
// the application role receives exactly these grants in the target.
function validateAcl (acl) {
  if (acl !== null && (!acl || typeof acl.role !== 'string' || !common.ROLE.test(acl.role))) throw refuse('RESTORE_ACL_ROLE_INVALID');
}

async function recreateAcl (connection, steps, acl) {
  if (acl === null) return null;
  for (const step of steps) {
    await connection.query('GRANT USAGE ON SCHEMA "' + step.namespace + '" TO "' + acl.role + '"');
    for (const table of step.tables) {
      await connection.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ' + qualified(step.namespace, table) + ' TO "' + acl.role + '"');
    }
    await connection.query('GRANT SELECT ON ' + qualified(step.namespace, 'schema_migrations') + ' TO "' + acl.role + '"');
    await connection.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "' + step.namespace + '" TO "' + acl.role + '"');
  }
  return acl.role;
}

// restore(connection, artifact, { catalogues, acl?, onRow? })
//   catalogues: the plan with the *target* namespaces (fresh, prepared by
//               `migrate up` with the artifact's catalogue)
//   acl:        { role } for the application role's grants, or omitted
//   onRow:      awaited after each row with { key, written, total }
async function restore (connection, artifact, { catalogues, acl = null, onRow } = {}) {
  const steps = common.plan(catalogues);
  const rowsByKey = verifyArtifact(artifact);
  validateAcl(acl);
  return common.transaction(connection, 'BEGIN', async () => {
    await common.assertUnboundIdentity(connection, 'RESTORE_IDENTITY_BOUND');
    const work = await verifyTarget(connection, artifact, steps);
    const written = {};
    let total = 0;
    for (const item of work) {
      const statement = insertStatement(item.namespace, item.table, item.columns);
      written[item.key] = 0;
      for (const row of rowsByKey[item.key]) {
        const result = await connection.query(statement, insertValues(item.columns, row));
        if (result.rowCount !== 1) throw refuse('RESTORE_WRITE_COUNT', item.key);
        written[item.key] += 1;
        total += 1;
        if (onRow) await onRow({ key: item.key, written: written[item.key], total });
      }
      await advanceIdentity(connection, item);
    }
    const role = await recreateAcl(connection, steps, acl);
    const oracle = await common.summarize(connection, steps);
    common.assertSameSummary(common.summaryOfManifest(artifact.manifest), oracle, 'RESTORE_ORACLE_MISMATCH');
    return {
      takenAt: artifact.manifest.takenAt,
      sourceCommit: artifact.manifest.sourceCommit,
      digest: artifact.digest,
      namespaces: Object.fromEntries(steps.map(step => [step.kind, step.namespace])),
      written,
      total,
      acl: role,
      oracle: { tables: oracle.catalogues.reduce((n, c) => n + c.tables.length, 0), tenants: artifact.manifest.tenants.length, differences: 0 }
    };
  });
}

module.exports = { restore, verifyArtifact, insertStatement, insertValues, validateAcl };
