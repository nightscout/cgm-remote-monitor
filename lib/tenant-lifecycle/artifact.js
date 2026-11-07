'use strict';

// Research artifact format for the tenant export/deletion early proof. This is
// not an adopted backup format: it exists so the proof can compare typed rows,
// tenant binding and ciphertext/key references before and after an operation.
// Rows are the non-generated columns of each admitted table, as the driver
// returns them (jsonb as logical objects, bigint/numeric as decimal strings).
// Ciphertext travels as stored; plaintext and provider keys never appear.

const crypto = require('node:crypto');

const FORMAT = 'nightscout-tenant-lifecycle-research-artifact';
const VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CIPHERTEXT = /^vault:v([1-9][0-9]*):[A-Za-z0-9+/=]+$/;
const DIGEST = /^[a-f0-9]{64}$/;

function refuse (code, detail) {
  const error = new Error(detail === undefined ? code : code + ': ' + detail);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

// Deterministic JSON: object members sorted, arrays in order. Rows from the
// driver never carry undefined; refuse it rather than silently drop a member.
function canonical (value) {
  if (value === undefined) throw refuse('LIFECYCLE_CANONICAL_UNDEFINED');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => {
    if (value[key] === undefined) throw refuse('LIFECYCLE_CANONICAL_UNDEFINED', key);
    return JSON.stringify(key) + ':' + canonical(value[key]);
  }).join(',') + '}';
}

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

// Rows compare as a multiset: equal-time rows have no promised order unless a
// table carries its own ordering column, which then travels inside the row.
function digestRows (rows) {
  return sha256(rows.map(canonical).sort().join('\n'));
}

function keyReference (ciphertext) {
  const match = typeof ciphertext === 'string' && CIPHERTEXT.exec(ciphertext);
  if (!match) throw refuse('LIFECYCLE_CIPHERTEXT_FORMAT');
  return Object.freeze({ scheme: 'vault-transit', keyVersion: Number(match[1]) });
}

const tableKey = (kind, table) => kind + '.' + table;

function manifestDigest (manifest) {
  return sha256(canonical(manifest));
}

// catalogues: [{ kind, namespace, ledger: [{name, checksum}], tables: [{ table,
// columns: [{name, type, identity}], rows, secrets?: boolean, keyReferences? }] }]
function buildArtifact ({ tenant, sourceCommit, exportedAt, catalogues, keyNames = null }) {
  if (typeof tenant !== 'string' || !UUID.test(tenant)) throw refuse('LIFECYCLE_TENANT_INVALID');
  if (typeof sourceCommit !== 'string' || !/^[a-f0-9]{7,40}$/.test(sourceCommit)) throw refuse('LIFECYCLE_SOURCE_COMMIT_INVALID');
  if (!Number.isSafeInteger(exportedAt) || exportedAt < 0) throw refuse('LIFECYCLE_EXPORTED_AT_INVALID');
  const tables = {};
  const manifest = {
    format: FORMAT,
    version: VERSION,
    tenant,
    sourceCommit,
    exportedAt,
    keyNames,
    catalogues: catalogues.map(catalogue => ({
      kind: catalogue.kind,
      namespace: catalogue.namespace,
      ledger: catalogue.ledger.map(entry => ({ name: entry.name, checksum: entry.checksum })),
      tables: catalogue.tables.map(entry => {
        const key = tableKey(catalogue.kind, entry.table);
        const rows = entry.rows.map(row => ({ ...row }));
        tables[key] = rows;
        const described = {
          table: entry.table,
          columns: entry.columns.map(column => ({ name: column.name, type: column.type, identity: column.identity === true })),
          count: rows.length,
          digest: digestRows(rows)
        };
        if (entry.secrets) {
          described.keyReferences = entry.keyReferences
            ? entry.keyReferences.map(reference => ({ id: reference.id, keyReference: { ...reference.keyReference } }))
            : rows.map(row => ({ id: row.id, keyReference: keyReference(row.ciphertext) }));
        }
        return described;
      })
    }))
  };
  const artifact = { format: FORMAT, version: VERSION, manifest, tables, digest: manifestDigest(manifest) };
  validateArtifact(artifact);
  return artifact;
}

