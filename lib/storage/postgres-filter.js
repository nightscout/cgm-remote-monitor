// PostgreSQL compiler for a bounded subset of the storage filter AST
// (lib/storage/filter.js, strict dialect), sort specifications and cursor
// bounds, over a typed-identity table: (tenant_id, id_kind, "_id", doc jsonb)
// as stored by lib/storage/postgres-identity.js.
//
// Not the held-back toSql adapter. It answers only shapes whose MongoDB answer
// it reproduces exactly, and refuses everything else before a query is run
// (UnsupportedQueryError) rather than approximating it. Differential evidence
// against a live mongod: tests/postgres-entries-read.test.js.
//
// Supported:
//   * top-level fields only (a dotted path traverses arrays in MongoDB);
//   * operands null, finite numbers, strings and booleans, plus ObjectId and
//     string operands on _id, compared with the stored id_kind;
//   * eq ne gt gte lt lte in nin with MongoDB's type brackets, null-and-missing
//     rule and one level of array-element matching;
//   * exists; type 'string'/2, 'bool'/8, 'null'/10, 'number'; nottype 'array'.
// Refused: re (PCRE is not PostgreSQL's regex dialect), the v1 dialect, dotted
// paths, Date/RegExp/array/object/other driver operands, ObjectId operands
// outside _id, type/nottype on _id, other $type aliases.
//
// Every operand and field name is a bind parameter; the only identifiers in
// the SQL text are fixed column names.
//
// Index bound (option `columns`, from INDEXED_COLUMNS by table): an eq/in on a
// field with a generated column that leads a (tenant_id, column) index is
// compiled as `<index bound> AND <the exact form above>`. The bound is a
// superset of the exact match, so answers are unchanged; it only lets the
// planner read an index range instead of every row the tenant holds.
//   text: the column is the value when it is a string, else NULL. A string
//     element of an array leaves it NULL, so the bound is `c = p OR c IS NULL`.
//   window-text: an array stores its greatest string element (COLLATE "C"),
//     so a match is `c >= p` (an equal string, or an array reaching p).
//   window-number: the floor of a number, or of an array's greatest number,
//     so a match is `c >= floor(p)`.
//   A gt/gte on a window column takes the same bound (its operand, the floor).
//   identifier: like text, but the NULL arm is narrowed to array values,
//     `c = p OR (c IS NULL AND jsonb_typeof(doc -> 'identifier') = 'array')`,
//     which the partial index of migration 0098_<table>_identifier_arrays
//     (identifier-array-index-sql.js) serves. Rows that simply hold no
//     identifier (all v1-written history) are not read.
// Every bound also admits arrays (or `c IS NULL`), so a table whose column
// leaves arrays NULL is still answered exactly, with or without the index.

'use strict';

const { validate, GROUP } = require('./filter');

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SQL_OP = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const TYPE_ALIAS = new Map([['string', 'string'], [2, 'string'], ['bool', 'boolean'], [8, 'boolean'],
  ['null', 'null'], [10, 'null'], ['number', 'number']]);
// API3 adds four stable tie-breakers after one requested scalar field.
const MAX_SORT_KEYS = 5;
// MongoDB's sort order across the JSON types a jsonb document can hold.
const RANK = { null: 1, number: 2, string: 3, object: 4, array: 5, objectid: 7, boolean: 8 };

class UnsupportedQueryError extends TypeError {
  constructor (message) {
    super('PostgreSQL entries read: unsupported ' + message);
    this.name = 'UnsupportedQueryError';
    this.unsupported = true;
  }
}

function unsupported (message) {
  return new UnsupportedQueryError(message);
}

function isObjectId (v) {
  return !!v && typeof v === 'object' && v._bsontype === 'ObjectId' && typeof v.toHexString === 'function';
}

// The JSON type a scalar operand is compared as, or a refusal.
function operandKind (v, field) {
  if (v === null) return 'null';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw unsupported(`non-finite number operand on '${field}'`);
    return 'number';
  }
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  if (isObjectId(v)) {
    if (field !== '_id') throw unsupported(`ObjectId operand on '${field}' (only _id keeps its kind)`);
    return 'objectid';
  }
  throw unsupported(`operand type on '${field}' (${Object.prototype.toString.call(v)})`);
}

