'use strict';

// Dormant persistence slice, not a registered backend or write-intent adapter.
// No schema/index creation, validation policy or commit events.
// Inserts/sets accept only top-level JSON scalars; BSON coercion is refused.
const { ObjectId } = require('mongodb');
const { encodeDocument, decodeDocument } = require('./postgres-identity');
const { fromMongo, and, or, cmp } = require('./filter');
const { compileFilter, compileSort, Params } = require('./postgres-filter');
const utils = require('../api3/storage/mongoCollection/utils');
const idForms = require('../server/object-id-forms');

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TABLE = /^[a-z_][a-z0-9_]*$/;

function unsupported (message) {
  const error = new TypeError('PostgreSQL entries write: unsupported ' + message);
  error.unsupported = true;
  return error;
}

function fields (value, label, scalarValues = true) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== Object.keys(value).length) {
    throw unsupported(label + ' must be a plain field map');
  }
  for (const [key, item] of Object.entries(value)) {
    if (!FIELD.test(key) || key === '_id') throw unsupported(label + ' field ' + key);
    if (scalarValues && item !== null && typeof item !== 'string' && typeof item !== 'boolean'
      && !(typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0))) {
      throw unsupported(label + ' value for ' + key);
    }
  }
  return value;
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

module.exports = function postgresEntriesWrite ({ connection, table = 'entries' } = {}) {
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
    fields(rest, 'document');
    if (_id !== undefined) encodeDocument({ _id });
    return { _id, rest };
  }

  function duplicate (error) {
    if (error.code !== '23505' || error.table !== tableName
      || (parts.length === 2 && error.schema !== parts[0])) return error;
    const index = error.constraint === tableName + '_pkey' ? '_id_'
      : error.constraint === 'identifier_unique' ? 'identifier_unique' : null;
    if (!index) return error;
    const mapped = new Error('duplicate key error index: ' + index + ' ', { cause: error });
    mapped.code = 11000;
    mapped.keyPattern = index === '_id_' ? { _id: 1 } : { identifier: 1 };
    return mapped;
  }

  async function recoverable (fn) {
    if (typeof connection.withSavepoint !== 'function') throw unsupported('connection without savepoints');
    try { return await connection.withSavepoint(fn); } catch (error) { throw duplicate(error); }
  }

  async function insert (doc) {
    const { _id, rest } = document(doc);
    const id = _id === undefined ? new ObjectId() : _id;
    const row = encodeDocument({ ...rest, _id: id });
    await connection.query(`INSERT INTO ${from} (tenant_id, id_kind, doc)` +
      " VALUES (NULLIF(current_setting('app.current_tenant_id', true), '')::uuid, $1, $2::jsonb)",
    [row.id_kind, JSON.stringify(row.doc)]);
    return id;
  }

  function targets (ast, params, one) {
    const where = compileFilter(ast, params);
    const order = one ? compileSort({ identifier: -1, _id: -1 }, params) : null;
    return `locked AS (SELECT tenant_id, id_kind, "_id", doc FROM ${from} WHERE ${where} FOR UPDATE),` +
      ` targets AS (SELECT *, ${order ? `COALESCE(bool_or(${order.unsortable}) OVER (), false)` : 'false'} AS unsortable FROM locked` +
      (order ? ` ORDER BY ${order.orderBy} LIMIT 1` : '') + ')';
  }

  // The target read and write are one statement. Locks preserve fields from
  // concurrent updates; the equality includes the stored kind and tenant.
  const identity = 'e.tenant_id = t.tenant_id AND e.id_kind = t.id_kind AND e."_id" = t."_id"';

  async function update (ast, change, one) {
    const params = new Params();
    const selected = targets(ast, params, one);
    const next = `(t.doc - ${params.add(change.removed)}::text[]) || ${params.add(JSON.stringify(change.values))}::jsonb`;
    // Compare with the locked version, not e's potentially pre-wait snapshot.
    const result = await connection.query(`WITH ${selected}, changed AS (` +
      `UPDATE ${from} AS e SET doc = ${next} FROM targets AS t WHERE ${identity} AND NOT t.unsortable` +
      ` AND t.doc IS DISTINCT FROM (${next}) RETURNING 1)` +
      ' SELECT (SELECT count(*) FROM targets) AS matched, (SELECT count(*) FROM changed) AS modified,' +
      ' (SELECT bool_or(unsortable) FROM targets) AS unsortable', params.values);
    if (result.rows[0].unsortable) throw unsupported('identifier sort over an array or subdocument');
    return { matchedCount: Number(result.rows[0].matched), modifiedCount: Number(result.rows[0].modified), acknowledged: true };
  }

  async function remove (ast, one) {
    const params = new Params();
    const selected = targets(ast, params, one);
    const result = await connection.query(`WITH ${selected}, removed AS (DELETE FROM ${from} AS e` +
      ` USING targets AS t WHERE ${identity} AND NOT t.unsortable RETURNING 1)` +
      ' SELECT (SELECT count(*) FROM removed) AS deleted,' +
      ' (SELECT bool_or(unsortable) FROM targets) AS unsortable', params.values);
    if (result.rows[0].unsortable) throw unsupported('identifier sort over an array or subdocument');
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
    return result.rows.map(decodeDocument);
  }

  function equalitySeed (ast) {
    const entries = [];
    const seen = new Set();
    function visit (node) {
      if (node.op === 'and') return node.nodes.forEach(visit);
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

  async function replace (ast, doc, upsert, countModified = true) {
    const incoming = document(doc);
    const params = new Params();
    const where = compileFilter(ast, params);
    // Lock before choosing/replacing so omitted fields really disappear and
    // the stored identity cannot be changed by a replacement.
    const found = await connection.query(`SELECT id_kind, doc FROM ${from} WHERE ${where}` +
      ' ORDER BY id_kind, "_id" FOR UPDATE', params.values);
    if (found.rows.length > 1) throw unsupported('ambiguous replacement filter');
    const rows = found.rows.map(decodeDocument);
    const stored = rows[0];
    if (!stored) {
      if (!upsert) return { matchedCount: 0, modifiedCount: 0, acknowledged: true };
      const seed = equalitySeed(ast);
      if (seed._id !== undefined && incoming._id !== undefined && !sameId(seed._id, incoming._id)) {
        throw unsupported('replacement changes upsert _id');
      }
      const id = await insert({ ...doc, _id: incoming._id === undefined ? seed._id : incoming._id });
      return { matchedCount: 0, modifiedCount: 0, acknowledged: true, upsertedCount: 1, upsertedId: id };
    }
    if (incoming._id !== undefined && !sameId(incoming._id, stored._id)) throw unsupported('replacement changes stored _id');
    const row = encodeDocument({ ...doc, _id: stored._id });
    const reply = await connection.query(`UPDATE ${from} SET doc = $1::jsonb WHERE id_kind = $2 AND "_id" = $3` +
      ' AND doc IS DISTINCT FROM $1::jsonb', [JSON.stringify(row.doc), row.id_kind, String(stored._id)]);
    if (!reply.rowCount && countModified) throw unsupported('replacement no-op count requires BSON field-order metadata');
    return { matchedCount: 1, modifiedCount: reply.rowCount, acknowledged: true, upsertedCount: 0, upsertedId: null };
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
    async insertOne (doc, opts) {
      const o = options(opts, ['normalize']);
      document(doc);
      const id = await recoverable(() => insert(doc));
      if (o.normalize !== false) delete doc._id;
      else doc._id = id;
      return doc.identifier || id.toString();
    }

    , async updateOne (identifier, setFields, unsetFields, storedId) {
      const result = await update(byIdentifier(identifier, storedId), changes(setFields, unsetFields), storedId === undefined);
      return { updated: result.modifiedCount };
    }

    , async deleteOne (identifier) {
      return { deleted: await remove(byIdentifier(identifier), true) };
    }

    , async updateMany (ast, change, opts) {
      options(opts, ['v1', 'one']);
      if (!change || Object.keys(change).some(key => key !== 'set' && key !== 'unset')) throw unsupported('changes');
      const patch = changes(change.set === undefined || change.set === null ? {} : change.set, change.unset);
      if (!Object.keys(patch.values).length && !patch.removed.length) throw new TypeError('updateMany requires a non-empty set or unset');
      return update(requiredFilter(ast), patch, false);
    }

    , async deleteMany (ast, opts) {
      options(opts, ['v1', 'one']);
      const deleted = await remove(requiredFilter(ast), false);
      return { acknowledged: true, deletedCount: deleted, deleted };
    }

    , async replaceOne (identifier, doc, storedId) {
      document(doc);
      const ast = byIdentifier(identifier, storedId);
      // Identifier fallback is a disjunction, not an insertion seed.
      return recoverable(async function () {
        const found = await selected(ast, 1);
        const filter = found.length ? fromMongo({ _id: found[0]._id })
          : fromMongo({ _id: storedId === undefined ? (doc._id === undefined ? new ObjectId() : doc._id) : storedId });
        return (await replace(filter, doc, true, false)).matchedCount;
      });
    }

    , async replaceFiltered (ast, doc, opts) {
      const o = options(opts, ['upsert']);
      checkedFilter(ast);
      document(doc);
      const reply = await recoverable(() => replace(ast, doc, !!o.upsert));
      if (!o.upsert) { delete reply.upsertedCount; delete reply.upsertedId; }
      return reply;
    }

    , async bulkUpsert (ops, opts) {
      const batch = prepareBulk(ops, opts);
      const reply = { upsertedIds: {}, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      const errors = [];
      for (let index = 0; index < batch.ops.length; index++) {
        const op = batch.ops[index];
        try {
          const result = await recoverable(async function () {
            if (op.remove) { await remove(op.remove, false); return {}; }
            if (!op.merge) return replace(op.ast, op.doc, true);
            const updated = await update(op.ast, op.patch, false);
            if (updated.matchedCount > 1) throw unsupported('ambiguous merge upsert filter');
            if (updated.matchedCount) return updated;
            const seed = equalitySeed(op.ast);
            if (seed._id !== undefined && op.onInsert._id !== undefined && !sameId(seed._id, op.onInsert._id)) {
              throw unsupported('merge changes upsert _id');
            }
            const doc = { ...seed, ...op.onInsert, ...op.doc };
            op.patch.removed.forEach(key => { delete doc[key]; });
            return { upsertedCount: 1, upsertedId: await insert(doc) };
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
      return { updated: (await update(everyForm(identifier, resolved), changes(setFields), false)).modifiedCount };
    }

    , async deleteEveryForm (identifier, resolved) {
      return { deleted: await remove(everyForm(identifier, resolved), false) };
    }

    , async resolveOne (identifier) {
      return (await selected(byIdentifier(identifier), 1)).map(doc => doc._id);
    }

    , async resolveEveryForm (identifier, cap) {
      if (!Number.isInteger(cap) || cap < 1) throw new TypeError('resolve needs a positive cap');
      const docs = await selected(everyForm(identifier), cap + 1, false);
      return docs.length > cap ? null : docs.map(doc => doc._id);
    }

    , async findByIds (ids) {
      return selected(cmp('in', '_id', ids), undefined, false);
    }

    , async resolveOr (filterDef, cap) {
      if (!Number.isInteger(cap) || cap < 1) throw new TypeError('resolve needs a positive cap');
      const docs = await selected(fromMongo(utils.parseFilter(filterDef, 'or')), cap + 1, false);
      return docs.length > cap ? null : docs.map(doc => doc._id);
    }

    , async deleteManyOr (filterDef, resolved) {
      const ast = fromMongo(utils.parseFilter(filterDef, 'or'));
      return { deleted: await remove(Array.isArray(resolved) ? and(ast, cmp('in', '_id', resolved)) : ast, false) };
    }
  };
};
