'use strict';

// Dormant persistence slice, not a registered backend or write-intent adapter.
// No schema/index creation, validation policy or commit events.
// Inserts/sets accept JSON values; BSON coercion is refused.
const { ObjectId } = require('mongodb');
const { encodeDocument, decodeDocument } = require('./postgres-identity');
const { fromMongo, and, or, cmp } = require('./filter');
const { compileFilter: strictFilter, compileSort, Params, indexedColumns } = require('./postgres-filter');
const utils = require('../api3/storage/mongoCollection/utils');
const idForms = require('../server/object-id-forms');
const srvDates = require('../server/srv-dates');
const { RESOLVE_CAP } = require('./write-limits');
const windowMark = require('../writer-driven/window-mark');
const lateStamp = require('./late-stamp');
const keyIndex = require('./treatment-key-index');
const TABLE = /^[a-z_][a-z0-9_]*$/;
// Filters per existence read before the clock (as FILTERS_PER_READ, R3).
const LATE_FILTERS_PER_READ = 32;

function unsupported (message) {
  const error = new TypeError('PostgreSQL entries write: unsupported ' + message);
  error.unsupported = true;
  return error;
}

function fields (value, label, scalarValues = true, fullDocument = false) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== Object.keys(value).length) {
    throw unsupported(label + ' must be a plain field map');
  }
  for (const [key, item] of Object.entries(value)) {
    // These updates address top-level members, not Mongo dotted paths or
    // operators. A literal hyphen/Unicode name is not an SQL identifier.
    if ((!fullDocument && !key.length) || /[.$\0]/.test(key) || !key.isWellFormed() || key === '_id') {
      throw unsupported(label + ' field ' + key);
    }
    if (scalarValues) jsonValue(item, label + ' value for ' + key);
  }
  return value;
}

function jsonValue (value, label, active = new Set()) {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.includes('\0') || !value.isWellFormed()) throw unsupported(label + ' contains nonrepresentable text');
    return;
  }
  if (typeof value === 'number') {
    // Negative zero is admitted: JSON text, and so the stored document, renders
    // it as 0, which is what single-tenant MongoDB responses show. Only
    // nonfinite numbers cannot be represented.
    if (!Number.isFinite(value)) throw unsupported(label);
    return;
  }
  if (!value || typeof value !== 'object' || active.has(value)) throw unsupported(label);

  const keys = Reflect.ownKeys(value);
  const enumerable = Object.keys(value);
  const array = Array.isArray(value);
  if (array) {
    if (keys.length !== enumerable.length + 1 || enumerable.length !== value.length) {
      throw unsupported(label + ' array shape');
    }
  } else if ((Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || keys.length !== enumerable.length) {
    throw unsupported(label + ' object shape');
  }

  active.add(value);
  for (const key of enumerable) {
    if (key.includes('\0') || !key.isWellFormed()) throw unsupported(label + ' contains nonrepresentable text in a key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw unsupported(label + ' accessor');
    jsonValue(descriptor.value, label, active);
  }
  active.delete(value);
}

function options (value, allowed) {
  const o = value || {};
  if (Object.getPrototypeOf(o) !== Object.prototype) throw unsupported('options');
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) throw unsupported('option ' + key);
  }
  if (o.v1) throw unsupported('API v1 dialect');
  if (o.one) throw unsupported('unsorted single-record filter');
  return o;
}

function changes (set, unset) {
  const values = fields(set, 'set');
  const removed = unset === undefined || unset === null ? {} : fields(unset, 'unset', false);
  for (const key of Object.keys(removed)) {
    if (Object.hasOwn(values, key)) throw unsupported('conflicting set/unset field ' + key);
  }
  return { values, removed: Object.keys(removed) };
}

