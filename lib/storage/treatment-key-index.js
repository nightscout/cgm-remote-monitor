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
// Soundness (read-derived, tested in tests/treatment-key-index.test.js): for a
// write carrying exactly one client id, or none, every live stored row its
// fallback filter matches with scalar key parts is in that class's index under
// the write's key; so INSERT ... ON CONFLICT on that index decides match versus
// insert exactly as the per-document replace would.
//
// Build rule WRITE_TREATMENT_KEY_INDEX=off|try|require (operator tool
// tools/treatment-key-index.js; the runtime role does not own the table):
//   off      build nothing, drop nothing; report what is there
//   try      per class: build where the census finds no colliding live rows,
//            record the counts where it does and leave that class without
//   require  as try; any class without its index is an error
// The write path (NS_TREATMENT_KEY_UPSERT, postgres-entries-write.js) uses a
// class only when its index is present and valid.

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

function keyFields (cls) {
  return cls === 'none' ? ['created_at', 'eventType', 'carbs', 'insulin'] : ['created_at', 'eventType', cls];
}

function keyExpressions (cls) {
  return keyFields(cls).map(field => cls !== 'none' && field === cls ? x(field) : part(field));
}

function predicate (cls) {
  if (cls === 'none') {
    return [LIVE, ...['created_at', 'eventType', 'carbs', 'insulin'].map(scalar),
      ...CLIENT_IDS.concat(['identifier']).map(absent)].join(' AND ');
  }
  return [LIVE, scalar('created_at'), scalar('eventType'), present(cls), scalar(cls)].join(' AND ');
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
function censusSql (table, cls) {
  const t = qualified(table);
  const keys = keyExpressions(cls);
  return `SELECT tenant_id::text AS tenant, count(*)::bigint AS groups, sum(n)::bigint AS rows FROM (` +
    `SELECT tenant_id, ${keys.map((e, i) => e + ' AS k' + i).join(', ')}, count(*) AS n FROM ${t.from}` +
    ` WHERE ${predicate(cls)} GROUP BY tenant_id, ${keys.map((_, i) => 'k' + i).join(', ')} HAVING count(*) > 1) g` +
    ' GROUP BY tenant_id ORDER BY tenant_id';
}

// Per tenant: live rows a fallback filter can match by an array element but no
// index can hold; rows carrying two or more client ids; rows carrying an
// identifier and a client id (API v3 records in a client-id class).
function exposureSql (table) {
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
    ` FROM ${t.from} WHERE ${LIVE} GROUP BY tenant_id ORDER BY tenant_id`;
}

async function census (client, table) {
  const byTenant = new Map();
  const of = tenant => {
    if (!byTenant.has(tenant)) byTenant.set(tenant, { tenant, classes: {} });
    return byTenant.get(tenant);
  };
  for (const row of (await client.query(exposureSql(table))).rows) {
    Object.assign(of(row.tenant), { live: Number(row.live), unindexable: Number(row.unindexable), multiId: Number(row.multi_id),
      identifierWithClientId: Number(row.identifier_with_client_id), identifierOnly: Number(row.identifier_only) });
  }
  const totals = {};
  for (const cls of CLASSES) {
    totals[cls] = { groups: 0, rows: 0, tenants: 0 };
    for (const row of (await client.query(censusSql(table, cls))).rows) {
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

// The build rule. `client` is an owner connection outside any transaction
// (CREATE INDEX CONCURRENTLY). Never throws for a class; `errors` lists what
// stops `require`.
async function ensure (client, table, mode, { log = console, concurrently = true } = {}) {
  mode = parseMode(mode);
  const status = { mode, ready: false, classes: {}, errors: [] };
  const before = await existing(client, table);
  for (const cls of CLASSES) {
    if (mode === 'off' || before[cls] === 'present') {
      status.classes[cls] = { state: before[cls] === 'present' ? 'present' : 'off' };
      continue;
    }
    try {
      if (before[cls] === 'invalid') await client.query(`DROP INDEX ${concurrently ? 'CONCURRENTLY ' : ''}IF EXISTS ` +
        (qualified(table).schema ? `"${qualified(table).schema}".` : '') + `"${indexName(qualified(table).table, cls)}"`);
      const blocked = (await client.query(censusSql(table, cls))).rows;
      if (blocked.length) {
        status.classes[cls] = { state: 'blocked', tenants: blocked.length,
          groups: blocked.reduce((n, r) => n + Number(r.groups), 0), rows: blocked.reduce((n, r) => n + Number(r.rows), 0) };
        continue;
      }
      try {
        await client.query(createSql(table, cls, { concurrently }));
        status.classes[cls] = { state: 'built' };
      } catch (error) {
        if (error.code !== '23505') throw error;
        // A colliding row stored between the census and the build.
        await client.query(`DROP INDEX ${concurrently ? 'CONCURRENTLY ' : ''}IF EXISTS ` +
          (qualified(table).schema ? `"${qualified(table).schema}".` : '') + `"${indexName(qualified(table).table, cls)}"`);
        status.classes[cls] = { state: 'blocked', raced: true };
      }
    } catch (error) {
      status.classes[cls] = { state: 'failed', error: String(error.code || error.message) };
    }
  }
  status.ready = CLASSES.every(cls => ['present', 'built'].includes(status.classes[cls].state));
  for (const cls of CLASSES) {
    const s = status.classes[cls];
    if (['present', 'built', 'off'].includes(s.state)) continue;
    const line = 'treatment key index ' + cls + ': ' + s.state + (s.state === 'blocked' && s.groups !== undefined
      ? ' (' + s.groups + ' key(s) held by more than one live row, ' + s.rows + ' rows, ' + s.tenants + ' tenant(s))' : '') +
      (s.error ? ' (' + s.error + ')' : '');
    if (mode === 'require') status.errors.push(line);
    else log.warn(line);
  }
  return status;
}

// --- runtime --------------------------------------------------------------
// Which classes have a valid index, per table, cached briefly. Read before the
// clock, through the caller's tenant-bound connection (pg_index is readable).
const CACHE_MS = 30000;
const cache = new Map();
async function presentClasses (connection, table) {
  const hit = cache.get(table);
  if (hit && hit.until > Date.now()) return hit.classes;
  const found = await existing(connection, table);
  const classes = new Set(CLASSES.filter(cls => found[cls] === 'present'));
  cache.set(table, { classes, until: Date.now() + CACHE_MS });
  return classes;
}
function forget (table) { if (table === undefined) cache.clear(); else cache.delete(table); }

// JavaScript mirror of the SQL above, over a decoded stored document or a
// write's document. undefined and null are one value, as NULLIF + NULLS NOT
// DISTINCT make them.
const isAbsent = v => v === undefined || v === null || v === '';
const isScalar = v => v === undefined || v === null || typeof v !== 'object';
const isLive = doc => !(doc.isValid === false || (Array.isArray(doc.isValid) && doc.isValid.includes(false)));

function inClass (cls, doc) {
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

class TreatmentKeyConflictError extends Error {
  constructor (cls) {
    super('another treatment is stored with this created_at, eventType and ' + (cls === 'none' ? 'amounts' : cls));
    this.name = 'TreatmentKeyConflictError';
    this.status = 409;
    this.keyClass = cls;
  }
}

module.exports = { SWITCH, CLASSES, CLIENT_IDS, MODES, enabled, parseMode, keyFields, keyExpressions, predicate, indexName,
  conflictTarget, createSql, censusSql, exposureSql, census, existing, ensure, presentClasses, forget, inClass, keyOf,
  classOfFilter, violatedClass, TreatmentKeyConflictError, qualified };
