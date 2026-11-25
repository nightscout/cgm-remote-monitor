'use strict';

// INC-U: partial unique indexes over the treatments fallback key
// (lib/server/treatment-fallback-key.js, BF-121), PostgreSQL only.
//
// The fallback key is a conjunction of equalities: created_at and eventType;
// then each client id the write carries (syncIdentifier, id, uuid,
// NSCLIENT_ID); or, when it carries none, carbs and insulin equal (null equal
// to absent) on a record that carries no client id and no identifier. A
// soft-deleted record is not matched by a time-key write that reaches one
// (write-intent plannedOnDeleted) and is acknowledged by an identity write, so
// the indexes hold live rows only.
//
// One index per class:
//   none          (tenant_id, created_at, eventType, carbs, insulin)
//                 where no client id and no identifier is present
//   <client id>   (tenant_id, created_at, eventType, <client id>)
//                 where that client id is present (whatever else is)
// Each key part is the jsonb value itself (JSON null folded into SQL NULL,
// NULLS NOT DISTINCT), so equality is the filter's equality: type-sensitive,
// numbers numerically, strings byte for byte. A row whose key part is an array
// or object is left out: MongoDB's (and postgres-filter's) $eq matches an array
// by its elements, which a btree key cannot express. Such rows are counted by
// the census ("unindexable"); the write path never relies on the index for a
// write whose own key holds one.
//
// Soundness (read-derived, tested in tests/treatment-key-index.integration.test.js):
// for a write carrying exactly one client id, or none, every live stored row
// its fallback filter matches with scalar key parts and not exempt is in that
// class's index under the write's key. The set-based path takes a batch only
// when the rows its filters reach before the clock are all of that kind, and
// the clock's validation read sends it to the per-operation path when a row
// committed since overlaps; so INSERT ... ON CONFLICT on that index decides
// match versus insert exactly as the per-document replace would.
//
// INC-U2, outcome parity with single-tenant official/dev (MongoDB, no such
// index): the index never refuses a write official/dev accepts. A row whose
// write would collide with a live row's key (a v1 write carrying a new _id or
// another match rule's insert onto a stored key, an edit onto another record's
// key, a revive, rows already stored with equal keys) is stored with the
// column key_exempt = true, which takes it out of every class's predicate. The
// row and its document are exactly what official/dev stores; the marker is not
// part of the document and no client reads it. A fallback filter that reaches
// an exempt row is not decided by the index: the set-based path declines and
// the per-operation path decides, as it does where no index exists.
//
// Build rule WRITE_TREATMENT_KEY_INDEX=off|try|require (operator tool
// tools/treatment-key-index.js; the runtime role does not own the table):
//   off      build nothing, drop nothing; report what is there
//   try      add the column (metadata only), mark all but the earliest row of
//            each colliding live key group exempt, build each class; a class
//            whose build fails is left without and recorded
//   require  as try; any class without its index is an error
// Reversal (`drop`): drop the indexes, then the column. Documents are never
// touched, so the table is as it was before.
// The write path (NS_TREATMENT_KEY_UPSERT, postgres-entries-write.js) uses a
// class only when its index is present and valid; the exempt retry runs
// wherever any key index exists (valid, or being built).

const CLIENT_IDS = Object.freeze(['syncIdentifier', 'id', 'uuid', 'NSCLIENT_ID']);
const CLASSES = Object.freeze(['none'].concat(CLIENT_IDS));
const SWITCH = 'NS_TREATMENT_KEY_UPSERT';
const MODES = Object.freeze(['off', 'try', 'require']);
const SUFFIX = Object.freeze({ none: 'none', syncIdentifier: 'syncidentifier', id: 'id', uuid: 'uuid', NSCLIENT_ID: 'nsclient_id' });

function enabled (source = process.env) {
  const raw = source?.[SWITCH];
  if (raw === undefined || raw === '' || raw === '0') return false;
  if (raw !== '1') throw new TypeError('invalid ' + SWITCH + ': 0 or 1 is required');
  return true;
}

function parseMode (value) {
  const mode = value === undefined || value === '' ? 'off' : String(value);
  if (!MODES.includes(mode)) throw new TypeError('invalid WRITE_TREATMENT_KEY_INDEX: ' + MODES.join('|') + ' is required');
  return mode;
}

