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
function validateAcl (acl, steps) {
  if (acl === null) return;
  if (!acl || typeof acl !== 'object') throw refuse('RESTORE_ACL_ROLE_INVALID');
  if (!Object.hasOwn(acl, 'grants')) {
    if (typeof acl.role !== 'string' || !common.ROLE.test(acl.role)) throw refuse('RESTORE_ACL_ROLE_INVALID');
    return; // Historical representative interface; deployment composition refuses it.
  }
  if (Object.hasOwn(acl, 'role') || !Array.isArray(acl.grants)) throw refuse('RESTORE_ACL_PLAN_INVALID');
  const seen = new Set();
  for (const grant of acl.grants) {
    if (!grant || typeof grant.role !== 'string' || !common.ROLE.test(grant.role)) throw refuse('RESTORE_ACL_ROLE_INVALID');
    const step = steps && steps.find(item => item.kind === grant.kind);
    const key = [grant.role, grant.kind, grant.table].join('.');
    const columnPrivileges = grant.columnPrivileges || {};
    if (typeof columnPrivileges !== 'object' || Array.isArray(columnPrivileges)) throw refuse('RESTORE_ACL_PLAN_INVALID');
    for (const [privilege, columns] of Object.entries(columnPrivileges)) {
      if (!['SELECT', 'INSERT', 'UPDATE'].includes(privilege) || !Array.isArray(columns) || !columns.length ||
          columns.some(column => typeof column !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(column)) ||
          new Set(columns).size !== columns.length || grant.table === 'schema_migrations' ||
          (Array.isArray(grant.privileges) && grant.privileges.includes(privilege))) throw refuse('RESTORE_ACL_PLAN_INVALID');
    }
    if (!step || (grant.table !== 'schema_migrations' && !step.tables.includes(grant.table)) || seen.has(key) ||
        !Array.isArray(grant.privileges) || (!grant.privileges.length && !Object.keys(columnPrivileges).length) ||
        new Set(grant.privileges).size !== grant.privileges.length ||
        grant.privileges.some(value => !['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(value)) ||
        (grant.table === 'schema_migrations' && grant.privileges.some(value => value !== 'SELECT')) ||
        !Array.isArray(grant.sequencePrivileges || []) ||
        new Set(grant.sequencePrivileges || []).size !== (grant.sequencePrivileges || []).length ||
        (grant.sequencePrivileges || []).some(value => !['USAGE', 'SELECT'].includes(value))) {
      throw refuse('RESTORE_ACL_PLAN_INVALID');
    }
    seen.add(key);
  }
}

// Construct every statement and resolve sequence identities before INSERT/GRANT.
async function prepareAcl (connection, steps, work, acl) {
  if (acl === null) return { result: null, statements: [] };
  const statements = [];
  if (!Object.hasOwn(acl, 'grants')) {
    for (const step of steps) {
      statements.push('GRANT USAGE ON SCHEMA "' + step.namespace + '" TO "' + acl.role + '"');
      for (const table of step.tables) statements.push('GRANT SELECT, INSERT, UPDATE, DELETE ON ' + qualified(step.namespace, table) + ' TO "' + acl.role + '"');
      statements.push('GRANT SELECT ON ' + qualified(step.namespace, 'schema_migrations') + ' TO "' + acl.role + '"');
      statements.push('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "' + step.namespace + '" TO "' + acl.role + '"');
    }
    return { result: acl.role, statements };
  }
  const usages = new Set();
  for (const grant of acl.grants) {
    const step = steps.find(item => item.kind === grant.kind);
    const usage = step.namespace + '.' + grant.role;
    if (!usages.has(usage)) {
      statements.push('GRANT USAGE ON SCHEMA "' + step.namespace + '" TO "' + grant.role + '"');
      usages.add(usage);
    }
    const scopedPrivileges = grant.privileges.slice();
    for (const [privilege, columns] of Object.entries(grant.columnPrivileges || {})) {
      const item = work.find(item => item.kind === grant.kind && item.table === grant.table);
      if (!item || columns.some(column => !item.columns.some(actual => actual.name === column))) throw refuse('RESTORE_ACL_COLUMN_INVALID');
      scopedPrivileges.push(privilege + ' (' + columns.map(column => '"' + column + '"').join(', ') + ')');
    }
    statements.push('GRANT ' + scopedPrivileges.join(', ') + ' ON ' + qualified(step.namespace, grant.table) + ' TO "' + grant.role + '"');
    if ((grant.sequencePrivileges || []).length) {
      const item = work.find(item => item.kind === grant.kind && item.table === grant.table);
      if (!item || !item.columns.some(column => column.identity)) throw refuse('RESTORE_ACL_SEQUENCE_INVALID');
      for (const column of item.columns.filter(column => column.identity)) {
        const found = await connection.query('SELECT n.nspname AS namespace, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=pg_get_serial_sequence($1,$2)::regclass', [qualified(step.namespace, grant.table), column.name]);
        const sequence = found.rows[0];
        if (!sequence || sequence.namespace !== step.namespace || !common.namespaceValid(sequence.name)) throw refuse('RESTORE_ACL_SEQUENCE_INVALID');
        statements.push('GRANT ' + grant.sequencePrivileges.join(', ') + ' ON SEQUENCE ' + qualified(sequence.namespace, sequence.name) + ' TO "' + grant.role + '"');
      }
    }
  }
  return { result: { roles: [...new Set(acl.grants.map(grant => grant.role))], grants: acl.grants.length }, statements };
}

async function recreateAcl (connection, prepared) {
  for (const statement of prepared.statements) await connection.query(statement);
  return prepared.result;
}

// restore(connection, artifact, { catalogues, acl?, onRow? })
//   catalogues: the plan with the *target* namespaces (fresh, prepared by
//               `migrate up` with the artifact's catalogue)
//   acl:        { role } for the application role's grants, or omitted
//   onRow:      awaited after each row with { key, written, total }
async function restore (connection, artifact, { catalogues, acl = null, onRow } = {}) {
  const steps = common.plan(catalogues);
  const rowsByKey = verifyArtifact(artifact);
  validateAcl(acl, steps);
  return common.transaction(connection, 'BEGIN', async () => {
    await common.assertUnboundIdentity(connection, 'RESTORE_IDENTITY_BOUND');
    const work = await verifyTarget(connection, artifact, steps);
    const preparedAcl = await prepareAcl(connection, steps, work, acl);
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
    const role = await recreateAcl(connection, preparedAcl);
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

module.exports = { restore, verifyArtifact, insertStatement, insertValues, validateAcl, prepareAcl };