// Structural and self-consistency validation; refuses before any database
// work. Target-dependent checks (ledger, columns, emptiness) live in index.js.
function validateArtifact (artifact) {
  if (!artifact || artifact.format !== FORMAT || artifact.version !== VERSION || !artifact.manifest ||
      !artifact.tables || typeof artifact.tables !== 'object') {
    throw refuse('LIFECYCLE_ARTIFACT_FORMAT');
  }
  const manifest = artifact.manifest;
  if (manifest.format !== FORMAT || manifest.version !== VERSION || typeof manifest.tenant !== 'string' ||
      !UUID.test(manifest.tenant) || !Array.isArray(manifest.catalogues)) {
    throw refuse('LIFECYCLE_ARTIFACT_FORMAT');
  }
  if (typeof artifact.digest !== 'string' || !DIGEST.test(artifact.digest) || artifact.digest !== manifestDigest(manifest)) {
    throw refuse('LIFECYCLE_ARTIFACT_DIGEST');
  }
  const seen = new Set();
  for (const catalogue of manifest.catalogues) {
    if (typeof catalogue.kind !== 'string' || typeof catalogue.namespace !== 'string' || !Array.isArray(catalogue.ledger) ||
        !Array.isArray(catalogue.tables)) throw refuse('LIFECYCLE_ARTIFACT_FORMAT', catalogue.kind);
    for (const entry of catalogue.tables) {
      const key = tableKey(catalogue.kind, entry.table);
      if (seen.has(key)) throw refuse('LIFECYCLE_ARTIFACT_FORMAT', key);
      seen.add(key);
      const rows = artifact.tables[key];
      if (!Array.isArray(rows) || !Array.isArray(entry.columns) || rows.length !== entry.count) {
        throw refuse('LIFECYCLE_ARTIFACT_COUNT', key);
      }
      if (digestRows(rows) !== entry.digest) throw refuse('LIFECYCLE_ARTIFACT_TABLE_DIGEST', key);
      for (const row of rows) {
        if (!row || typeof row !== 'object' || row.tenant_id !== manifest.tenant) {
          throw refuse('LIFECYCLE_ROW_TENANT_MISMATCH', key);
        }
        for (const column of entry.columns) {
          if (!Object.hasOwn(row, column.name)) throw refuse('LIFECYCLE_ARTIFACT_COLUMN', key + '.' + column.name);
        }
      }
      if (entry.keyReferences !== undefined) {
        if (!Array.isArray(entry.keyReferences)) throw refuse('LIFECYCLE_ARTIFACT_FORMAT', key);
        const byId = new Map(rows.map(row => [row.id, row]));
        const referenced = new Set();
        for (const reference of entry.keyReferences) {
          const row = byId.get(reference.id);
          if (!row || typeof row.ciphertext !== 'string' || !row.ciphertext.length) {
            throw refuse('LIFECYCLE_KEY_REFERENCE_WITHOUT_CIPHERTEXT', key + '.' + reference.id);
          }
          const expected = keyReference(row.ciphertext);
          if (!reference.keyReference || reference.keyReference.scheme !== expected.scheme ||
              reference.keyReference.keyVersion !== expected.keyVersion) {
            throw refuse('LIFECYCLE_KEY_REFERENCE_MISMATCH', key + '.' + reference.id);
          }
          referenced.add(reference.id);
        }
        for (const row of rows) {
          if (!referenced.has(row.id)) throw refuse('LIFECYCLE_CIPHERTEXT_WITHOUT_KEY_REFERENCE', key + '.' + row.id);
        }
      }
    }
  }
  if (Object.keys(artifact.tables).some(key => !seen.has(key))) throw refuse('LIFECYCLE_ARTIFACT_FORMAT', 'unlisted table');
  return true;
}

function ledgerEqual (expected, actual) {
  return canonical(expected.map(e => ({ name: e.name, checksum: e.checksum }))) ===
    canonical(actual.map(e => ({ name: e.name, checksum: e.checksum })));
}

function columnsEqual (expected, actual) {
  return canonical(expected.map(c => ({ name: c.name, type: c.type, identity: c.identity === true }))) ===
    canonical(actual.map(c => ({ name: c.name, type: c.type, identity: c.identity === true })));
}

module.exports = {
  FORMAT, VERSION, refuse, canonical, digestRows, keyReference, tableKey, manifestDigest,
  buildArtifact, validateArtifact, ledgerEqual, columnsEqual
};
