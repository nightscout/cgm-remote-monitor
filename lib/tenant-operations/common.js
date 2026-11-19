'use strict';

// PostgreSQL catalogue admission and upgrade planning.

const crypto = require('node:crypto');
const physicalInventory = require('../storage/postgres-relation-inventory');
const { validateCatalogue } = require('../migrations/catalogue');

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMIT = /^[a-f0-9]{7,40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
function refuse (code, detail) {
  const error = new Error(detail === undefined ? code : code + ': ' + detail);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

// Deterministic JSON (members sorted, arrays in order), after the lifecycle
// lane's artifact.js. Driver rows never carry undefined; refuse rather than
// drop a member silently. Dates serialize as ISO strings.
function canonical (value) {
  if (value === undefined) throw refuse('OPERATIONS_CANONICAL_UNDEFINED');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => {
    if (value[key] === undefined) throw refuse('OPERATIONS_CANONICAL_UNDEFINED', key);
    return JSON.stringify(key) + ':' + canonical(value[key]);
  }).join(',') + '}';
}

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const qualified = (namespace, table) => '"' + namespace + '"."' + table + '"';
const ledgerOf = files => files.map(entry => ({ name: entry.name, checksum: entry.checksum }));
const ledgerEqual = (a, b) => canonical(ledgerOf(a)) === canonical(ledgerOf(b));

function namespaceValid (namespace) {
  return typeof namespace === 'string' && IDENTIFIER.test(namespace) && namespace !== 'public' &&
    !namespace.startsWith('pg_') && namespace !== 'information_schema';
}

// The caller supplies the admitted catalogue list (the lifecycle lane's
// `admittedCatalogue()` entries, each with the namespace that holds it). This
// module owns no table list: validate, freeze and checksum what it is given.
function plan (catalogues) {
  if (!Array.isArray(catalogues) || !catalogues.length) throw refuse('OPERATIONS_CATALOGUES_REQUIRED');
  const kinds = new Set();
  const namespaces = new Set();
  return Object.freeze(catalogues.map(entry => {
    if (!entry || typeof entry.kind !== 'string' || !IDENTIFIER.test(entry.kind) || kinds.has(entry.kind)) {
      throw refuse('OPERATIONS_CATALOGUE_KIND', entry && entry.kind);
    }
    if (!namespaceValid(entry.namespace)) throw refuse('OPERATIONS_NAMESPACE_INVALID', entry.kind);
    if (namespaces.has(entry.namespace)) throw refuse('OPERATIONS_NAMESPACE_SHARED', entry.namespace);
    if (!Array.isArray(entry.tables) || !entry.tables.length || entry.tables.some(t => typeof t !== 'string' || !IDENTIFIER.test(t))) {
      throw refuse('OPERATIONS_TABLES_INVALID', entry.kind);
    }
    const secrets = entry.secrets || [];
    if (secrets.some(t => !entry.tables.includes(t))) throw refuse('OPERATIONS_TABLES_INVALID', entry.kind);
    kinds.add(entry.kind);
    namespaces.add(entry.namespace);
    const files = validateCatalogue(entry.catalogue);
    require('../tenant-lifecycle/insertion-inventory').assertTables(entry.kind, entry.catalogue, entry.tables);
    return Object.freeze({
      kind: entry.kind,
      namespace: entry.namespace,
      files,
      catalogueChecksum: sha256(canonical(ledgerOf(files))),
      tables: Object.freeze(entry.tables.slice()),
      secrets: Object.freeze(secrets.slice()),
      ...(entry.infrastructure ? { infrastructure: entry.infrastructure } : {})
    });
  }));
}

const assertRelationInventory = (connection, step) => physicalInventory.assertRelationInventory(connection, {
  namespace: step.namespace, tables: step.tables, infrastructure: step.infrastructure, fail: (reason, name) => refuse('OPERATIONS_RELATION_' + reason, step.kind + '.' + name)
});

async function readLedger (connection, namespace) {
  const table = qualified(namespace, 'schema_migrations');
  const found = await connection.query('SELECT to_regclass($1) IS NOT NULL AS present', [table]);
  if (!found.rows[0] || found.rows[0].present !== true) return [];
  const result = await connection.query('SELECT name, checksum FROM ' + table + ' ORDER BY name COLLATE "C"');
  return ledgerOf(result.rows);
}

// The migration ledger's prefix rule (lib/migrations/postgres.js inspect):
// every applied row is known, unchanged and in catalogue order.
function ledgerPrefix (ledger, files) {
  for (const [index, row] of ledger.entries()) {
    const file = files.find(m => m.name === row.name);
    if (!file) return { ok: false, reason: 'unknown', name: row.name };
    if (file.checksum !== row.checksum) return { ok: false, reason: 'drift', name: row.name };
    if (files[index].name !== row.name) return { ok: false, reason: 'history', name: row.name };
  }
  return { ok: true, pending: files.slice(ledger.length).map(m => m.name) };
}

async function columnsOf (connection, namespace, table) {
  const result = await connection.query(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
       a.attidentity <> '' AS identity
     FROM pg_attribute a
     WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
     ORDER BY a.attnum`, [qualified(namespace, table)]);
  if (!result.rows.length) throw refuse('OPERATIONS_TABLE_MISSING', qualified(namespace, table));
  if (!result.rows.some(column => column.name === 'tenant_id')) throw refuse('OPERATIONS_TABLE_UNBOUND', qualified(namespace, table));
  return result.rows.map(column => ({ name: column.name, type: column.type, identity: column.identity === true }));
}

function timestamp (now) {
  const value = typeof now === 'function' ? now() : Date.now();
  if (!Number.isSafeInteger(value) || value < 0) throw refuse('OPERATIONS_CLOCK_INVALID');
  return value;
}

module.exports = {
  UUID, COMMIT, DIGEST, ROLE, refuse, canonical, sha256, qualified, ledgerOf, ledgerEqual,
  ledgerPrefix, namespaceValid, plan, assertRelationInventory, readLedger, columnsOf, timestamp
};