function topLevel (field) {
  if (!FIELD.test(field)) throw unsupported(`field path '${field}' (top-level fields only)`);
  return field;
}

class Params {
  constructor () { this.values = []; }
  add (value) {
    this.values.push(value);
    return '$' + this.values.length;
  }
}

// Generated columns that lead a (tenant_id, column) index, per table name, as
// created by migrations/candidates/postgres-<table>-v1.json (and the
// socket-order successors). A table under another name gets no bound.
const INDEXED_COLUMNS = Object.freeze({
  entries: Object.freeze({ sysTime: 'text', type: 'text', dateString: 'text', identifier: 'identifier', date: 'window-number' }),
  treatments: Object.freeze({ created_at: 'window-text', eventType: 'text', identifier: 'identifier' }),
  devicestatus: Object.freeze({ created_at: 'window-text', identifier: 'identifier' }),
  activity: Object.freeze({ created_at: 'text', identifier: 'identifier' }),
  profile: Object.freeze({ identifier: 'identifier' }),
  food: Object.freeze({ identifier: 'identifier' })
});
const IDENTIFIER_ARRAYS = require('./identifier-array-index-sql').PREDICATE;

function compileFilter (ast, params, { legacyPatterns = false, columns = null } = {}) {
  if (ast === null || ast === undefined) return 'true';
  if (ast && typeof ast === 'object' && (ast.explicit || ast.implicit || 'operand' in ast)) {
    throw unsupported('API v1 dialect node');
  }
  validate(ast);
  return node(ast, true);

  // `bounded`: whether leaves carry their own index bound. Inside an $or
  // whose bound was hoisted (hoistedOr) they do not.
  function node (n, bounded) {
    if (GROUP.has(n.op)) {
      if (!n.nodes.length) return 'true';
      if (n.op === 'or' && bounded) {
        const hoisted = hoistedOr(n.nodes);
        if (hoisted) return hoisted;
      }
      return '(' + n.nodes.map(x => node(x, bounded)).join(n.op === 'and' ? ' AND ' : ' OR ') + ')';
    }
    const field = topLevel(n.field);
    return field === '_id' ? idLeaf(n) : leaf(n, field, bounded);
  }

  // An $or of one filter per document (a v1 batch's target, on-deleted and
  // server-date reads) bounded once: for each indexed column every branch
  // bounds (a positive eq/in in the branch's top-level AND), one bound over
  // the union of their operands, ANDed with the branches' exact forms. Each
  // branch implies its own bound, which implies the union, so the answer is
  // unchanged. Bounding each branch instead gives the planner one index arm
  // per branch (two for a nullable column): a 288-document fallback-key batch
  // was 577 bitmap index scans, planned in 85-125 ms and run in 35-65 ms on
  // an empty tenant (measured, PostgreSQL 16, R3). With no column common to
  // every branch, each branch keeps its own bound, as before.
  function hoistedOr (branches) {
    if (!columns || branches.length < 2) return null;
    const per = branches.map(branch => boundOperands(branch));
    const common = [...per[0].keys()].filter(field => per.every(m => m.has(field)));
    const bounds = [];
    for (const field of common) {
      const values = [...new Set(per.flatMap(m => m.get(field)))];
      const sql = boundSql(field, values);
      if (sql) bounds.push(sql);
    }
    if (!bounds.length) return null;
    return '(' + bounds.join(' AND ') + ' AND (' + branches.map(x => node(x, false)).join(' OR ') + '))';
  }

  // field -> operands of the first positive eq/in on an indexed column in a
  // branch's top-level conjunction (nested ANDs included, ORs not).
  function boundOperands (n, into = new Map()) {
    if (n.op === 'and') { for (const x of n.nodes) boundOperands(x, into); return into; }
    if ((n.op === 'eq' || n.op === 'in') && Object.hasOwn(columns, n.field) && !into.has(n.field)) {
      const values = n.op === 'eq' ? [n.value] : n.value;
      if (values.length) into.set(n.field, values);
    }
    return into;
  }

  // COALESCE keeps every leaf two-valued, so NOT (for ne/nin) never meets NULL.
  function leaf (n, field, bounded) {
    // A constant answer (gt null) binds nothing: PostgreSQL refuses an unused parameter.
    if ((n.op === 'gt' || n.op === 'lt') && operandKind(n.value, field) === 'null') return 'false';
    if ((n.op === 'in' || n.op === 'nin') && !n.value.length) return n.op === 'in' ? 'false' : 'true';
    if (n.op === 'exists') return `${n.value ? '' : 'NOT '}(doc ? ${params.add(field)}::text)`;
    const x = `(doc -> ${params.add(field)}::text)`;
    const within = (values, exact) => bounded ? indexBound(field, values, exact) : exact;
    switch (n.op) {
      case 'eq': return within([n.value], bool(equal(x, n.value, field)));
      case 'ne': return `NOT ${bool(equal(x, n.value, field))}`;
      case 'in': return within(n.value, bool(anyOf(x, n.value, field)));
      case 'nin': return `NOT ${bool(anyOf(x, n.value, field))}`;
      // A lower bound on a window column: the column is the value, or an
      // array's greatest element, so a match implies column >= operand (the
      // window bound of eq). The default v1 device status and treatments
      // reads (created_at >= the window start) otherwise read every row the
      // tenant holds. An upper bound has no such form (an array matches by
      // any element), and a text column is not in the "C" collation.
      case 'gt': case 'gte':
        return within(isWindow(field) ? [n.value] : null, bool(range(x, n.op, n.value, field)));
      case 'lt': case 'lte': return bool(range(x, n.op, n.value, field));
      case 'type': {
        if (!TYPE_ALIAS.has(n.value)) throw unsupported(`$type ${JSON.stringify(n.value)}`);
        return bool(elementwise(x, e => `jsonb_typeof(${e}) = ${params.add(TYPE_ALIAS.get(n.value))}::text`));
      }
      case 'nottype': return `(jsonb_typeof(${x}) IS DISTINCT FROM 'array')`;
      case 're': {
        if (!legacyPatterns) throw unsupported("operator 're'");
        if (n.options) throw unsupported('regular expression dialect');
        let pattern = n.value.startsWith('^') ? n.value.slice(1) : n.value;
        while (pattern.length) {
          if (/^[A-Za-z0-9_ :,\-/]/.test(pattern)) pattern = pattern.slice(1);
          else if (pattern.startsWith('.*')) pattern = pattern.slice(2);
          else if (pattern.startsWith('.')) pattern = pattern.slice(1);
          else if (pattern.startsWith('\\') && '.+*-?()[]{}^$|\\/'.includes(pattern[1])) pattern = pattern.slice(2);
          else throw unsupported('regular expression outside the literal/time-helper subset');
        }
        // Partial newline sensitivity: dot excludes newline; ^ anchors the
        // string, not individual lines. No end anchors/flags/classes/PCRE
        // constructs are admitted by the literal grammar above.
        return bool(elementwise(x, e => `(jsonb_typeof(${e}) = 'string' AND ` +
          `regexp_like(${e} #>> '{}', ${params.add(n.value)}::text, 'p'))`));
      }
      default: throw unsupported(`operator '${n.op}'`);
    }
  }

  function bool (sql) { return `COALESCE(${sql}, false)`; }

  // A two-valued superset of `exact` the planner can read from the column's
  // index, ANDed with it. Only for positive eq/in, and gt/gte on a window
  // column, with operands of the column's type; anything else (`values`
  // null) is the exact form alone.
  function indexBound (field, values, exact) {
    const bound = values && boundSql(field, values);
    return bound ? `(${bound} AND ${exact})` : exact;
  }

  function isWindow (field) {
    return !!columns && Object.hasOwn(columns, field) && columns[field].startsWith('window-');
  }

  // The bound alone, or null where none applies (no indexed column, or an
  // operand of another type).
  function boundSql (field, values) {
    const kind = columns && Object.hasOwn(columns, field) ? columns[field] : null;
    if (!kind) return null;
    const c = '"' + field + '"';
    if (kind === 'text' || kind === 'window-text' || kind === 'identifier') {
      if (!values.every(v => typeof v === 'string')) return null;
      const collate = kind === 'window-text' ? ' COLLATE "C"' : '';
      if (kind !== 'window-text') {
        const eq = values.length === 1 ? `${c} = ${params.add(values[0])}::text` : `${c} = ANY(${params.add(values)}::text[])`;
        if (kind === 'identifier') {
          if (field !== 'identifier') throw new TypeError('identifier bound on ' + field);
          return `(${eq} OR (${c} IS NULL AND ${IDENTIFIER_ARRAYS}))`;
        }
        return `(${eq} OR ${c} IS NULL)`;
      }
      const least = values.reduce((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b)) <= 0 ? a : b));
      return `(${c}${collate} >= ${params.add(least)}::text OR ${c} IS NULL)`;
    }
    if (kind === 'window-number') {
      if (!values.every(v => typeof v === 'number' && Number.isFinite(v))) return null;
      const least = Math.floor(Math.min(...values));
      if (!Number.isSafeInteger(least)) return null;
      return `(${c} >= ${params.add(String(least))}::bigint OR ${c} IS NULL)`;
    }
    throw new TypeError('unknown indexed column kind ' + kind);
  }

  // MongoDB matches the value itself or any element of an array value.
  function elementwise (x, test) {
    return `(${test(x)} OR (jsonb_typeof(${x}) = 'array' AND EXISTS ` +
      `(SELECT 1 FROM jsonb_array_elements(${x}) AS el(v) WHERE ${test('el.v')})))`;
  }

  // An array matches when one of its own elements equals the operand. That
  // element test is jsonb containment of a one-element array: it compares
  // top-level elements only (not nested arrays or subdocuments), strings byte
  // for byte and numbers numerically, as the elementwise form does, and it
  // plans no subquery. The elementwise EXISTS gave each leaf a correlated
  // SubPlan, which every statement plans and initializes: a 288-document
  // treatments batch's on-deleted read carried 4,034 of them (R3, measured).
  function equal (x, value, field) {
    const kind = operandKind(value, field);
    if (kind === 'null') {
      return `(${x} IS NULL OR jsonb_typeof(${x}) = 'null' OR (jsonb_typeof(${x}) = 'array' AND ${x} @> '[null]'::jsonb))`;
    }
    const cast = { number: 'numeric', string: 'text', boolean: 'boolean' }[kind];
    return `(${scalar(x, '=', value, field)} OR (jsonb_typeof(${x}) = 'array' AND ` +
      `${x} @> jsonb_build_array(${params.add(value)}::${cast})))`;
  }

  function anyOf (x, values, field) {
    return '(' + values.map(v => equal(x, v, field)).join(' OR ') + ')';
  }

  // A null operand is its own bracket: lte/gte null are eq null (lt/gt null: see leaf).
  function range (x, op, value, field) {
    if (operandKind(value, field) === 'null') return equal(x, null, field);
    return elementwise(x, e => scalar(e, SQL_OP[op], value, field));
  }

  // CASE, not AND: PostgreSQL does not promise to test the type before the cast.
  function scalar (e, sqlOp, value, field) {
    const kind = operandKind(value, field);
    const p = params.add(value);
    if (kind === 'number') {
      return `CASE WHEN jsonb_typeof(${e}) = 'number' THEN (${e})::numeric ${sqlOp} ${p}::numeric ELSE false END`;
    }
    if (kind === 'string') {
      return `CASE WHEN jsonb_typeof(${e}) = 'string' THEN (${e} #>> '{}') COLLATE "C" ${sqlOp} ${p}::text ELSE false END`;
    }
    return `CASE WHEN jsonb_typeof(${e}) = 'boolean' THEN (${e})::boolean ${sqlOp} ${p}::boolean ELSE false END`;
  }

  // _id is never absent, null or an array here: the identity codec stores only
  // nonempty strings and ObjectIds, each with its kind in id_kind.
  function idLeaf (n) {
    switch (n.op) {
      case 'eq': return idEqual(n.value);
      case 'ne': return `NOT ${idEqual(n.value)}`;
      case 'in': return n.value.length ? '(' + n.value.map(idEqual).join(' OR ') + ')' : 'false';
      case 'nin': return n.value.length ? `NOT (${n.value.map(idEqual).join(' OR ')})` : 'true';
      case 'gt': case 'gte': case 'lt': case 'lte': return idCompare(SQL_OP[n.op], n.value);
      case 'exists': return n.value ? 'true' : 'false';
      default: throw unsupported(`operator '${n.op}' on _id`);
    }
  }

  function idEqual (value) { return idCompare('=', value); }

  // Equality under any deterministic collation is byte equality, so `=`
  // keeps the column's own collation and the primary key (tenant_id,
  // id_kind, "_id") serves it; an order comparison needs "C".
  function idCompare (sqlOp, value) {
    const kind = operandKind(value, '_id');
    const column = sqlOp === '=' ? '"_id"' : '"_id" COLLATE "C"';
    if (kind === 'objectid') {
      return `(id_kind = 'objectid' AND ${column} ${sqlOp} ${params.add(value.toHexString())}::text)`;
    }
    if (kind === 'string') {
      return `(id_kind = 'string' AND ${column} ${sqlOp} ${params.add(value)}::text)`;
    }
    return 'false';
  }
}

