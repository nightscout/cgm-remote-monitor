'use strict';

// In-process answers for the evaluator's projection reads (evaluator cost
// lane, candidate A): the reader interface of postgres-entries-read.js
// (findFiltered, findOne, count), over the retained projection rows instead
// of a jsonb_to_recordset round trip.
//
// The semantics are postgres-filter.js's, not MongoDB's: every query is first
// compiled by postgres-filter (compileFilter, compileSort, bound) and so
// refused exactly where the SQL path refuses it; the compiled text is then
// discarded and the same rules are evaluated here:
//
//   - top-level fields; a missing field is SQL NULL, a JSON null is 'null';
//   - eq/ne/in/nin/gt/gte/lt/lte compare only within one JSON type (CASE ...
//     ELSE false), numbers as numbers, strings in byte order (COLLATE "C":
//     code point order, compared below without UTF-16 surrogate order),
//     booleans false < true; a value or any element of an array value;
//   - eq/gte/lte null: missing, null, or an array holding null; gt/lt null:
//     false; empty in: false, empty nin: true; ne and nin are NOT of the rest;
//   - exists: the key is present; type: jsonb_typeof of the value or an
//     element; nottype 'array': not an array;
//   - re (legacy patterns only): the literal/time-helper subset, '.' not
//     matching a newline ('p' flag), '^' the start of the string;
//   - _id: compared with its kind (id_kind), never absent;
//   - sort: MongoDB's type rank, then the value; an array or subdocument
//     under a sort key among the matching rows refuses the read, as the SQL
//     path's window does. Every sorted read is in a total order: the keys,
//     then the per-tenant insertion ordinal (nulls last), then the typed
//     identity, the same terms the SQL path appends (postgres-projection-read
//     TIE_BREAK; decision view-reads-total-order).
//
// Rows are the documents as PostgreSQL returns them from jsonb: the JSON round
// trip of the stored document with every object's keys in jsonb order (shorter
// keys first, then by bytes). Each read returns its own deep copies.

const { decodeDocument } = require('./postgres-identity');
const { fromMongo, GROUP } = require('./filter');
const { compileFilter, compileSort, bound, Params, UnsupportedQueryError } = require('./postgres-filter');
const utils = require('../api3/storage/mongoCollection/utils');
const { jsonCopy, deepFreeze } = require('../data/json-copy');
// postgres-entries-read's projection handling, shared rather than restated.
const { projectDocument, refuseCommon } = require('./postgres-entries-read').internals;

const FIND_OPTIONS = new Set(['sort', 'limit', 'skip', 'projection', 'options', 'readOptions', 'v1']);
const ONE_ORDER = { identifier: -1, _id: -1 };
const TYPE_ALIAS = new Map([['string', 'string'], [2, 'string'], ['bool', 'boolean'], [8, 'boolean'],
  ['null', 'null'], [10, 'null'], ['number', 'number']]);
const RANK = { null: 1, number: 2, string: 3, object: 4, array: 5, objectid: 7, boolean: 8 };
const MISSING = Symbol('missing');

function unsupported (message) {
  return new UnsupportedQueryError(message);
}

// jsonb's key order: by byte length, then bytewise.
function jsonbKeyOrder (a, b) {
  const la = Buffer.byteLength(a), lb = Buffer.byteLength(b);
  if (la !== lb) return la - lb;
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function jsonbOrdered (value) {
  if (Array.isArray(value)) return value.map(jsonbOrdered);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort(jsonbKeyOrder)) {
    if (key === '__proto__') Object.defineProperty(out, key, { value: jsonbOrdered(value[key]), enumerable: true, writable: true, configurable: true });
    else out[key] = jsonbOrdered(value[key]);
  }
  return out;
}

// COLLATE "C": UTF-8 byte order, which is code point order.
function compareC (a, b) {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i), y = b.charCodeAt(i);
    if (x === y) continue;
    if (x < 0xD800 && y < 0xD800) return x - y;
    return a.codePointAt(i) - b.codePointAt(i);
  }
  return a.length - b.length;
}

function typeOf (v) {
  if (v === MISSING) return null;
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  return t === 'object' ? 'object' : t; // number, string, boolean
}

function isObjectId (v) {
  return !!v && typeof v === 'object' && v._bsontype === 'ObjectId' && typeof v.toHexString === 'function';
}

function compareOp (c, op) {
  switch (op) {
    case 'eq': return c === 0;
    case 'gt': return c > 0;
    case 'gte': return c >= 0;
    case 'lt': return c < 0;
    case 'lte': return c <= 0;
  }
  throw unsupported(`operator '${op}'`);
}