// --- SQL ------------------------------------------------------------------
// Field names below are fixed literals, never input.
const x = field => `(doc -> '${field}')`;
const part = field => `NULLIF(${x(field)}, 'null'::jsonb)`;
const scalar = field => `COALESCE(jsonb_typeof(${x(field)}) NOT IN ('array', 'object'), true)`;
const absent = field => `COALESCE(${x(field)} IN ('null'::jsonb, '""'::jsonb), true)`;
const present = field => `NOT ${absent(field)}`;
const LIVE = `NOT COALESCE(${x('isValid')} @> 'false'::jsonb, false)`;
const EXEMPT = 'key_exempt';
const INDEXED = `NOT ${EXEMPT}`;

function keyFields (cls) {
  return cls === 'none' ? ['created_at', 'eventType', 'carbs', 'insulin'] : ['created_at', 'eventType', cls];
}

function keyExpressions (cls) {
  return keyFields(cls).map(field => cls !== 'none' && field === cls ? x(field) : part(field));
}

function predicate (cls) {
  if (cls === 'none') {
    return [INDEXED, LIVE, ...['created_at', 'eventType', 'carbs', 'insulin'].map(scalar),
      ...CLIENT_IDS.concat(['identifier']).map(absent)].join(' AND ');
  }
  return [INDEXED, LIVE, scalar('created_at'), scalar('eventType'), present(cls), scalar(cls)].join(' AND ');
}

