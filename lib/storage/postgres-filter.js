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

function compileFilter (ast, params, { legacyPatterns = false } = {}) {
  if (ast === null || ast === undefined) return 'true';
  if (ast && typeof ast === 'object' && (ast.explicit || ast.implicit || 'operand' in ast)) {
    throw unsupported('API v1 dialect node');
  }
  validate(ast);
  return node(ast);

  function node (n) {
    if (GROUP.has(n.op)) {
      if (!n.nodes.length) return 'true';
      return '(' + n.nodes.map(node).join(n.op === 'and' ? ' AND ' : ' OR ') + ')';
    }
    const field = topLevel(n.field);
    return field === '_id' ? idLeaf(n) : leaf(n, field);
  }

  // COALESCE keeps every leaf two-valued, so NOT (for ne/nin) never meets NULL.
  function leaf (n, field) {
    // A constant answer (gt null) binds nothing: PostgreSQL refuses an unused parameter.
    if ((n.op === 'gt' || n.op === 'lt') && operandKind(n.value, field) === 'null') return 'false';
    if ((n.op === 'in' || n.op === 'nin') && !n.value.length) return n.op === 'in' ? 'false' : 'true';
    if (n.op === 'exists') return `${n.value ? '' : 'NOT '}(doc ? ${params.add(field)}::text)`;
    const x = `(doc -> ${params.add(field)}::text)`;
    switch (n.op) {
      case 'eq': return bool(equal(x, n.value, field));
      case 'ne': return `NOT ${bool(equal(x, n.value, field))}`;
      case 'in': return bool(anyOf(x, n.value, field));
      case 'nin': return `NOT ${bool(anyOf(x, n.value, field))}`;
      case 'gt': case 'gte': case 'lt': case 'lte': return bool(range(x, n.op, n.value, field));
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

  // MongoDB matches the value itself or any element of an array value.
  function elementwise (x, test) {
    return `(${test(x)} OR (jsonb_typeof(${x}) = 'array' AND EXISTS ` +
      `(SELECT 1 FROM jsonb_array_elements(${x}) AS el(v) WHERE ${test('el.v')})))`;
  }

  function equal (x, value, field) {
    if (operandKind(value, field) === 'null') {
      return `(${x} IS NULL OR ${elementwise(x, e => `jsonb_typeof(${e}) = 'null'`)})`;
    }
    return elementwise(x, e => scalar(e, '=', value, field));
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

  function idCompare (sqlOp, value) {
    const kind = operandKind(value, '_id');
    if (kind === 'objectid') {
      return `(id_kind = 'objectid' AND "_id" COLLATE "C" ${sqlOp} ${params.add(value.toHexString())}::text)`;
    }
    if (kind === 'string') {
      return `(id_kind = 'string' AND "_id" COLLATE "C" ${sqlOp} ${params.add(value)}::text)`;
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

module.exports = { compileFilter, compileSort, bound, Params, UnsupportedQueryError };