// A scalar comparison of one JSON value with an operand of the same type.
function scalar (e, op, value) {
  const t = typeOf(e);
  if (typeof value === 'number') return t === 'number' && compareOp(e < value ? -1 : e > value ? 1 : 0, op);
  if (typeof value === 'string') return t === 'string' && compareOp(compareC(e, value), op);
  return t === 'boolean' && compareOp(Number(e) - Number(value), op);
}

function elementwise (x, test) {
  return test(x) || (Array.isArray(x) && x.some(test));
}

// The grammar postgres-filter admits (literals, '.', '.*', escapes, a leading
// '^'), as a code-point ('u') RegExp: PostgreSQL's '.' is one character, and
// with the 'p' flag it never matches a newline.
function pattern (source) {
  let out = '', rest = source;
  if (rest.startsWith('^')) { out = '^'; rest = rest.slice(1); }
  while (rest.length) {
    if (/^[A-Za-z0-9_ :,-]/.test(rest)) { out += rest[0]; rest = rest.slice(1); } else if (rest[0] === '/') { out += '\\/'; rest = rest.slice(1); } else if (rest.startsWith('.*')) { out += '[^\\n]*'; rest = rest.slice(2); } else if (rest.startsWith('.')) { out += '[^\\n]'; rest = rest.slice(1); } else if (rest.startsWith('\\') && rest.length > 1) { out += rest[1] === '-' ? '-' : '\\' + rest[1]; rest = rest.slice(2); } else throw unsupported('regular expression outside the literal/time-helper subset');
  }
  return new RegExp(out, 'u');
}

function matcher (ast) {
  if (ast === null || ast === undefined) return () => true;
  return node(ast);

  function node (n) {
    if (GROUP.has(n.op)) {
      const children = n.nodes.map(node);
      if (!children.length) return () => true;
      return n.op === 'and' ? row => children.every(c => c(row)) : row => children.some(c => c(row));
    }
    return n.field === '_id' ? idLeaf(n) : leaf(n, n.field);
  }

  function value (row, field) {
    return Object.prototype.hasOwnProperty.call(row.doc, field) ? row.doc[field] : MISSING;
  }

  function equal (x, operand) {
    if (operand === null) return x === MISSING || elementwise(x, e => e === null);
    return x !== MISSING && elementwise(x, e => scalar(e, 'eq', operand));
  }

  function leaf (n, field) {
    const v = n.value;
    switch (n.op) {
      case 'eq': return row => equal(value(row, field), v);
      case 'ne': return row => !equal(value(row, field), v);
      case 'in': return row => { const x = value(row, field); return v.some(o => equal(x, o)); };
      case 'nin': return row => { const x = value(row, field); return !v.some(o => equal(x, o)); };
      case 'gt': case 'lt':
        if (v === null) return () => false;
        return row => { const x = value(row, field); return x !== MISSING && elementwise(x, e => scalar(e, n.op, v)); };
      case 'gte': case 'lte':
        if (v === null) return row => equal(value(row, field), null);
        return row => { const x = value(row, field); return x !== MISSING && elementwise(x, e => scalar(e, n.op, v)); };
      case 'exists': return row => (value(row, field) !== MISSING) === !!v;
      case 'type': {
        const t = TYPE_ALIAS.get(v);
        return row => { const x = value(row, field); return x !== MISSING && elementwise(x, e => typeOf(e) === t); };
      }
      case 'nottype': return row => !Array.isArray(value(row, field));
      case 're': {
        const re = pattern(v);
        return row => { const x = value(row, field); return x !== MISSING && elementwise(x, e => typeof e === 'string' && re.test(e)); };
      }
    }
    throw unsupported(`operator '${n.op}'`);
  }

  function idCompare (op, operand) {
    if (isObjectId(operand)) { const hex = operand.toHexString(); return row => row.id_kind === 'objectid' && compareOp(compareC(row.doc._id, hex), op); }
    if (typeof operand === 'string') return row => row.id_kind === 'string' && compareOp(compareC(row.doc._id, operand), op);
    return () => false;
  }

  function idLeaf (n) {
    switch (n.op) {
      case 'eq': return idCompare('eq', n.value);
      case 'ne': { const eq = idCompare('eq', n.value); return row => !eq(row); }
      case 'in': { const eqs = n.value.map(v => idCompare('eq', v)); return row => eqs.some(eq => eq(row)); }
      case 'nin': { const eqs = n.value.map(v => idCompare('eq', v)); return row => !eqs.some(eq => eq(row)); }
      case 'gt': case 'gte': case 'lt': case 'lte': return idCompare(n.op, n.value);
      case 'exists': return n.value ? () => true : () => false;
    }
    throw unsupported(`operator '${n.op}' on _id`);
  }
}

