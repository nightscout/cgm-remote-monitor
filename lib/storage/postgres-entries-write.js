'use strict';

// Dormant persistence slice, not a registered backend or write-intent adapter.
// No schema/index creation, duplicate retry, validation policy or commit events.
// Inserts/sets accept only top-level JSON scalars; BSON coercion is refused.
const { ObjectId } = require('mongodb');
const { encodeDocument } = require('./postgres-identity');
const { fromMongo } = require('./filter');
const { compileFilter, compileSort, Params } = require('./postgres-filter');
const utils = require('../api3/storage/mongoCollection/utils');

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

  return {
    async insertOne (doc, opts) {
      const o = options(opts, ['normalize']);
      if (!doc || Object.getPrototypeOf(doc) !== Object.prototype
        || Reflect.ownKeys(doc).length !== Object.keys(doc).length) throw unsupported('document');
      const { _id, ...rest } = doc;
      fields(rest, 'document');
      const id = _id === undefined ? new ObjectId() : _id;
      const row = encodeDocument({ ...rest, _id: id });
      await connection.query(`INSERT INTO ${from} (tenant_id, id_kind, doc)` +
        " VALUES (NULLIF(current_setting('app.current_tenant_id', true), '')::uuid, $1, $2::jsonb)",
      [row.id_kind, JSON.stringify(row.doc)]);
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
  };
};
