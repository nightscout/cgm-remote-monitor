'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const insertion = require('../tenant-lifecycle/tenant-insertion-sql');
const INSERTION_NAMESPACE = 'nightscout_migration_namespace';

class MigrationError extends Error {
  constructor (code, message) {
    super(message);
    this.code = code;
  }
}

function checksum (up) {
  return crypto.createHash('sha256').update(JSON.stringify(up)).digest('hex');
}

// A reviewed, explicitly injected catalogue, not discovery of executable JS.
// Plain SQL remains one DDL/DML statement. The sole typed conversion below
// exposes its reviewed LOCK/SET/DO statements and leaves transaction ownership
// with the runner; arbitrary control SQL/templates remain unsupported.
function validateCatalogue (input) {
  if (!input || input.version !== 1 || !Array.isArray(input.migrations) || !input.migrations.length) {
    throw new MigrationError('MIG_CATALOGUE', 'a nonempty version 1 migration catalogue is required');
  }
  let previous = '';
  return Object.freeze(input.migrations.map(m => {
    if (!m || typeof m.name !== 'string' || !/^\d{4}_[a-z0-9_]+$/.test(m.name) || m.name <= previous) {
      throw new MigrationError('MIG_CATALOGUE', 'migration names must be unique and lexically ordered NNNN_names');
    }
    previous = m.name;
    if (!Array.isArray(m.up) || !m.up.length || m.up.some(sql => typeof sql !== 'string')) {
      throw new MigrationError('MIG_CATALOGUE', 'migration SQL requires individual DDL/DML statements without leading comments or transaction control');
    }
    let operation;
    if (m.operation !== undefined) {
      const value = m.operation;
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.keys(value).sort().join(',') !== 'domain,kind' ||
          value.kind !== 'tenant-insertion-v1' || !insertion.DOMAINS.includes(value.domain)) {
        throw new MigrationError('MIG_OPERATION', 'only the reviewed tenant-insertion-v1 operation is supported');
      }
      const expected = insertion.build({ namespace: INSERTION_NAMESPACE, domain: value.domain }).up;
      if (JSON.stringify(m.up) !== JSON.stringify(expected)) {
        throw new MigrationError('MIG_OPERATION_SQL', 'typed operation SQL differs from its reviewed plan');
      }
      operation = Object.freeze({ kind: value.kind, domain: value.domain });
    } else if (m.up.some(sql => !/^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|GRANT|REVOKE|COMMENT)\s/i.test(sql))) {
      throw new MigrationError('MIG_CATALOGUE', 'migration SQL requires individual DDL/DML statements without leading comments or transaction control');
    }
    if (typeof m.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(m.checksum) || m.checksum !== checksum(m.up)) {
      throw new MigrationError('MIG_CHECKSUM', 'catalogue checksum mismatch: ' + m.name);
    }
    return Object.freeze({ name: m.name, up: Object.freeze(m.up.slice()), checksum: m.checksum, ...(operation ? { operation } : {}) });
  }));
}

function loadCatalogue (file) {
  return validateCatalogue(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function renderMigration (migration, namespace) {
  if (typeof namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) ||
      namespace === 'public' || namespace.startsWith('pg_') || namespace === 'information_schema') {
    throw new MigrationError('MIG_NAMESPACE', 'an explicit non-system migration namespace is required');
  }
  const [reviewed] = validateCatalogue({ version: 1, migrations: [migration] });
  return reviewed.operation
    ? Object.freeze(reviewed.up.map(sql => sql.split(INSERTION_NAMESPACE).join(namespace)))
    : reviewed.up;
}

function operationTables (migration) {
  const [reviewed] = validateCatalogue({ version: 1, migrations: [migration] });
  return Object.freeze(reviewed.operation ? ['tenant_insertion_ordinal', reviewed.operation.domain] : []);
}

module.exports = { MigrationError, checksum, validateCatalogue, loadCatalogue, renderMigration, operationTables, INSERTION_NAMESPACE };