// windowDomain: the logical clinical domain of this table, for the resident
// window marks (lib/writer-driven/window-mark.js). With the switch on, each
// statement that changes rows also returns the stored window time of what it
// changed, and the writer notes it for the transaction's pending mark. A
// writer without a domain, or a value it cannot state exactly, notes an
// unbounded change. With the switch off no statement differs.
module.exports = function postgresEntriesWrite ({ connection, table = 'entries', legacyPatterns = false, windowDomain } = {}) {
  const columns = indexedColumns(table);
  const compileFilter = (ast, params) => strictFilter(ast, params, { legacyPatterns, columns });
  const marking = windowMark.enabled();
  const timed = marking && windowDomain !== undefined ? windowMark.TIMED[windowDomain] : undefined;
  const wt = timed ? timed.column + '::text' : null;
  // One changed row, or a set of them: the lowest time and whether any had none.
  function noteRow (value) { if (marking) { if (timed) windowMark.note(windowDomain, value); else noteAny(); } }
  function noteAny () { if (marking) { if (windowDomain === undefined) windowMark.unbounded(); else windowMark.note(windowDomain, null); } }
  function noteSet (count, lowest, anyNull) {
    if (!marking) return;
    if (!Number(count)) return windowMark.touch();
    if (!timed) return noteAny();
    if (anyNull !== false || lowest === null || lowest === undefined) return windowMark.note(windowDomain, null);
    windowMark.note(windowDomain, lowest);
  }
  const lowestOf = (relation, value) => `(SELECT min(${value})::text FROM ${relation})`;
  if (!connection || typeof connection.query !== 'function') {
    throw new TypeError('PostgreSQL entries write requires a tenant-bound connection');
  }
  const parts = typeof table === 'string' ? table.split('.') : [];
  if (!parts.length || parts.length > 2 || !parts.every(part => TABLE.test(part))) {
    throw new TypeError('PostgreSQL entries write requires a plain table name');
  }
  const from = parts.map(part => `"${part}"`).join('.');
  const tableName = parts[parts.length - 1];

  function document (doc) {
    if (!doc || Object.getPrototypeOf(doc) !== Object.prototype
      || Reflect.ownKeys(doc).length !== Object.keys(doc).length) throw unsupported('document');
    const { _id, ...rest } = doc;
    fields(rest, 'document', true, true);
    if (_id !== undefined) encodeDocument({ _id });
    return { _id, rest };
  }

  function duplicate (error) {
    if (error.code !== '23505' || error.table !== tableName
      || (parts.length === 2 && error.schema !== parts[0])) return error;
    const index = error.constraint === tableName + '_pkey' ? '_id_'
      : ['identifier_unique', tableName + '_identifier_unique'].includes(error.constraint) ? 'identifier_unique' : null;
    if (!index) return error;
    const mapped = new Error('duplicate key error index: ' + index + ' ', { cause: error });
    mapped.code = 11000;
    mapped.keyPattern = index === '_id_' ? { _id: 1 } : { identifier: 1 };
    return mapped;
  }

  // fn(exempt). INC-U2: a statement a treatments fallback-key index refused
  // (treatment-key-index.js) is a write official/dev makes, having no such
  // index. It is run again with `exempt`, the set of classes refused so far:
  // an insert first marks the live row holding its key in each of those
  // classes exempt (UPDATE: the serving role has column INSERT on tenant_id,
  // id_kind and doc only), an update marks the rows it edits exempt. No
  // document changes; the rows stored are official/dev's.
  async function recoverable (fn, { map = true } = {}) {
    if (typeof connection.withSavepoint !== 'function') throw unsupported('connection without savepoints');
    const exempt = new Set();
    for (;;) {
      try { return await connection.withSavepoint(() => fn(exempt.size ? exempt : false)); } catch (error) {
        const cls = keyIndex.violatedClass(error, tableName);
        if (cls && !exempt.has(cls)) { exempt.add(cls); continue; }
        if (!map) throw error;
        const mapped = duplicate(error);
        // A statement refused as a duplicate changed no row: its savepoint is rolled back.
        if (marking && mapped.code === 11000) windowMark.touch();
        throw mapped;
      }
    }
  }

  // An update outside a savepoint gains one where a key index exists, so a
  // refused statement can be run again exempt (recoverable above). `keyed` is
  // read before the clock (keyedTable); errors other than the key indexes'
  // propagate as they did without the savepoint.
  const keyedTable = async () => tableName === 'treatments' && keyIndex.anyIndex(connection, parts.join('.'));
  async function keyedRecoverable (keyed, fn) {
    return keyed ? recoverable(fn, { map: false }) : fn(false);
  }
  const EXEMPT_SET = `, ${keyIndex.EXEMPT} = true`;
  // The live row of this tenant holding `doc`'s key in one class's index.
  async function exemptHolder (cls, doc) {
    const keys = alias => keyIndex.keyExpressions(cls).map(e => e.replace(/\(doc -> /g, `(${alias}.doc -> `)).join(', ');
    await connection.query(`UPDATE ${from} AS t SET ${keyIndex.EXEMPT} = true FROM (SELECT $1::jsonb AS doc) AS w` +
      ` WHERE t.tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid` +
      ` AND ${keyIndex.predicate(cls).replace(/\(doc -> /g, '(t.doc -> ').replace(/\bNOT key_exempt\b/, 'NOT t.' + keyIndex.EXEMPT)}` +
      ` AND ROW(${keys('t')}) IS NOT DISTINCT FROM ROW(${keys('w')})`, [JSON.stringify(doc)]);
  }

  async function insert (doc, exempt = false) {
    lateStamp.translateFields(doc);
    const { _id, rest } = document(doc);
    const id = _id === undefined ? new ObjectId() : _id;
    const row = encodeDocument({ ...rest, _id: id });
    if (exempt) for (const cls of exempt) await exemptHolder(cls, row.doc);
    const inserted = await connection.query(`INSERT INTO ${from} (tenant_id, id_kind, doc)` +
      " VALUES (NULLIF(current_setting('app.current_tenant_id', true), '')::uuid, $1, $2::jsonb)" + (wt ? ` RETURNING ${wt} AS window_time` : ''),
    [row.id_kind, JSON.stringify(row.doc)]);
    if (marking) noteRow(wt ? inserted.rows[0]?.window_time : null);
    return id;
  }

  function targets (ast, params, one) {
    const where = compileFilter(ast, params);
    const order = one ? compileSort({ identifier: -1, _id: -1 }, params) : null;
    const limit = params.add(RESOLVE_CAP + 1);
    const lockOrder = order ? order.orderBy : 'tenant_id, id_kind, "_id"';
    return `locked AS (SELECT tenant_id, id_kind, "_id", doc${timed ? ', ' + timed.column + ' AS window_time' : ''} FROM ${from} WHERE ${where}` +
      ` ORDER BY ${lockOrder} LIMIT ${limit} FOR UPDATE),` +
      ` targets AS (SELECT *, ${order ? `COALESCE(bool_or(${order.unsortable}) OVER (), false)` : 'false'} AS unsortable FROM locked` +
      (order ? ` ORDER BY ${order.orderBy} LIMIT 1` : '') + ')';
  }

  // The target read and write are one statement. Locks preserve fields from
  // concurrent updates; the equality includes the stored kind and tenant.
  const identity = 'e.tenant_id = t.tenant_id AND e.id_kind = t.id_kind AND e."_id" = t."_id"';

  async function update (ast, change, one, historyAllocator, exempt = false) {
    lateStamp.translateFields(change.values);
    const params = new Params();
    const selected = targets(ast, params, one);
    let next = `(t.doc - ${params.add(change.removed)}::text[]) || ${params.add(JSON.stringify(change.values))}::jsonb`;
    let source = 'targets';
    if (historyAllocator) {
      // A single DELETE can mark several typed identities. An exclusive
      // millisecond cursor must be able to reach each one at a page boundary.
      source = '(SELECT *, row_number() OVER (ORDER BY id_kind, "_id") - 1 AS stamp_offset FROM targets)';
      const first = params.add(change.values.srvModified);
      next = `(${next}) || jsonb_build_object('srvModified', ${first}::bigint + t.stamp_offset)`;
    }
    const cap = params.add(RESOLVE_CAP);
    const targetCount = '(SELECT count(*) FROM locked)';
    // Compare with the locked version, not e's potentially pre-wait snapshot.
    const result = await connection.query(`WITH ${selected}, changed AS (` +
      `UPDATE ${from} AS e SET doc = ${next}${exempt ? EXEMPT_SET : ''} FROM ${source} AS t WHERE ${identity} AND ${targetCount} <= ${cap} AND NOT t.unsortable` +
      ` AND t.doc IS DISTINCT FROM (${next}) RETURNING ${timed ? 't.window_time AS window_before, e.' + timed.column + ' AS window_after' : '1'})` +
      ' SELECT (SELECT count(*) FROM targets) AS matched, (SELECT count(*) FROM changed) AS modified,' +
      (timed ? ` ${lowestOf('changed', 'LEAST(window_before, window_after)')} AS window_lowest,` +
        ' (SELECT bool_or(window_before IS NULL OR window_after IS NULL) FROM changed) AS window_null,' : '') +
      ` ${targetCount} > ${cap} AS over_cap,` +
      ' (SELECT bool_or(unsortable) FROM targets) AS unsortable', params.values);
    if (result.rows[0].over_cap) throw unsupported('write target limit of ' + RESOLVE_CAP + ' exceeded');
    if (result.rows[0].unsortable) throw unsupported('identifier sort over an array or subdocument');
    const matchedCount = Number(result.rows[0].matched);
    noteSet(result.rows[0].modified, result.rows[0].window_lowest, result.rows[0].window_null);
    if (historyAllocator && matchedCount > 1) {
      // The tenant clock and these data rows commit together. The allocator
      // also refuses overflow here, rolling the whole mutation back.
      historyAllocator.next(change.values.srvModified + matchedCount - 1);
    }
    return { matchedCount, modifiedCount: Number(result.rows[0].modified), acknowledged: true };
  }

  async function remove (ast, one) {
    const params = new Params();
    const selected = targets(ast, params, one);
    const cap = params.add(RESOLVE_CAP);
    const targetCount = '(SELECT count(*) FROM locked)';
    const result = await connection.query(`WITH ${selected}, removed AS (DELETE FROM ${from} AS e` +
      ` USING targets AS t WHERE ${identity} AND ${targetCount} <= ${cap} AND NOT t.unsortable RETURNING ${timed ? 't.window_time AS window_before' : '1'})` +
      ' SELECT (SELECT count(*) FROM removed) AS deleted,' +
      (timed ? ` ${lowestOf('removed', 'window_before')} AS window_lowest, (SELECT bool_or(window_before IS NULL) FROM removed) AS window_null,` : '') +
      ` ${targetCount} > ${cap} AS over_cap,` +
      ' (SELECT bool_or(unsortable) FROM targets) AS unsortable', params.values);
    if (result.rows[0].over_cap) throw unsupported('write target limit of ' + RESOLVE_CAP + ' exceeded');
    if (result.rows[0].unsortable) throw unsupported('identifier sort over an array or subdocument');
    noteSet(result.rows[0].deleted, result.rows[0].window_lowest, result.rows[0].window_null);
    return Number(result.rows[0].deleted);
  }

  function byIdentifier (identifier, storedId) {
    if (typeof identifier !== 'string') throw unsupported('non-string identifier');
    if (storedId !== undefined) {
      encodeDocument({ _id: storedId });
      return fromMongo({ _id: storedId });
    }
    return fromMongo(utils.filterForOne(identifier));
  }

  function requiredFilter (ast) {
    if (ast === undefined || ast === null) throw new TypeError('$: filter node must be an object');
    return ast;
  }

  function checkedFilter (ast) {
    compileFilter(requiredFilter(ast), new Params());
    return ast;
  }

  function everyForm (identifier, resolved) {
    if (typeof identifier !== 'string') throw unsupported('non-string identifier');
    const ids = idForms.isHexId(identifier) ? idForms.idForms(identifier) : [identifier];
    const ast = or(cmp('eq', 'identifier', identifier), and(cmp('in', '_id', ids),
      cmp('in', 'identifier', [null, '', 0, false]), cmp('nottype', 'identifier', 'array')));
    if (resolved === undefined || resolved === null) return ast;
    if (!Array.isArray(resolved)) throw unsupported('resolved identities');
    return and(ast, cmp('in', '_id', resolved));
  }

  async function selected (ast, limit, sorted = true) {
    const params = new Params();
    const where = compileFilter(ast, params);
    const order = sorted ? compileSort({ identifier: -1, _id: -1 }, params) : null;
    const result = await connection.query('SELECT id_kind, doc' +
      (order ? `, bool_or(${order.unsortable}) OVER () AS unsortable` : '') +
      ` FROM ${from} WHERE ${where}` + (order ? ` ORDER BY ${order.orderBy}` : '') +
      (limit ? ` LIMIT ${params.add(limit)}` : ''), params.values);
    if (result.rows.some(row => row.unsortable)) throw unsupported('identifier sort over an array or subdocument');
    lateStamp.recordRead(from, ast, result.rows);
    return result.rows.map(decodeDocument);
  }

  function equalitySeed (ast, replacement = false) {
    const entries = [];
    const seen = new Set();
    function visit (node) {
      if (node.op === 'and') return node.nodes.forEach(visit);
      if (replacement && (node.op !== 'eq' || node.field !== '_id')) return;
      if (node.op !== 'eq') throw unsupported('upsert insertion requires conjunctive equality filter');
      if (seen.has(node.field)) throw unsupported('repeated upsert equality field');
      seen.add(node.field);
      entries.push([node.field, node.value]);
    }
    visit(ast);
    const seed = Object.fromEntries(entries);
    document(seed);
    return seed;
  }

  function sameId (left, right) {
    const a = encodeDocument({ _id: left }), b = encodeDocument({ _id: right });
    return a.id_kind === b.id_kind && a.doc._id === b.doc._id;
  }

  async function replace (ast, doc, upsert, exempt = false) {
    lateStamp.translateFields(doc);
    const incoming = document(doc);
    const params = new Params();
    const where = compileFilter(ast, params);
    // Lock before choosing/replacing so omitted fields really disappear and
    // the stored identity cannot be changed by a replacement.
    const found = await connection.query(`SELECT id_kind, doc${wt ? ', ' + wt + ' AS window_time' : ''} FROM ${from} WHERE ${where}` +
      ' ORDER BY id_kind, "_id" LIMIT 2 FOR UPDATE', params.values);
    if (found.rows.length > 1) throw unsupported('ambiguous replacement filter');
    const rows = found.rows.map(decodeDocument);
    const stored = rows[0];
    if (!stored) {
      if (!upsert) return { matchedCount: 0, modifiedCount: 0, acknowledged: true };
      const seed = equalitySeed(ast, true);
      if (seed._id !== undefined && incoming._id !== undefined && !sameId(seed._id, incoming._id)) {
        throw unsupported('replacement changes upsert _id');
      }
      const id = await insert({ ...doc, _id: incoming._id === undefined ? seed._id : incoming._id }, exempt);
      return { matchedCount: 0, modifiedCount: 0, acknowledged: true, upsertedCount: 1, upsertedId: id };
    }
    if (incoming._id !== undefined && !sameId(incoming._id, stored._id)) throw unsupported('replacement changes stored _id');
    const row = encodeDocument({ ...doc, _id: stored._id });
    const reply = await connection.query(`UPDATE ${from} SET doc = $1::jsonb${exempt ? EXEMPT_SET : ''} WHERE id_kind = $2 AND "_id" = $3` +
      ' AND doc IS DISTINCT FROM $1::jsonb' + (wt ? ` RETURNING ${wt} AS window_time` : ''), [JSON.stringify(row.doc), row.id_kind, String(stored._id)]);
    if (marking && !reply.rowCount) windowMark.touch();
    else if (marking) { noteRow(wt ? found.rows[0].window_time : null); noteRow(wt ? reply.rows[0]?.window_time : null); }
    return { matchedCount: 1, modifiedCount: reply.rowCount, acknowledged: true, upsertedCount: 0, upsertedId: null };
  }

  // NS_CLOCK_LATE_STAMP (late-stamp.js). Before the clock row is held, a batch
  // that only inserts new rows is inserted by one statement under the clock.
  // Only when the batch's own filters, _ids and identifiers name no stored row
  // (read before the clock, validated under it) and no earlier row of the same
  // batch: exactly when the per-operation path would insert every row and
  // match none. Anything else takes the clock and runs the per-operation path.
  async function storedAny (asts) {
    let any = false;
    for (let start = 0; start < asts.length && !any; start += LATE_FILTERS_PER_READ) {
      const chunk = asts.slice(start, start + LATE_FILTERS_PER_READ);
      const params = new Params();
      const where = compileFilter(chunk.length === 1 ? chunk[0] : or(...chunk), params);
      const result = await connection.query(`SELECT id_kind, doc FROM ${from} WHERE ${where} LIMIT 1`, params.values);
      chunk.forEach(ast => lateStamp.recordRead(from, ast, result.rows));
      any = result.rows.length > 0;
    }
    return any;
  }

  function uniqueKeys (rows, asts) {
    const ids = new Set(), identifiers = new Set(), explicit = [], named = [];
    for (const row of rows) {
      const key = row.id_kind + ':' + row.doc._id;
      if (ids.has(key)) return false;
      ids.add(key);
      if (row.explicit !== undefined) explicit.push(row.explicit);
      const identifier = row.doc.identifier;
      if (typeof identifier === 'string' && identifier !== '') {
        if (identifiers.has(identifier)) return false;
        identifiers.add(identifier);
        named.push(identifier);
      }
    }
    if (explicit.length) asts.push(cmp('in', '_id', explicit));
    if (named.length) asts.push(cmp('in', 'identifier', named));
    return true;
  }

  async function insertSet (rows) {
    const returned = timed ? timed.column : '1';
    rows.forEach(row => lateStamp.translateFields(row.doc));
    const payload = JSON.stringify(rows.map(row => ({ k: row.id_kind, d: row.doc })));
    let result;
    try {
      result = await connection.query(`WITH inserted AS (INSERT INTO ${from} (tenant_id, id_kind, doc)` +
        " SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid, x.e->>'k', x.e->'d'" +
        ` FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS x(e, ord) ORDER BY x.ord RETURNING ${returned} AS w)` +
        ' SELECT count(*) AS n, min(w)::text AS lowest, bool_or(w IS NULL) AS any_null FROM inserted', [payload]);
    } catch (error) { throw duplicate(error); }
    if (Number(result.rows[0].n) !== rows.length) throw new Error('Late-stamp insert wrote ' + result.rows[0].n + ' of ' + rows.length + ' rows');
    noteSet(result.rows[0].n, result.rows[0].lowest, result.rows[0].any_null);
  }

  // Under the clock: insert set-based unless a concurrent commit overlapped.
  async function lateInsert (rows) {
    // INC-U: where a fallback-key index exists, a row may be refused by it
    // (a new _id onto a stored key) though no filter named that row: the
    // insert runs under a savepoint and the per-operation path decides (and
    // stores that row exempt, INC-U2).
    const keyed = tableName === 'treatments' && await keyIndex.anyIndex(connection, parts.join('.'));
    if (await lateStamp.lock()) return false;
    const payload = rows.map(({ id_kind, doc }) => ({ id_kind, doc }));
    if (!keyed) {
      await insertSet(payload);
      return true;
    }
    try {
      await connection.withSavepoint(() => insertSet(payload));
    } catch (error) {
      if (keyIndex.violatedClass(error, tableName)) return false;
      throw error;
    }
    return true;
  }

  async function deferBulk (batch) {
    if (!lateStamp.unlocked() || !batch.ops.length || batch.ops.some(op => !op.remove && op.merge)) return null;
    const { matcher } = require('./projection-memory-read');
    const rows = [], asts = [];
    const reply = { upsertedIds: {}, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    for (let index = 0; index < batch.ops.length; index++) {
      const op = batch.ops[index];
      const ast = op.remove || op.ast;
      let match;
      try { match = matcher(ast); } catch { return null; }
      if (rows.some(row => match(row))) return null;
      asts.push(ast);
      if (op.remove) continue;
      const incoming = document(op.doc);
      let seed;
      try { seed = equalitySeed(op.ast, true); } catch { return null; }
      if (seed._id !== undefined && incoming._id !== undefined && !sameId(seed._id, incoming._id)) return null;
      const chosen = incoming._id === undefined ? seed._id : incoming._id;
      const id = chosen === undefined ? new ObjectId() : chosen;
      rows.push(Object.assign(encodeDocument({ ...incoming.rest, _id: id }), { explicit: chosen }));
      reply.upsertedIds[index] = id;
      reply.upsertedCount++;
    }
    if (!uniqueKeys(rows, asts) || await storedAny(asts) || !await lateInsert(rows)) return null;
    return reply;
  }

  async function deferMany (docs) {
    if (!lateStamp.unlocked() || !docs.length) return null;
    const ids = [];
    const rows = docs.map(doc => {
      const { _id, rest } = document(doc);
      const id = _id === undefined ? new ObjectId() : _id;
      ids.push(id);
      return Object.assign(encodeDocument({ ...rest, _id: id }), { explicit: _id });
    });
    const asts = [];
    if (!uniqueKeys(rows, asts) || (asts.length && await storedAny(asts)) || !await lateInsert(rows)) return null;
    const result = { inserted: 0, insertedIds: {} };
    ids.forEach((id, index) => { docs[index]._id = id; result.insertedIds[index] = id; result.inserted++; });
    return result;
  }

  // INC-U, NS_TREATMENT_KEY_UPSERT (off by default) with NS_CLOCK_LATE_STAMP:
  // a v1 treatment batch that re-sends stored records is written set-based,
  // one INSERT ... ON CONFLICT per run of one key class in batch order (at
  // most six), under the clock. The reads below are validated under the clock
  // as INC-G's are (INC-U2: a row committed since that a filter reaches but no
  // index holds, an exempt or array-keyed row, would make the statement's
  // decision differ from the per-operation path's); an overlap declines to the
  // per-operation path. Taken only when each operation's filter is a
  // fallback key of one class whose index is present (or an _id, whose
  // arbiter is the primary key), and the reads before the clock show the
  // per-operation path would reach, for every operation, at most the one
  // stored row its own index key names, and no row of the batch reaches
  // another. Anything else returns null (INC-G's path, then the per-operation
  // path).
  const UNINDEXABLE = ['created_at', 'eventType', 'carbs', 'insulin', ...keyIndex.CLIENT_IDS];
  async function deferKeyed (batch) {
    if (tableName !== 'treatments' || !lateStamp.unlocked() || !batch.ops.length || !keyIndex.enabled()) return null;
    const present = await keyIndex.presentClasses(connection, parts.join('.'));
    if (!present.size) return null;
    const planned = [], removes = [], owners = new Map();
    const own = (key, index) => { if (owners.has(key)) return false; owners.set(key, index); return true; };
    for (let index = 0; index < batch.ops.length; index++) {
      const op = batch.ops[index];
      if (op.remove) { removes.push(op.remove); continue; }
      if (op.merge) return null;
      const incoming = document(op.doc);
      const rest = incoming.rest;
      if (UNINDEXABLE.some(field => rest[field] !== null && typeof rest[field] === 'object')) return null;
      let entry;
      if (op.ast.op === 'eq' && op.ast.field === '_id') {
        if (incoming._id !== undefined && !sameId(incoming._id, op.ast.value)) return null;
        const row = encodeDocument({ ...rest, _id: op.ast.value });
        entry = { index, cls: '_id', row, key: row.id_kind + ':' + row.doc._id };
      } else {
        const c = keyIndex.classOfFilter(op.ast);
        if (!c || !present.has(c.cls) || incoming._id !== undefined) return null;
        if (!keyIndex.inClass(c.cls, rest) || keyIndex.keyOf(c.cls, rest) !== keyIndex.keyOf(c.cls, c.values)) return null;
        entry = { index, cls: c.cls, row: encodeDocument({ ...rest, _id: new ObjectId() }), key: c.cls + ':' + keyIndex.keyOf(c.cls, rest) };
      }
      if (!own(entry.key, index)) return null;
      planned.push(entry);
    }
    // No row of the batch may reach another operation's target: each row's
    // memberships in every class index are its own operation's or no one's.
    for (const entry of planned) {
      for (const cls of keyIndex.CLASSES) {
        if (cls === entry.cls || !keyIndex.inClass(cls, entry.row.doc)) continue;
        if (owners.has(cls + ':' + keyIndex.keyOf(cls, entry.row.doc))) return null;
      }
    }
    if (runsOf(planned).length > MAX_KEYED_RUNS) return null;
    // Reads before the clock: every stored row an operation's filter reaches
    // must be the one its arbiter names; a twin to remove declines.
    if (removes.length && await storedAny(removes)) return null;
    const { matcher } = require('./projection-memory-read');
    const reached = new Set(), held = new Set(), byTime = new Map(), byId = new Map();
    for (const entry of planned) {
      const bucket = entry.cls === '_id' ? byId : byTime;
      const key = entry.cls === '_id' ? entry.key : JSON.stringify(entry.row.doc.created_at);
      if (!bucket.has(key)) bucket.set(key, []);
      bucket.get(key).push(entry);
    }
    for (let start = 0; start < planned.length; start += LATE_FILTERS_PER_READ) {
      const chunk = planned.slice(start, start + LATE_FILTERS_PER_READ);
      const params = new Params();
      const asts = chunk.map(entry => batch.ops[entry.index].ast);
      const result = await connection.query(`SELECT id_kind, doc, ${keyIndex.EXEMPT} AS exempt FROM ${from}` +
        ` WHERE ${compileFilter(asts.length === 1 ? asts[0] : or(...asts), params)}`, params.values);
      asts.forEach(ast => lateStamp.recordRead(from, ast, result.rows));
      for (const raw of result.rows) {
        const stored = raw.doc, storedKey = raw.id_kind + ':' + stored._id;
        // An exempt row (INC-U2) is reached by a filter but held by no index.
        if (raw.exempt) return null;
        // A stored time that is not a scalar can be reached by an element.
        if (stored.created_at !== null && typeof stored.created_at === 'object') return null;
        if (held.has(storedKey)) continue;
        held.add(storedKey);
        const candidates = (byTime.get(JSON.stringify(stored.created_at === undefined ? null : stored.created_at)) || [])
          .concat(byId.get(storedKey) || []);
        let reachers = 0;
        for (const entry of candidates) {
          let hit;
          try { hit = matcher(batch.ops[entry.index].ast)(raw); } catch { return null; }
          if (!hit) continue;
          const named = entry.cls === '_id' ? storedKey === entry.key
            : keyIndex.inClass(entry.cls, stored) && entry.cls + ':' + keyIndex.keyOf(entry.cls, stored) === entry.key;
          if (!named || reached.has(entry.index) || ++reachers > 1) return null;
          reached.add(entry.index);
        }
      }
    }
    if (await lateStamp.lock()) return null;
    let written;
    try {
      written = await connection.withSavepoint(() => upsertSet(planned));
    } catch (error) {
      if (error.code !== '23505' && error.code !== '42P10') throw error;
      // Another unique index refused a row, or the arbiter index is gone: the
      // per-operation path (under the clock now held) decides each row.
      if (error.code === '42P10') keyIndex.forget();
      return null;
    }
    const reply = { upsertedIds: {}, matchedIds: {}, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    planned.forEach(entry => {
      const outcome = written.get(entry);
      if (outcome.matched) {
        reply.matchedIds[entry.index] = outcome.id;
        reply.matchedCount++;
        reply.modifiedCount++;
      } else {
        reply.upsertedIds[entry.index] = outcome.id;
        reply.upsertedCount++;
      }
    });
    return reply;
  }

  // The batch in order as runs of one class: each run is one statement, so
  // new rows take insertion ordinals in batch order, as the per-operation path
  // gives them. More runs than MAX_KEYED_RUNS declines (a fixed bound).
  const MAX_KEYED_RUNS = 6;
  function runsOf (planned) {
    const runs = [];
    for (const entry of planned) {
      if (runs.length && runs[runs.length - 1].cls === entry.cls) runs[runs.length - 1].rows.push(entry);
      else runs.push({ cls: entry.cls, rows: [entry] });
    }
    return runs;
  }

  // Under the clock: one statement per run, each row's outcome by its key.
  async function upsertSet (planned) {
    const out = new Map();
    let count = 0, lowest = null, anyNull = false;
    for (const { cls, rows } of runsOf(planned)) {
      rows.forEach(entry => lateStamp.translateFields(entry.row.doc));
      const payload = JSON.stringify(rows.map(entry => ({ k: entry.row.id_kind, d: entry.row.doc })));
      const target = cls === '_id' ? '(tenant_id, id_kind, "_id")' : keyIndex.conflictTarget(cls);
      const keySql = cls === '_id' ? 'NULL::jsonb' : 'jsonb_build_array(' + keyIndex.keyFields(cls).map(f => `t.doc -> '${f}'`).join(', ') + ')';
      const result = await connection.query(`INSERT INTO ${from} AS t (tenant_id, id_kind, doc)` +
        " SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid, x.e->>'k', x.e->'d'" +
        ' FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS x(e, ord) ORDER BY x.ord' +
        ` ON CONFLICT ${target} DO UPDATE SET doc = jsonb_set(EXCLUDED.doc, '{_id}', t.doc -> '_id')` +
        ` RETURNING (t.xmax <> 0) AS matched, t.id_kind, t."_id", ${keySql} AS key` + (wt ? `, t.${timed.column}::text AS window_time` : ''), [payload]);
      if (result.rows.length !== rows.length) throw new Error('Keyed upsert wrote ' + result.rows.length + ' of ' + rows.length + ' rows');
      const byKey = new Map(rows.map(entry => [entry.key, entry]));
      for (const row of result.rows) {
        const key = cls === '_id' ? row.id_kind + ':' + row._id
          : cls + ':' + JSON.stringify(row.key.map(value => value === undefined ? null : value));
        const entry = byKey.get(key);
        if (!entry || out.has(entry)) throw new Error('Keyed upsert returned an unexpected key');
        out.set(entry, { matched: row.matched, id: decodeDocument({ id_kind: row.id_kind, doc: { _id: row._id } })._id });
        count++;
        // A matched _id row may have moved in time; its earlier time is unknown here.
        if (wt && !(cls === '_id' && row.matched) && typeof row.window_time === 'string') {
          if (lowest === null || windowMark.compareC(row.window_time, lowest) < 0) lowest = row.window_time;
        } else anyNull = true;
      }
    }
    noteSet(count, lowest, anyNull);
    return out;
  }

  function prepareBulk (ops, opts) {
    const o = options(opts, ['mode', 'ordered']);
    const mode = o.mode || 'replace';
    if (mode !== 'replace' && mode !== 'merge') throw unsupported('bulk mode ' + mode);
    if (!Array.isArray(ops)) throw unsupported('bulk operations');
    return { ordered: o.ordered !== false, ops: ops.map(op => {
      if (!op || Object.getPrototypeOf(op) !== Object.prototype) throw unsupported('bulk operation');
      const allowed = op.remove ? ['remove'] : ['filter', 'doc', 'setOnInsert', 'unset', 'merge'];
      if (Object.keys(op).some(key => !allowed.includes(key))) throw unsupported('bulk operation fields');
      const ast = checkedFilter(op.remove || op.filter);
      if (op.remove) return { remove: ast };
      const { _id, rest } = document(op.doc);
      const merge = mode === 'merge' || op.merge === true;
      if (op.merge !== undefined && typeof op.merge !== 'boolean') throw unsupported('merge flag');
      if (!merge && (op.setOnInsert || op.unset)) throw unsupported('replacement insert/unset fields');
      const onInsert = op.setOnInsert === undefined ? {} : op.setOnInsert;
      document(onInsert);
      if (merge && _id !== undefined) throw unsupported('merge _id outside setOnInsert');
      const patch = changes(rest, op.unset);
      if (Object.keys(onInsert).some(key => Object.hasOwn(rest, key) || patch.removed.includes(key))) {
        throw unsupported('conflicting setOnInsert field');
      }
      return { ast, doc: op.doc, patch, onInsert, merge };
    }) };
  }

  return {
    validateDocument: document,
    validatePatch: doc => fields(doc, 'patch'),

    async insertOne (doc, opts) {
      const o = options(opts, ['normalize']);
      document(doc);
      await lateStamp.lock();
      const id = await recoverable(exempt => insert(doc, exempt));
      if (o.normalize !== false) delete doc._id;
      else doc._id = id;
      return doc.identifier || id.toString();
    }

    , async insertMany (docs, opts) {
      const o = options(opts, ['ordered']);
      if (!Array.isArray(docs)) throw unsupported('insert documents');
      docs.forEach(document);
      const late = await deferMany(docs);
      if (late) return late;
      await lateStamp.lock();
      const result = { inserted: 0, insertedIds: {} };
      const writeErrors = [];
      for (let index = 0; index < docs.length; index++) {
        try {
          const id = await recoverable(exempt => insert(docs[index], exempt));
          docs[index]._id = id;
          result.insertedIds[index] = id;
          result.inserted++;
        } catch (error) {
          if (error.code !== 11000) throw error;
          writeErrors.push({ index, code: error.code, errmsg: error.message, keyPattern: error.keyPattern });
          if (o.ordered !== false) break;
        }
      }
      if (writeErrors.length) {
        const error = new Error('PostgreSQL collection insert batch failed');
        Object.assign(error, { code: 11000, writeErrors, result: { ...result, insertedCount: result.inserted } });
        throw error;
      }
      return result;
    }

    , async updateOne (identifier, setFields, unsetFields, storedId) {
      const keyed = await keyedTable();
      await lateStamp.lock();
      const ast = byIdentifier(identifier, storedId), patch = changes(setFields, unsetFields);
      const result = await keyedRecoverable(keyed, exempt => update(ast, patch, storedId === undefined, undefined, exempt));
      return { updated: result.modifiedCount };
    }

    , async deleteOne (identifier) {
      await lateStamp.lock();
      return { deleted: await remove(byIdentifier(identifier), true) };
    }

    , async updateMany (ast, change, opts) {
      options(opts, ['v1', 'one']);
      if (!change || Object.keys(change).some(key => key !== 'set' && key !== 'unset')) throw unsupported('changes');
      const patch = changes(change.set === undefined || change.set === null ? {} : change.set, change.unset);
      if (!Object.keys(patch.values).length && !patch.removed.length) throw new TypeError('updateMany requires a non-empty set or unset');
      const keyed = await keyedTable();
      await lateStamp.lock();
      return keyedRecoverable(keyed, exempt => update(requiredFilter(ast), patch, false, undefined, exempt));
    }

    , async deleteMany (ast, opts) {
      options(opts, ['v1', 'one']);
      await lateStamp.lock();
      const deleted = await remove(requiredFilter(ast), false);
      return { acknowledged: true, deletedCount: deleted, deleted };
    }

    , async replaceOne (identifier, doc, storedId) {
      document(doc);
      const ast = byIdentifier(identifier, storedId);
      await lateStamp.lock();
      // Identifier fallback is a disjunction, not an insertion seed.
      return recoverable(async function (exempt) {
        const found = await selected(ast, 1);
        const filter = found.length ? fromMongo({ _id: found[0]._id })
          : fromMongo({ _id: storedId === undefined ? (doc._id === undefined ? new ObjectId() : doc._id) : storedId });
        return (await replace(filter, doc, true, exempt)).matchedCount;
      });
    }

    , async replaceFiltered (ast, doc, opts) {
      const o = options(opts, ['upsert']);
      checkedFilter(ast);
      document(doc);
      await lateStamp.lock();
      const reply = await recoverable(exempt => replace(ast, doc, !!o.upsert, exempt));
      if (!o.upsert) { delete reply.upsertedCount; delete reply.upsertedId; }
      return reply;
    }

    , async bulkUpsert (ops, opts) {
      const batch = prepareBulk(ops, opts);
      const keyed = await deferKeyed(batch);
      if (keyed) return keyed;
      const late = await deferBulk(batch);
      if (late) return late;
      await lateStamp.lock();
      const reply = { upsertedIds: {}, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      const errors = [];
      for (let index = 0; index < batch.ops.length; index++) {
        const op = batch.ops[index];
        try {
          const result = await recoverable(async function (exempt) {
            if (op.remove) { await remove(op.remove, false); return {}; }
            if (!op.merge) return replace(op.ast, op.doc, true, exempt);
            const updated = await update(op.ast, op.patch, false, undefined, exempt);
            if (updated.matchedCount > 1) throw unsupported('ambiguous merge upsert filter');
            if (updated.matchedCount) return updated;
            const seed = equalitySeed(op.ast);
            if (seed._id !== undefined && op.onInsert._id !== undefined && !sameId(seed._id, op.onInsert._id)) {
              throw unsupported('merge changes upsert _id');
            }
            const doc = { ...seed, ...op.onInsert, ...op.doc };
            op.patch.removed.forEach(key => { delete doc[key]; });
            return { upsertedCount: 1, upsertedId: await insert(doc, exempt) };
          });
          for (const key of ['matchedCount', 'modifiedCount', 'upsertedCount']) reply[key] += result[key] || 0;
          if (result.upsertedCount) reply.upsertedIds[index] = result.upsertedId;
        } catch (error) {
          if (error.code !== 11000) throw error;
          errors.push({ index, code: error.code, errmsg: error.message, keyPattern: error.keyPattern });
          if (batch.ordered) break;
        }
      }
      if (errors.length) {
        const error = new Error('PostgreSQL entries bulk write failed');
        error.code = 11000;
        error.writeErrors = errors;
        error.result = reply;
        throw error;
      }
      return reply;
    }

    , async updateEveryForm (identifier, setFields, resolved) {
      const patch = changes(setFields);
      const mayMarkMany = setFields.isValid === false && Number.isSafeInteger(setFields.srvModified) &&
        (!Array.isArray(resolved) || resolved.length > 1);
      const keyed = await keyedTable();
      await lateStamp.lock();
      const allocator = mayMarkMany && srvDates.allocationContext();
      const ast = everyForm(identifier, resolved);
      return { updated: (await keyedRecoverable(keyed, exempt => update(ast, patch, false, allocator, exempt))).modifiedCount };
    }

    , async deleteEveryForm (identifier, resolved) {
      await lateStamp.lock();
      return { deleted: await remove(everyForm(identifier, resolved), false) };
    }

    , async resolveOne (identifier) {
      return (await selected(byIdentifier(identifier), 1)).map(doc => doc._id);
    }

    , async resolveEveryForm (identifier, cap) {
      if (!Number.isInteger(cap) || cap < 1) throw new TypeError('resolve needs a positive cap');
      if (cap > RESOLVE_CAP) throw unsupported('resolved identity limit of ' + RESOLVE_CAP + ' exceeded');
      const docs = await selected(everyForm(identifier), cap + 1, false);
      return docs.length > cap ? null : docs.map(doc => doc._id);
    }

    , async findByIds (ids) {
      if (Array.isArray(ids) && ids.length > RESOLVE_CAP) {
        throw unsupported('resolved identity limit of ' + RESOLVE_CAP + ' exceeded');
      }
      const docs = await selected(cmp('in', '_id', ids), RESOLVE_CAP + 1, false);
      if (docs.length > RESOLVE_CAP) throw unsupported('resolved identity limit of ' + RESOLVE_CAP + ' exceeded');
      return docs;
    }

    , async resolveOr (filterDef, cap) {
      if (!Number.isInteger(cap) || cap < 1) throw new TypeError('resolve needs a positive cap');
      if (cap > RESOLVE_CAP) throw unsupported('resolved identity limit of ' + RESOLVE_CAP + ' exceeded');
      const docs = await selected(fromMongo(utils.parseFilter(filterDef, 'or')), cap + 1, false);
      return docs.length > cap ? null : docs.map(doc => doc._id);
    }

    , async deleteManyOr (filterDef, resolved) {
      const ast = fromMongo(utils.parseFilter(filterDef, 'or'));
      await lateStamp.lock();
      return { deleted: await remove(Array.isArray(resolved) ? and(ast, cmp('in', '_id', resolved)) : ast, false) };
    }
  };
};