// ORDER BY terms reproducing MongoDB's cross-type order for null/missing,
// numbers, strings and booleans, and ObjectId/string _id. Arrays and
// subdocuments sort by rules this does not reproduce; `unsortable` is an
// expression true for such a value so the caller can refuse the whole read.
function compileSort (sort, params) {
  if (sort === undefined || sort === null) return null;
  if (typeof sort !== 'object' || Array.isArray(sort) || sort instanceof Map) {
    throw unsupported('sort specification (a plain {field: 1|-1} object)');
  }
  const keys = Object.keys(sort);
  if (!keys.length) return null;
  if (keys.length > MAX_SORT_KEYS) throw unsupported(`sort over more than ${MAX_SORT_KEYS} keys`);
  const terms = [];
  const unsortable = [];
  for (const key of keys) {
    const field = topLevel(key);
    if (sort[key] !== 1 && sort[key] !== -1) throw unsupported(`sort direction for '${field}' (1 or -1)`);
    const dir = sort[key] === 1 ? 'ASC' : 'DESC';
    if (field === '_id') {
      terms.push(`CASE id_kind WHEN 'string' THEN ${RANK.string} ELSE ${RANK.objectid} END ${dir}`,
        `"_id" COLLATE "C" ${dir}`);
      continue;
    }
    const x = `(doc -> ${params.add(field)}::text)`;
    terms.push(
      `CASE COALESCE(jsonb_typeof(${x}), 'null') WHEN 'null' THEN ${RANK.null} WHEN 'number' THEN ${RANK.number} ` +
        `WHEN 'string' THEN ${RANK.string} WHEN 'boolean' THEN ${RANK.boolean} ` +
        `WHEN 'object' THEN ${RANK.object} ELSE ${RANK.array} END ${dir}`,
      `CASE WHEN jsonb_typeof(${x}) = 'number' THEN (${x})::numeric END ${dir}`,
      `CASE WHEN jsonb_typeof(${x}) = 'string' THEN (${x} #>> '{}') COLLATE "C" END ${dir}`,
      `CASE WHEN jsonb_typeof(${x}) = 'boolean' THEN (${x})::boolean END ${dir}`);
    unsortable.push(`jsonb_typeof(${x}) IN ('array', 'object')`);
  }
  return { orderBy: terms.join(', '), unsortable: unsortable.length ? unsortable.join(' OR ') : null };
}

// find.js cursorInt: parseInt, and refuse what does not parse. limit 0 is
// MongoDB's "no limit"; a negative bound has MongoDB-specific meaning and is refused.
function bound (name, value) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new TypeError(name + ' must be an integer');
  if (parsed < 0) throw unsupported(`negative ${name}`);
  return parsed;
}

// The bound columns for a (possibly schema-qualified) table name.
function indexedColumns (table) {
  const name = typeof table === 'string' ? table.split('.').pop() : null;
  return name && Object.hasOwn(INDEXED_COLUMNS, name) ? INDEXED_COLUMNS[name] : null;
}

module.exports = { compileFilter, compileSort, bound, Params, UnsupportedQueryError, INDEXED_COLUMNS, indexedColumns };