function indexName (tableName, cls) {
  if (!CLASSES.includes(cls)) throw new TypeError('unknown treatment key class ' + cls);
  return tableName + '_key_' + SUFFIX[cls];
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
function qualified (table) {
  const parts = String(table).split('.');
  if (!parts.length || parts.length > 2 || !parts.every(p => IDENT.test(p))) throw new TypeError('treatment key index: plain table name required');
  return { from: parts.map(p => `"${p}"`).join('.'), schema: parts.length === 2 ? parts[0] : null, table: parts[parts.length - 1] };
}

// The arbiter clause of INSERT ... ON CONFLICT for one class: the index's own
// expressions and predicate, so PostgreSQL infers exactly that index.
function conflictTarget (cls) {
  return `(tenant_id, ${keyExpressions(cls).map(e => '(' + e + ')').join(', ')}) WHERE ${predicate(cls)}`;
}

function createSql (table, cls, { concurrently = true } = {}) {
  const t = qualified(table);
  return `CREATE UNIQUE INDEX ${concurrently ? 'CONCURRENTLY ' : ''}IF NOT EXISTS "${indexName(t.table, cls)}" ON ${t.from}` +
    ` (tenant_id, ${keyExpressions(cls).map(e => '(' + e + ')').join(', ')}) NULLS NOT DISTINCT WHERE ${predicate(cls)}`;
}

// Per tenant: key groups held by more than one live row of the class, and the
// rows in them. GROUP BY treats NULLs as equal, as NULLS NOT DISTINCT does.
function censusSql (table, cls, exempt = true) {
  const t = qualified(table);
  const keys = keyExpressions(cls);
  const where = exempt ? predicate(cls) : predicate(cls).replace(INDEXED + ' AND ', '');
  return `SELECT tenant_id::text AS tenant, count(*)::bigint AS groups, sum(n)::bigint AS rows FROM (` +
    `SELECT tenant_id, ${keys.map((e, i) => e + ' AS k' + i).join(', ')}, count(*) AS n FROM ${t.from}` +
    ` WHERE ${where} GROUP BY tenant_id, ${keys.map((_, i) => 'k' + i).join(', ')} HAVING count(*) > 1) g` +
    ' GROUP BY tenant_id ORDER BY tenant_id';
}

// Per tenant: live rows a fallback filter can match by an array element but no
// index can hold; rows carrying two or more client ids; rows carrying an
// identifier and a client id (API v3 records in a client-id class).
function exposureSql (table, exempt = true) {
  const t = qualified(table);
  const arr = field => `jsonb_typeof(${x(field)}) = 'array'`;
  const anyId = CLIENT_IDS.map(present).join(' OR ');
  const idCount = CLIENT_IDS.map(f => `(CASE WHEN ${present(f)} THEN 1 ELSE 0 END)`).join(' + ');
  return `SELECT tenant_id::text AS tenant, count(*)::bigint AS live,` +
    ` count(*) FILTER (WHERE ${arr('created_at')} OR ${arr('eventType')} OR ${CLIENT_IDS.map(arr).join(' OR ')}` +
    ` OR ((${CLIENT_IDS.concat(['identifier']).map(absent).join(' AND ')}) AND (${arr('carbs')} OR ${arr('insulin')})))::bigint AS unindexable,` +
    ` count(*) FILTER (WHERE ${idCount} >= 2)::bigint AS multi_id,` +
    ` count(*) FILTER (WHERE ${present('identifier')} AND (${anyId}))::bigint AS identifier_with_client_id,` +
    ` count(*) FILTER (WHERE NOT (${anyId}) AND ${present('identifier')})::bigint AS identifier_only` +
    (exempt ? `, count(*) FILTER (WHERE ${EXEMPT})::bigint AS exempt` : ', 0::bigint AS exempt') +
    ` FROM ${t.from} WHERE ${LIVE} GROUP BY tenant_id ORDER BY tenant_id`;
}

async function columnState (client, table) {
  const t = qualified(table);
  const { rows } = await client.query(`SELECT a.attname AS name FROM pg_attribute a JOIN pg_class r ON r.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE r.relname = $1 AND n.nspname = COALESCE($2, current_schema()) AND a.attname = ANY($3) AND a.attnum > 0 AND NOT a.attisdropped`,
  [t.table, t.schema, [EXEMPT, 'insertion_ordinal']]);
  const names = new Set(rows.map(row => row.name));
  return { exempt: names.has(EXEMPT), ordinal: names.has('insertion_ordinal') };
}

async function census (client, table) {
  const { exempt } = await columnState(client, table);
  const byTenant = new Map();
  const of = tenant => {
    if (!byTenant.has(tenant)) byTenant.set(tenant, { tenant, classes: {} });
    return byTenant.get(tenant);
  };
  for (const row of (await client.query(exposureSql(table, exempt))).rows) {
    Object.assign(of(row.tenant), { live: Number(row.live), unindexable: Number(row.unindexable), multiId: Number(row.multi_id),
      identifierWithClientId: Number(row.identifier_with_client_id), identifierOnly: Number(row.identifier_only), exempt: Number(row.exempt) });
  }
  const totals = {};
  for (const cls of CLASSES) {
    totals[cls] = { groups: 0, rows: 0, tenants: 0 };
    for (const row of (await client.query(censusSql(table, cls, exempt))).rows) {
      of(row.tenant).classes[cls] = { groups: Number(row.groups), rows: Number(row.rows) };
      totals[cls].groups += Number(row.groups);
      totals[cls].rows += Number(row.rows);
      totals[cls].tenants++;
    }
  }
  return { tenants: [...byTenant.values()], totals };
}

async function existing (client, table) {
  const t = qualified(table);
  const names = CLASSES.map(cls => indexName(t.table, cls));
  const { rows } = await client.query(`SELECT c.relname AS name, i.indisvalid AS valid, i.indisunique AS "unique"
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class r ON r.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE r.relname = $1 AND n.nspname = COALESCE($2, current_schema()) AND c.relname = ANY($3)`, [t.table, t.schema, names]);
  const found = {};
  for (const cls of CLASSES) {
    const row = rows.find(r => r.name === indexName(t.table, cls));
    found[cls] = row ? (row.valid && row.unique ? 'present' : 'invalid') : 'absent';
  }
  return found;
}

// Mark all but the earliest live row of each colliding key group of one class
// exempt, per tenant (the insertion-ordinal trigger requires the tenant
// binding on any UPDATE). The document is not written. Returns rows marked.
function markSql (table, cls, ordinal) {
  const t = qualified(table);
  const keys = keyExpressions(cls);
  const order = ordinal ? 'insertion_ordinal' : 'id_kind, "_id"';
  return `UPDATE ${t.from} AS e SET ${EXEMPT} = true FROM (SELECT id_kind, "_id", row_number() OVER` +
    ` (PARTITION BY ${keys.join(', ')} ORDER BY ${order}) AS rn FROM ${t.from}` +
    ` WHERE tenant_id = $1::uuid AND ${predicate(cls)}) AS d` +
    ' WHERE e.tenant_id = $1::uuid AND e.id_kind = d.id_kind AND e."_id" = d."_id" AND d.rn > 1';
}

async function markTenant (client, table, cls, tenant, ordinal) {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenant]);
    const { rowCount } = await client.query(markSql(table, cls, ordinal), [tenant]);
    await client.query('COMMIT');
    return rowCount;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}

