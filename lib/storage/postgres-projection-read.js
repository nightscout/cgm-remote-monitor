'use strict';

// An explicit bounded recovered projection, queried by the existing PG reader.
// No physical clinical table, temporary table, DDL or write operation is used.
const scope = require('./tenant-scope');
const collection = require('./postgres-collection-intent');
const { encodeDocument } = require('./postgres-identity');
const memoryRead = require('./projection-memory-read');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGICAL = new Set(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity']);
const FROM = ' FROM "projection_records" WHERE ';
// Only a source this module prepared (validated and bounded) is accepted.
const PREPARED = new WeakSet();

// The validated source of one domain's projection reads: its typed rows as
// one JSON text, frozen before any asynchronous read; downstream plugins may
// mutate their decoded working documents without changing this source. A
// caller that reads the same documents many times (the evaluator's time-only
// cycles) prepares once and passes `prepared` instead of `documents`.
function prepare ({ documents, maxRows, maxBytes, memory = false } = {}) {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      !Array.isArray(documents) || documents.length > maxRows) throw new TypeError('Projection read bound exceeded or unspecified');
  const seen = new Set();
  const encoded = documents.map(document => {
    const row = encodeDocument(document);
    const key = JSON.stringify([row.id_kind, row.doc._id]);
    if (seen.has(key)) throw new TypeError('Projection read contains duplicate typed identities');
    seen.add(key);
    return row;
  });
  const json = JSON.stringify(encoded);
  if (Buffer.byteLength(json) > maxBytes) throw new TypeError('Projection read byte bound exceeded');
  // memory: also the rows as PostgreSQL would return them, for in-process reads.
  const source = Object.freeze({ json, rows: encoded.length, maxRows, maxBytes,
    memory: memory ? memoryRead.rowsOf(JSON.parse(json)) : null });
  PREPARED.add(source);
  return source;
}

// memory: answer from the prepared source in process (projection-memory-read.js)
// instead of sending it through PostgreSQL; requires a source prepared with memory.
module.exports = function projectionRead ({ tenant, connection, logical, documents, prepared,
  maxRows, maxBytes, env, memory = false } = {}) {
  if ((typeof tenant !== 'string' || !UUID.test(tenant)) || !connection || typeof connection.query !== 'function' || !LOGICAL.has(logical)) {
    throw new TypeError('Projection reads require explicit tenant, read connection and clinical domain');
  }
  if (prepared !== undefined && (documents !== undefined || !PREPARED.has(prepared) ||
      prepared.maxRows !== maxRows || prepared.maxBytes !== maxBytes)) {
    throw new TypeError('Projection read requires documents or a source prepared under the same bounds');
  }
  if (memory && (!prepared || !prepared.memory)) throw new TypeError('In-process projection reads require a source prepared with memory');
  const { json } = prepared || prepare({ documents, maxRows, maxBytes });
  const readConnection = {
    transaction () { throw new Error('Projection source is read-only'); },
    async query (text, values) {
      if (scope.requireTenant('projection read') !== tenant) throw new Error('Projection read tenant mismatch');
      if (typeof text !== 'string' || !text.startsWith('SELECT ') || text.split(FROM).length !== 2 ||
          text.includes('insertion_ordinal') || !Array.isArray(values)) {
        throw new Error('Projection source refuses an unexpected or natural-order query');
      }
      // Only substitute the reader's one validated FROM source. Filter, typed
      // identity, ordering, projection, limits and legacy translation stay in
      // postgres-entries-read / postgres-collection-intent, unchanged.
      const source = '(SELECT id_kind, doc, doc->>\'_id\' AS "_id" FROM jsonb_to_recordset($' +
        (values.length + 1) + '::jsonb) AS recovered(id_kind text, doc jsonb)) AS projection_source';
      return connection.query(text.replace(FROM, ' FROM ' + source + ' WHERE '), [...values, json]);
    }
  };
  const { storage } = collection({ connection: readConnection, table: 'projection_records', logical,
    env, source: 'v1/internal', ...(memory ? { reader: memoryRead({ rows: prepared.memory, legacyPatterns: true }) } : {}) });
  return Object.freeze(Object.fromEntries(['findFiltered', 'findOne', 'findOneFilter', 'count'].map(name => [name, storage[name]])));
};
module.exports.prepare = prepare;
