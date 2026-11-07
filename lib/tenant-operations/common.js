'use strict';

// Shared pieces of the dormant deployment backup/restore/upgrade module.
// The connection is an operator-plane client in the style of
// lib/migrations/postgres.js: `query(text, values)` returning `{ rows,
// rowCount }`, with transactions issued as statements. Every catalogued table
// carries FORCE ROW LEVEL SECURITY, so the identity must be NOBYPASSRLS-free
// (rolbypassrls or rolsuper); a bound identity would read nothing and produce
// an empty, internally consistent artifact, which is why it is refused.

const crypto = require('node:crypto');
const { validateCatalogue } = require('../migrations/catalogue');

const FORMAT = 'nightscout-deployment-backup';
const VERSION = 1;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMIT = /^[a-f0-9]{7,40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
// The secrets component stores Transit ciphertext with its key version in the
// prefix; the reference is what a backup carries, never the key.
const CIPHERTEXT = /^vault:v([1-9][0-9]*):[A-Za-z0-9+/=]+$/;

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
const tableKey = (kind, table) => kind + '.' + table;
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
    return Object.freeze({
      kind: entry.kind,
      namespace: entry.namespace,
      files,
      catalogueChecksum: sha256(canonical(ledgerOf(files))),
      tables: Object.freeze(entry.tables.slice()),
      secrets: Object.freeze(secrets.slice())
    });
  }));
}

async function assertUnboundIdentity (connection, code) {
  const result = await connection.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  const role = result.rows[0];
  if (!role || (role.rolsuper !== true && role.rolbypassrls !== true)) throw refuse(code);
  return { superuser: role.rolsuper === true, bypassrls: role.rolbypassrls === true };
}

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

const columnsEqual = (a, b) => canonical(a.map(c => ({ name: c.name, type: c.type, identity: c.identity === true }))) ===
  canonical(b.map(c => ({ name: c.name, type: c.type, identity: c.identity === true })));

async function readRows (connection, namespace, table, columns) {
  const result = await connection.query('SELECT ' + columns.map(column => '"' + column.name + '"').join(', ') +
    ' FROM ' + qualified(namespace, table));
  return result.rows.map(row => ({ ...row }));
}

// A table travels as newline-delimited canonical JSON, one row per line, in
// lexical order of the lines: deterministic without depending on either
// database's collation. The digest is over the file text, so it can be
// recomputed from the file alone or from rows read back.
function encodeTable (rows) {
  const lines = rows.map(canonical).sort();
  const text = lines.length ? lines.join('\n') + '\n' : '';
  return { text, count: lines.length, digest: sha256(text) };
}

function decodeTable (text) {
  if (typeof text !== 'string') throw refuse('OPERATIONS_TABLE_TEXT');
  if (text === '') return [];
  if (!text.endsWith('\n')) throw refuse('OPERATIONS_TABLE_TEXT', 'unterminated');
  return text.slice(0, -1).split('\n').map(line => JSON.parse(line));
}

function tenantCounts (rows) {
  const counts = {};
  for (const row of rows) {
    if (typeof row.tenant_id !== 'string' || !UUID.test(row.tenant_id)) throw refuse('OPERATIONS_ROW_TENANT', row.tenant_id);
    counts[row.tenant_id] = (counts[row.tenant_id] || 0) + 1;
  }
  return counts;
}

function keyReferences (rows, key) {
  return rows.map(row => {
    const match = typeof row.ciphertext === 'string' && CIPHERTEXT.exec(row.ciphertext);
    if (!match) throw refuse('BACKUP_SECRET_FORMAT', key + '.' + row.id);
    return { tenant_id: row.tenant_id, id: row.id, scheme: 'vault-transit', keyVersion: Number(match[1]) };
  });
}

// The oracle's view of a set of namespaces: ledger, and for each table the
// count, digest and per-tenant counts recomputed from the rows as they stand.
// Namespaces are not part of the result, so a source and a restore target
// compare by kind and table.
async function summarize (connection, steps) {
  const catalogues = [];
  for (const step of steps) {
    const ledger = await readLedger(connection, step.namespace);
    const tables = [];
    for (const table of step.tables) {
      const columns = await columnsOf(connection, step.namespace, table);
      const rows = await readRows(connection, step.namespace, table, columns);
      const encoded = encodeTable(rows);
      tables.push({ table, count: encoded.count, digest: encoded.digest, tenants: tenantCounts(rows) });
    }
    catalogues.push({ kind: step.kind, ledger, tables });
  }
  return { catalogues };
}

