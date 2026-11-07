'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

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
// Each SQL entry is one statement; transaction/session control is not permitted.
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
    if (!Array.isArray(m.up) || !m.up.length || m.up.some(sql =>
      typeof sql !== 'string' || !/^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|GRANT|REVOKE|COMMENT)\s/i.test(sql))) {
      throw new MigrationError('MIG_CATALOGUE', 'migration SQL requires individual DDL/DML statements without leading comments or transaction control');
    }
    if (typeof m.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(m.checksum) || m.checksum !== checksum(m.up)) {
      throw new MigrationError('MIG_CHECKSUM', 'catalogue checksum mismatch: ' + m.name);
    }
    return Object.freeze({ name: m.name, up: Object.freeze(m.up.slice()), checksum: m.checksum });
  }));
}

function loadCatalogue (file) {
  return validateCatalogue(JSON.parse(fs.readFileSync(file, 'utf8')));
}

module.exports = { MigrationError, checksum, validateCatalogue, loadCatalogue };