function dropSql (table, cls, concurrently) {
  const t = qualified(table);
  return `DROP INDEX ${concurrently ? 'CONCURRENTLY ' : ''}IF EXISTS ` + (t.schema ? `"${t.schema}".` : '') + `"${indexName(t.table, cls)}"`;
}

// The build rule. `client` is an owner connection outside any transaction
// (CREATE INDEX CONCURRENTLY). Never throws for a class; `errors` lists what
// stops `require`.
//   1. ALTER TABLE ADD COLUMN key_exempt boolean NOT NULL DEFAULT false
//      (metadata only on PostgreSQL 11+; a brief ACCESS EXCLUSIVE lock).
//   2. Per class: mark the colliding rows exempt (counts recorded), build
//      CONCURRENTLY. A row that collides while the index is being built is
//      marked by the writer itself (the exempt retry); a build that still fails
//      on a duplicate is dropped and repeated, at most three times.
async function ensure (client, table, mode, { log = console, concurrently = true } = {}) {
  mode = parseMode(mode);
  const status = { mode, ready: false, classes: {}, errors: [] };
  const before = await existing(client, table);
  if (mode !== 'off') await client.query(`ALTER TABLE ${qualified(table).from} ADD COLUMN IF NOT EXISTS ${EXEMPT} boolean NOT NULL DEFAULT false`);
  const { ordinal } = await columnState(client, table);
  for (const cls of CLASSES) {
    if (mode === 'off' || before[cls] === 'present') {
      status.classes[cls] = { state: before[cls] === 'present' ? 'present' : 'off' };
      continue;
    }
    try {
      if (before[cls] === 'invalid') await client.query(dropSql(table, cls, concurrently));
      const result = { state: 'built', marked: 0, tenants: 0 };
      for (let attempt = 1; ; attempt++) {
        for (const row of (await client.query(censusSql(table, cls))).rows) {
          result.marked += await markTenant(client, table, cls, row.tenant, ordinal);
          result.tenants++;
        }
        try {
          await client.query(createSql(table, cls, { concurrently }));
          break;
        } catch (error) {
          if (error.code !== '23505' || attempt >= 3) throw error;
          await client.query(dropSql(table, cls, concurrently));
        }
      }
      status.classes[cls] = result;
    } catch (error) {
      await client.query(dropSql(table, cls, concurrently)).catch(() => {});
      status.classes[cls] = { state: 'failed', error: String(error.code || error.message) };
    }
  }
  status.ready = CLASSES.every(cls => ['present', 'built'].includes(status.classes[cls].state));
  for (const cls of CLASSES) {
    const s = status.classes[cls];
    if (s.state === 'built' && s.marked) log.warn('treatment key index ' + cls + ': ' + s.marked + ' row(s) in ' + s.tenants + ' tenant(s) marked exempt (equal live keys)');
    if (['present', 'built', 'off'].includes(s.state)) continue;
    const line = 'treatment key index ' + cls + ': ' + s.state + (s.error ? ' (' + s.error + ')' : '');
    if (mode === 'require') status.errors.push(line);
    else log.warn(line);
  }
  return status;
}

// Reversal: indexes first (the predicate names the column), then the column.
async function drop (client, table, { concurrently = true } = {}) {
  for (const cls of CLASSES) await client.query(dropSql(table, cls, concurrently));
  await client.query(`ALTER TABLE ${qualified(table).from} DROP COLUMN IF EXISTS ${EXEMPT}`);
}

