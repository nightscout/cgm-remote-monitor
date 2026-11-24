'use strict';

const { fromMongo } = require('./filter');
const { compileFilter, indexedColumns, Params } = require('./postgres-filter');
const { decodeDocument } = require('./postgres-identity');

const MAX_COUNT = 10;
const TYPES = new Set(['sgv', 'mbg', 'cal']);
const INDEX_NAME = 'entries_tenant_follower_exception';

// PostgreSQL's immutable JSONPath datetime formatter renders the UTC whole
// second from a Julian day and seconds since midnight. Julian day 2440588
// is the Unix epoch. Add the exact millisecond suffix used by toISOString.
const iso = `(jsonb_path_query_first(
  ('"' || (2440588 + date / 86400000)::text || ' ' || (date / 1000 % 86400)::text || '"')::jsonb,
  '$.datetime("J SSSSS")') #>> '{}') || '.' || lpad((date % 1000)::text, 3, '0') || 'Z'`;

// The cache selects SGV/MBG by key presence and orders by normalized mills,
// while the storage index orders by date and type. Keep only rows that can
// violate this equivalence in the exception index. The original JSON range
// and deletion filter still decide whether an exceptional row is in scope.
const EXCEPTION = `CASE
  WHEN jsonb_typeof(doc -> 'date') = 'array' THEN true
  WHEN jsonb_typeof(doc -> 'date') IS DISTINCT FROM 'number' THEN false
  WHEN date IS NULL OR (doc ->> 'date')::numeric <> date OR date NOT BETWEEN 0 AND 4102444799999 THEN true
  WHEN (doc ? 'sgv' AND type IS DISTINCT FROM 'sgv') OR (doc ? 'mbg' AND type IS DISTINCT FROM 'mbg') THEN true
  WHEN doc ? 'mills' THEN doc -> 'mills' IS DISTINCT FROM doc -> 'date'
  WHEN NOT (doc ? 'created_at' OR doc ? 'sysTime') THEN false
  ELSE (CASE WHEN doc ? 'created_at' THEN doc ->> 'created_at' ELSE doc ->> 'sysTime' END)
       COLLATE "C" IS DISTINCT FROM (${iso}) COLLATE "C"
END`;

function followerEntries (connection, table) {
  const parts = table.split('.');
  if (parts.length > 2 || parts.some(part => !/^[a-z_][a-z0-9_]*$/.test(part)) || parts.at(-1) !== 'entries') {
    throw new TypeError('Follower entries require the entries table');
  }
  const fromTable = parts.map(part => '"' + part + '"').join('.');
  const columns = indexedColumns(table);
  return async function readFollowerEntries ({ from, to, type, count }) {
    if (!TYPES.has(type) || !Number.isSafeInteger(count) || count < 1 || count > MAX_COUNT ||
        !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to ||
        typeof connection.readOnlyTransaction !== 'function') return null;

    const params = new Params();
    const visible = compileFilter(fromMongo({ isValid: { $ne: false } }), params, { columns });
    const window = compileFilter(fromMongo({ date: { $gte: from, $lte: to } }), params, { columns });
    const typeParam = params.add(type);
    const lower = params.add(from), upper = params.add(to), limit = params.add(count + 1);
    const text = `WITH follower_exception AS MATERIALIZED (
      SELECT true FROM ${fromTable}
      WHERE (${EXCEPTION}) AND ${window} AND ${visible} LIMIT 1
    )
    SELECT null::text AS id_kind, null::jsonb AS doc, null::bigint AS date, true AS fallback FROM follower_exception
    UNION ALL
    (SELECT id_kind, doc, date, false AS fallback FROM ${fromTable}
      WHERE NOT EXISTS (SELECT 1 FROM follower_exception)
        AND type = ${typeParam}::text AND date BETWEEN ${lower}::bigint AND ${upper}::bigint AND ${visible}
      ORDER BY date DESC LIMIT ${limit})
    ORDER BY date DESC`;

    const { rows } = await connection.readOnlyTransaction(() => connection.query(text, params.values));
    if (rows[0]?.fallback) return null;
    // A sparse typed row without its value would be skipped by the cache.
    if (type !== 'cal' && rows.some(row => !Object.hasOwn(row.doc, type))) return null;
    // Equal dates, including the page boundary, need the original cache's
    // stable sort over the full ascending storage result.
    for (let i = 1; i < rows.length; i++) if (rows[i - 1].date === rows[i].date) return null;
    return rows.slice(0, count).reverse().map(decodeDocument);
  };
}

module.exports = { followerEntries, INDEX_NAME, EXCEPTION };