function sorter (sort) {
  if (sort === undefined || sort === null) return null;
  const keys = Object.keys(sort);
  if (!keys.length) return null;
  const terms = keys.map(field => ({ field, dir: sort[field] }));
  return {
    fields: keys.filter(field => field !== '_id'),
    compare (a, b) {
      for (const { field, dir } of terms) {
        let c;
        if (field === '_id') {
          c = (a.id_kind === 'string' ? RANK.string : RANK.objectid) - (b.id_kind === 'string' ? RANK.string : RANK.objectid) ||
            compareC(a.doc._id, b.doc._id);
        } else {
          const x = Object.prototype.hasOwnProperty.call(a.doc, field) ? a.doc[field] : MISSING;
          const y = Object.prototype.hasOwnProperty.call(b.doc, field) ? b.doc[field] : MISSING;
          const tx = typeOf(x) || 'null', ty = typeOf(y) || 'null';
          c = RANK[tx] - RANK[ty];
          if (!c && tx === ty) {
            if (tx === 'number') c = x < y ? -1 : x > y ? 1 : 0;
            else if (tx === 'string') c = compareC(x, y);
            else if (tx === 'boolean') c = Number(x) - Number(y);
          }
        }
        if (c) return dir === 1 ? c : -c;
      }
      // The total order's tie-break: ordinal ASC NULLS LAST, id_kind, _id (C).
      const oa = a.ordinal == null ? null : a.ordinal, ob = b.ordinal == null ? null : b.ordinal;
      if (oa !== ob) {
        if (oa === null) return 1;
        if (ob === null) return -1;
        return oa - ob;
      }
      return compareC(a.id_kind, b.id_kind) || compareC(a.doc._id, b.doc._id);
    }
  };
}

/**
 * The retained rows of one domain, in the form PostgreSQL returns them.
 * @param {Array<{id_kind, doc}>} encoded postgres-identity rows (plain JSON)
 * @returns {ReadonlyArray} frozen rows
 */
function rowsOf (encoded) {
  return deepFreeze(encoded.map(row => ({ id_kind: row.id_kind, doc: jsonbOrdered(row.doc), ordinal: row.ordinal == null ? null : row.ordinal })));
}

module.exports = function projectionMemoryRead ({ rows, legacyPatterns = false } = {}) {
  if (!Array.isArray(rows) || !Object.isFrozen(rows)) throw new TypeError('Projection memory read requires frozen retained rows');

  function select (ast, o) {
    // The SQL path's refusals, in its order (compile, then bounds).
    const params = new Params();
    compileFilter(ast, params, { legacyPatterns });
    const order = compileSort(o.sort, params);
    const limit = o.limit === undefined || o.limit === null ? 0 : bound('limit', o.limit);
    const skip = o.skip ? bound('skip', o.skip) : 0;
    if (!order && (limit || skip)) throw unsupported('limit or skip without a sort');
    const match = matcher(ast);
    let found = rows.filter(match);
    const sort = sorter(o.sort);
    // The SQL window flags an array or subdocument under a sort key among all
    // matching rows, and the read is refused when any row comes back.
    let unsortable = false;
    if (sort) {
      for (const row of found) {
        for (const field of sort.fields) {
          const t = typeOf(Object.prototype.hasOwnProperty.call(row.doc, field) ? row.doc[field] : MISSING);
          if (t === 'array' || t === 'object') unsortable = true;
        }
      }
      found = found.slice().sort(sort.compare);
    }
    if (skip) found = found.slice(skip);
    if (limit) found = found.slice(0, limit);
    if (found.length && unsortable) throw unsupported('sort over an array or subdocument value');
    const docs = found.map(row => projectDocument(decodeDocument({ id_kind: row.id_kind, doc: jsonCopy(row.doc) }), o.projection));
    if (!o.options || o.options.normalize !== false) docs.forEach(utils.normalizeDoc);
    return docs;
  }

  return {
    async findNatural () { throw unsupported('natural insertion order'); },
    async findFiltered (ast, opts) {
      const o = opts || { };
      for (const key of Object.keys(o)) {
        if (!FIND_OPTIONS.has(key)) throw unsupported(`find option '${key}'`);
      }
      refuseCommon(o);
      return select(ast || null, o);
    },
    async findOne (identifier, projection, options) {
      refuseCommon({ projection });
      return select(fromMongo(utils.filterForOne(identifier)), { sort: ONE_ORDER, limit: 1, projection, options });
    },
    async count (ast, opts) {
      const o = opts || { };
      if (o.v1) throw unsupported('API v1 dialect');
      if (ast === null || ast === undefined) throw new TypeError('$: filter node must be an object');
      compileFilter(ast, new Params(), { legacyPatterns });
      return rows.filter(matcher(ast)).length;
    }
  };
};

module.exports.rowsOf = rowsOf;
module.exports.compareC = compareC;
module.exports.jsonbOrdered = jsonbOrdered;