// Differences between two summaries, as the oracle reports them: an empty
// list is green. Ledgers, counts, digests and per-tenant counts are compared.
function compareSummaries (expected, actual) {
  const differences = [];
  const actualKinds = new Map(actual.catalogues.map(c => [c.kind, c]));
  for (const catalogue of expected.catalogues) {
    const other = actualKinds.get(catalogue.kind);
    if (!other) { differences.push({ kind: catalogue.kind, what: 'catalogue missing' }); continue; }
    if (!ledgerEqual(catalogue.ledger, other.ledger)) differences.push({ kind: catalogue.kind, what: 'ledger' });
    const otherTables = new Map(other.tables.map(t => [t.table, t]));
    for (const table of catalogue.tables) {
      const key = tableKey(catalogue.kind, table.table);
      const counterpart = otherTables.get(table.table);
      if (!counterpart) { differences.push({ key, what: 'table missing' }); continue; }
      if (counterpart.count !== table.count) differences.push({ key, what: 'count', expected: table.count, actual: counterpart.count });
      if (counterpart.digest !== table.digest) differences.push({ key, what: 'digest' });
      const tenants = new Set([...Object.keys(table.tenants), ...Object.keys(counterpart.tenants)]);
      for (const tenant of tenants) {
        if ((table.tenants[tenant] || 0) !== (counterpart.tenants[tenant] || 0)) {
          differences.push({ key, what: 'tenant rows', tenant, expected: table.tenants[tenant] || 0, actual: counterpart.tenants[tenant] || 0 });
        }
      }
    }
  }
  for (const catalogue of actual.catalogues) {
    if (!expected.catalogues.some(c => c.kind === catalogue.kind)) differences.push({ kind: catalogue.kind, what: 'catalogue unexpected' });
  }
  return differences;
}

function assertSameSummary (expected, actual, code = 'ORACLE_MISMATCH') {
  const differences = compareSummaries(expected, actual);
  if (differences.length) {
    const error = refuse(code, differences.map(d => (d.key || d.kind) + ' ' + d.what + (d.tenant ? ' ' + d.tenant : '')).join('; '));
    error.differences = differences;
    throw error;
  }
  return true;
}

// The manifest as the oracle sees it: what a restored tree must reproduce.
function summaryOfManifest (manifest) {
  return {
    catalogues: manifest.catalogues.map(catalogue => ({
      kind: catalogue.kind,
      ledger: catalogue.ledger,
      tables: catalogue.tables.map(table => ({ table: table.table, count: table.count, digest: table.digest, tenants: tenantsOfManifest(manifest, catalogue.kind, table.table) }))
    }))
  };
}

function tenantsOfManifest (manifest, kind, table) {
  const key = tableKey(kind, table);
  const counts = {};
  for (const tenant of manifest.tenants) {
    if (tenant.rows[key]) counts[tenant.tenant_id] = tenant.rows[key];
  }
  return counts;
}

const manifestDigest = manifest => sha256(canonical(manifest));

async function transaction (connection, begin, fn) {
  await connection.query(begin);
  try {
    const result = await fn();
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    try { await connection.query('ROLLBACK'); } catch (rollbackError) {
      throw new globalThis.AggregateError([error, rollbackError], 'operation and rollback failed');
    }
    throw error;
  }
}

function timestamp (now) {
  const value = typeof now === 'function' ? now() : Date.now();
  if (!Number.isSafeInteger(value) || value < 0) throw refuse('OPERATIONS_CLOCK_INVALID');
  return value;
}

module.exports = {
  FORMAT, VERSION, UUID, COMMIT, DIGEST, ROLE, CIPHERTEXT,
  refuse, canonical, sha256, tableKey, qualified, ledgerOf, ledgerEqual, ledgerPrefix, namespaceValid, plan,
  assertUnboundIdentity, readLedger, columnsOf, columnsEqual, readRows, encodeTable, decodeTable, tenantCounts,
  keyReferences, summarize, compareSummaries, assertSameSummary, summaryOfManifest, manifestDigest, transaction, timestamp
};