// --- runtime --------------------------------------------------------------
// Which classes have a valid index, per table, cached briefly. Read before the
// clock, through the caller's tenant-bound connection (pg_index is readable).
const CACHE_MS = 30000;
const cache = new Map();
async function lookup (connection, table) {
  const hit = cache.get(table);
  if (hit && hit.until > Date.now()) return hit;
  const found = await existing(connection, table);
  const entry = { classes: new Set(CLASSES.filter(cls => found[cls] === 'present')),
    any: CLASSES.some(cls => found[cls] !== 'absent'), until: Date.now() + CACHE_MS };
  cache.set(table, entry);
  return entry;
}
async function presentClasses (connection, table) { return (await lookup(connection, table)).classes; }
// Any key index, valid or being built (CREATE INDEX CONCURRENTLY checks new
// rows before the index is valid): writes that could collide need the retry.
async function anyIndex (connection, table) { return (await lookup(connection, table)).any; }
function forget (table) { if (table === undefined) cache.clear(); else cache.delete(table); }

// JavaScript mirror of the SQL above, over a decoded stored document or a
// write's document. undefined and null are one value, as NULLIF + NULLS NOT
// DISTINCT make them.
const isAbsent = v => v === undefined || v === null || v === '';
const isScalar = v => v === undefined || v === null || typeof v !== 'object';
const isLive = doc => !(doc.isValid === false || (Array.isArray(doc.isValid) && doc.isValid.includes(false)));

function inClass (cls, doc, exempt = false) {
  if (exempt === true) return false;
  if (!isLive(doc) || !isScalar(doc.created_at) || !isScalar(doc.eventType)) return false;
  if (cls === 'none') {
    return isScalar(doc.carbs) && isScalar(doc.insulin) && CLIENT_IDS.concat(['identifier']).every(f => isAbsent(doc[f]));
  }
  return !isAbsent(doc[cls]) && isScalar(doc[cls]);
}

function keyOf (cls, doc) {
  return JSON.stringify(keyFields(cls).map(f => doc[f] === undefined ? null : doc[f]));
}

// The class of a write's fallback filter (a filter AST of
// treatment-fallback-key.fallbackQuery, possibly wrapped by visible()), with
// the values it names; null when the filter is anything else. A filter naming
// two client ids is not a class: two indexes would each be an arbiter.
function classOfFilter (ast) {
  const leaves = [];
  (function walk (n) { if (n.op === 'and') n.nodes.forEach(walk); else leaves.push(n); })(ast);
  const eq = {}, nulls = new Set();
  let hidden = false;
  for (const n of leaves) {
    if (n.op === 'eq' && ['created_at', 'eventType', 'carbs', 'insulin', ...CLIENT_IDS].includes(n.field)) {
      if (Object.hasOwn(eq, n.field) || !Object.hasOwn(n, 'value') || !isScalar(n.value)) return null;
      eq[n.field] = n.value;
    } else if (n.op === 'in' && CLIENT_IDS.concat(['identifier']).includes(n.field) && JSON.stringify(n.value) === '[null,""]') {
      nulls.add(n.field + ':in');
    } else if (n.op === 'nottype' && n.value === 'array' && CLIENT_IDS.concat(['identifier']).includes(n.field)) {
      nulls.add(n.field + ':nottype');
    } else if (n.op === 'ne' && n.field === 'isValid' && n.value === false) {
      hidden = true;
    } else return null;
  }
  if (!Object.hasOwn(eq, 'created_at') || !Object.hasOwn(eq, 'eventType')) return null;
  const ids = CLIENT_IDS.filter(f => Object.hasOwn(eq, f));
  if (ids.length === 1 && nulls.size === 0 && !Object.hasOwn(eq, 'carbs') && !Object.hasOwn(eq, 'insulin') && !isAbsent(eq[ids[0]])) {
    return { cls: ids[0], values: eq, hidden };
  }
  if (ids.length === 0 && Object.hasOwn(eq, 'carbs') && Object.hasOwn(eq, 'insulin') && nulls.size === 10) {
    return { cls: 'none', values: eq, hidden };
  }
  return null;
}

// The class whose key index a unique violation names, or null.
function violatedClass (error, tableName) {
  if (!error || error.code !== '23505' || typeof error.constraint !== 'string') return null;
  return CLASSES.find(cls => error.constraint === indexName(tableName, cls)) || null;
}

module.exports = { SWITCH, CLASSES, CLIENT_IDS, MODES, EXEMPT, enabled, parseMode, keyFields, keyExpressions, predicate, indexName,
  conflictTarget, createSql, censusSql, markSql, exposureSql, census, columnState, existing, ensure, drop, presentClasses, anyIndex,
  forget, inClass, keyOf, classOfFilter, violatedClass, qualified };
