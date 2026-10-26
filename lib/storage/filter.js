// The storage interface's filter language, and its MongoDB adapter.
//
// WHY THIS SHAPE. API v3 already has an AST: `filterDef` is an array of
// {field, operator, value} with a top-level logicalOperator, and
// lib/api3/storage/mongoCollection/utils.js parseFilter() is already its MongoDB
// adapter. So this is not a new design — it is v3's existing filter model with the
// smallest set of extensions that let API v1's real output be expressed in it.
//
// The extensions, each because a measured v1 shape needs it:
//
//   1. NESTED GROUPS. v3's AST is flat: every clause is joined by one
//      logicalOperator. v1 emits top-level $or with clause objects, so a group
//      node is required. This is the only structural change.
//   2. `exists`. v1 passes $exists through; it is not one of v3's nine. Added
//      deliberately rather than by accident, because the alternative is that
//      v1 queries using it stop working.
//   3. `type`. dev's v1 operator allowlist (lib/server/query-operator-allowlist.js,
//      #8743) admits $type, and #8737 made `find[sgv][$type]=2` reach MongoDB as
//      the number 2. Without a node for it, v1 would narrow by one operator the
//      day its reads move onto this interface.
//   4. `nottype`, admitting only 'array'. dev's treatment fallback key
//      (lib/server/treatment-fallback-key.js, BF-121) matches null or empty
//      client ids with {$in: [null, ''], $not: {$type: 'array'}}.
//
// Everything else v1 produces maps onto v3's nine operators unchanged:
// implicit equality -> eq; {$gte, $lte} on one field -> two clauses; dotted paths
// -> field names that happen to contain dots.
//
// WHAT THE AST DELIBERATELY CANNOT EXPRESS is the point of it. There is no
// $where, no $expr, no arbitrary pipeline, no operator escape hatch. An AST that
// cannot represent an unlisted operator is an allowlist by construction, and
// validation runs before any adapter, so nothing unlisted reaches a backend.
//
// ONE ADAPTER HERE. A PostgreSQL adapter (toSql) was written beside this one and
// is held back until a PostgreSQL backend lands. The semantics it forced are
// MongoDB's own and stay pinned against a live mongod in
// tests/api3.storage.filter-semantics.test.js: a comparison never crosses a
// BSON type bracket ("120" is not >= 100), $ne and $nin match a missing field
// and a field of another type, a null operand is its own bracket ($lte/$gte
// null match null and missing, $lt/$gt null match nothing), $exists is key
// presence, and $regex matches strings only. The MongoDB adapter honours them
// by passing values through untouched; the tests are what stop a later
// "normalisation" of values from quietly changing them.
//
// NODE SHAPES
//   {op: 'and'|'or', nodes: [...]}                      group
//   {op: <cmp>, field: 'a.b', value: v}                  comparison
//   {op: 're', field: 'a.b', value: 'pat', options: 'i'} comparison with flags
//   cmp: eq ne gt gte lt lte in nin re exists type nottype
//
// `in`/`nin` take an array. `re` takes a pattern string, bounded (see
// RE_MAX_LEN) because an unbounded regex is the live ReDoS vector.
//
// `re` carries its flags in a separate `options` field rather than inline in the
// pattern, so they do not consume the RE_MAX_LEN budget and each backend can
// spell them its own way. Only the flags MongoDB honours are kept (RE_FLAGS).

'use strict';

const CMP = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 're', 'exists', 'type', 'nottype']);
const GROUP = new Set(['and', 'or']);
const RE_MAX_LEN = 128;
// The flags MongoDB honours on a regex predicate.
const RE_FLAGS = 'imsx';
// The letters mongod accepts in a $options string: RE_FLAGS plus `u`, which it
// accepts and ignores (UTF mode is always on). Any other letter is an error
// from mongod -- measured on 8.0.34: `invalid flag in regex options: g`.
const MONGO_OPTIONS = RE_FLAGS + 'u';

// ---------------------------------------------------------------- validation
//
// Structural validation is the allowlist. It runs before any adapter, so a
// malformed or unlisted operator can never reach a backend.

function validate (node, options) {
  return isV1(options) ? checkV1(node, '$') : check(node, '$');
}

function check (node, path) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new TypeError(`${path}: filter node must be an object`);
  }
  const { op } = node;
  if (GROUP.has(op)) {
    if (!Array.isArray(node.nodes)) throw new TypeError(`${path}: ${op} requires nodes[]`);
    // An empty conjunction is TRUE (match everything), which is what an
    // unfiltered read means. An empty disjunction is FALSE, and MongoDB
    // refuses `$or: []` outright; emitting {} for it would turn "match
    // nothing" into "match everything".
    if (op === 'or' && node.nodes.length === 0) {
      throw new TypeError(`${path}: or requires at least one node`);
    }
    node.nodes.forEach((n, i) => check(n, `${path}.${op}[${i}]`));
    return node;
  }
  if (!CMP.has(op)) {
    throw new TypeError(`${path}: unsupported operator '${op}' ` +
      `(allowed: ${[...CMP].join(' ')})`);
  }
  if (typeof node.field !== 'string' || !node.field.length) {
    throw new TypeError(`${path}: ${op} requires a field name`);
  }
  // A field name is a dotted path of plain segments, so no backend ever has to
  // escape one: it is safe by construction.
  if (!node.field.split('.').every(segment => /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment))) {
    throw new TypeError(`${path}: invalid field path '${node.field}'`);
  }
  if (op === 'in' || op === 'nin') {
    if (!Array.isArray(node.value)) throw new TypeError(`${path}: ${op} requires an array`);
  }
  if (op === 're') {
    if (typeof node.value !== 'string') throw new TypeError(`${path}: re requires a string`);
    if (node.value.length > RE_MAX_LEN) {
      throw new TypeError(`${path}: re pattern exceeds ${RE_MAX_LEN} characters`);
    }
    if (node.options !== undefined) {
      if (typeof node.options !== 'string') {
        throw new TypeError(`${path}: re options must be a string`);
      }
      for (const f of node.options) {
        if (!RE_FLAGS.includes(f)) {
          throw new TypeError(`${path}: unsupported regex flag '${f}' ` +
            `(allowed: ${RE_FLAGS.split('').join(' ')})`);
        }
      }
    }
  }
  // A BSON type alias string or number. An array of types is legal MongoDB
  // but nothing in v1 emits one, so it is refused rather than guessed at.
  if (op === 'type' && typeof node.value !== 'string' && typeof node.value !== 'number') {
    throw new TypeError(`${path}: type requires a type name`);
  }
  if (op === 'nottype' && node.value !== 'array') {
    throw new TypeError(`${path}: nottype supports only 'array'`);
  }
  if (op === 'exists' && typeof node.value !== 'boolean') {
    throw new TypeError(`${path}: exists requires a boolean`);
  }
  return node;
}

// ---------------------------------------------------------------- MongoDB
//
// Mirrors parseFilter()'s operator mapping and adds grouping. A conjunction is
// emitted in MongoDB's compact form where it can be (see buildAnd), and as an
// explicit $and where merging would lose a clause.

const MONGO_OP = { eq: '$eq', ne: '$ne', gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte',
  in: '$in', nin: '$nin' };

function toMongo (node, options) {
  if (isV1(options)) {
    checkV1(node, '$');
    return buildV1(node);
  }
  check(node, '$');
  return build(node);

  function build (n) {
    if (GROUP.has(n.op)) {
      // Only `and` can be empty here: validate() refuses an empty `or`.
      if (n.nodes.length === 0) return {};
      if (n.op === 'and') return buildAnd(n.nodes);
      return { $or: n.nodes.map(build) };
    }
    return one(n);
  }

  function one (n) {
    if (n.op === 're') {
      return n.options
        ? { [n.field]: { $regex: n.value, $options: n.options } }
        : { [n.field]: { $regex: n.value } };
    }
    if (n.op === 'exists') return { [n.field]: { $exists: n.value } };
    if (n.op === 'nottype') return { [n.field]: { $not: { $type: n.value } } };
    if (n.op === 'type') return { [n.field]: { $type: n.value } };
    return { [n.field]: { [MONGO_OP[n.op]]: n.value } };
  }

  // Emit MongoDB's compact conjunction -- {a: {$gte: 1, $lte: 9}, b: {$eq: 2}}
  // -- rather than an explicit $and, whenever no field/operator pair collides
  // and no child is a group. The two are semantically identical, but the
  // compact form is what the codebase already produces and what the planner
  // sees today (tests/legacy-storage-selector-hardening pins treatments' exact
  // selector), so preserving it keeps a conversion invisible to MongoDB as
  // well as to callers. Falls back to $and the moment merging would lose a
  // clause.
  function buildAnd (nodes) {
    const merged = { };
    for (const n of nodes) {
      if (GROUP.has(n.op)) return { $and: nodes.map(build) };
      const clause = one(n);
      const field = Object.keys(clause)[0];
      const ops = clause[field];
      if (!Object.prototype.hasOwnProperty.call(merged, field)) {
        merged[field] = { ...ops };
        continue;
      }
      for (const opKey of Object.keys(ops)) {
        // Same field AND same operator twice cannot be merged into one object.
        if (Object.prototype.hasOwnProperty.call(merged[field], opKey)) {
          return { $and: nodes.map(build) };
        }
        merged[field][opKey] = ops[opKey];
      }
    }
    return merged;
  }
}

// ---------------------------------------------------------------- from MongoDB
//
// Parses a MongoDB query document back into the AST. This is the migration
// bridge: lib/server/query.js already builds a correct Mongo filter from an API
// v1 request, and reimplementing that logic would risk changing behaviour, so
// callers convert its OUTPUT instead.
//
// The rule every case below follows: toMongo(fromMongo(f)) must select what f
// selects ON THE WIRE, which means as the driver serialises f and as mongod
// reads it -- not as JavaScript would read it. Where mongod refuses f, so does
// fromMongo: turning a MongoDB error into a result set is a widened read.
//
// It is also an operator allowlist. Anything the AST cannot express throws
// here -- $where, $expr, $elemMatch, $near and friends stop at this boundary
// rather than reaching the driver.
//
// NOTE ON VALUES: values pass through untouched, so an ObjectId stays an
// ObjectId. That is correct for the MongoDB adapter and is a known gap for a
// future SQL adapter, which will need an identifier type rather than a driver
// object. Recorded rather than solved here.

const FROM_MONGO_OP = { $eq: 'eq', $ne: 'ne', $gt: 'gt', $gte: 'gte', $lt: 'lt',
  $lte: 'lte', $in: 'in', $nin: 'nin' };

function fromMongo (filter, options) {
  if (isV1(options)) return fromMongoV1(filter);
  if (filter === null || filter === undefined) return and();
  if (typeof filter !== 'object' || Array.isArray(filter)) {
    throw new TypeError('filter must be an object');
  }

  const nodes = [];

  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' || key === '$or') {
      // mongod: `$or argument must be a non-empty array`, and the same for $and.
      // An empty group here would become {} -- every document.
      if (!Array.isArray(value) || value.length === 0) {
        throw new TypeError(`${key} requires a non-empty array`);
      }
      const group = { op: key === '$and' ? 'and' : 'or', nodes: value.map(f => fromMongo(f)) };
      nodes.push(group);
      continue;
    }
    if (key.startsWith('$')) {
      throw new TypeError(`unsupported top-level operator '${key}'`);
    }
    nodes.push(...fieldNodes(key, value));
  }

  return nodes.length === 1 ? nodes[0] : { op: 'and', nodes };
}

function fieldNodes (field, value) {
  // A native RegExp is a MATCH PREDICATE, not a value and not a nested query:
  // lib/server/query.js's parseRegEx returns one for the treatments notes,
  // eventType and enteredBy filters. It has to be tested before the generic
  // object handling below, because Object.keys(/x/i) is [] -- so without this
  // case the clause produced no nodes at all and was silently dropped,
  // widening the query instead of narrowing it.
  if (value instanceof RegExp) return [ reNode(field, value) ];

  // A bare value is implicit equality: {type: 'sgv'}.
  if (value === null || typeof value !== 'object' || value instanceof Date
      || Array.isArray(value) || isDriverObject(value)) {
    return [{ op: 'eq', field, value }];
  }

  const keys = Object.keys(value);
  // An object with no $-keys is also a literal: {a: {b: 1}} matches the
  // subdocument, and {a: {}} matches an empty one (mongod returns exactly the
  // documents whose `a` is {}). The empty object needs saying: it has no keys
  // at all, so without `!keys.length` it fell through to the operator map
  // below, produced no node, and the clause vanished -- every document.
  if (!keys.length || !keys.some(k => k.startsWith('$'))) {
    return [{ op: 'eq', field, value }];
  }

  // $options is a modifier on $regex rather than a predicate of its own, so it
  // is consumed here instead of becoming a node.
  if (keys.includes('$options') && !keys.includes('$regex')) {
    throw new TypeError(`$options without $regex on field '${field}'`);
  }

  return keys.filter(k => k !== '$options').map(function toNode (k) {
    if (k === '$regex') return regexOperatorNode(field, value.$regex, value.$options);
    // MongoDB's reading of an $exists operand, not JavaScript's. Measured on
    // mongod 8.0.34: false, 0 (and -0), null and undefined (which the driver
    // sends as null) ask for absence; every other value -- '', NaN, 'false',
    // [], {} -- asks for presence. lib/server/query.js has already read
    // 'true'/'false'/'1'/'0' (#8737); anything it passed through must mean what
    // the driver made of it.
    if (k === '$exists') {
      const v = value[k];
      return { op: 'exists', field, value: !(v === false || v === 0 || v === null || v === undefined) };
    }
    if (k === '$type') return { op: 'type', field, value: value[k] };
    if (k === '$not' && value[k] && typeof value[k] === 'object'
        && Object.keys(value[k]).length === 1 && value[k].$type === 'array') {
      return { op: 'nottype', field, value: 'array' };
    }
    const op = FROM_MONGO_OP[k];
    if (!op) throw new TypeError(`unsupported operator '${k}' on field '${field}'`);
    return { op, field, value: value[k] };
  });
}

// The flags the driver puts on the wire for a native RegExp. js-bson's
// serializeRegExp writes `i` for ignoreCase, `m` for multiline -- and `s` for
// GLOBAL. JavaScript's own `s` (dotAll), `u`, `y`, `d` and `v` are not written
// at all. So /a.b/g reaches mongod as dot-matches-newline and /a.b/s does not;
// measured on 8.0.34 over {'a\nb', 'axb'}: /a.b/g -> both, /a.b/s -> 'axb'
// only. Reading `.flags` instead would reproduce JavaScript's meaning and
// change the answer.
function wireFlags (re) {
  return (re.ignoreCase ? 'i' : '') + (re.global ? 's' : '') + (re.multiline ? 'm' : '');
}

// {$regex, $options}: mongod's rules, each measured on 8.0.34.
//   $regex must be a string or a regex   `$regex has to be a string`
//   $options must be a string            `$options has to be a string`
//   letters outside i m s x u            `invalid flag in regex options: g`
//   a regex with flags AND $options      `options set in both $regex and $options`
function regexOperatorNode (field, pattern, options) {
  const isRe = pattern instanceof RegExp;
  if (!isRe && typeof pattern !== 'string') {
    throw new TypeError(`$regex on field '${field}' must be a string or a RegExp`);
  }
  if (options !== undefined && typeof options !== 'string') {
    throw new TypeError(`$options on field '${field}' must be a string`);
  }
  for (const f of options || '') {
    if (!MONGO_OPTIONS.includes(f)) {
      throw new TypeError(`unsupported regex flag '${f}' in $options on field '${field}'`);
    }
  }
  const embedded = isRe ? wireFlags(pattern) : '';
  if (embedded && options) {
    throw new TypeError(`regex flags set in both $regex and $options on field '${field}'`);
  }
  return makeRe(field, isRe ? pattern.source : pattern, embedded + (options || ''));
}

function reNode (field, re) {
  return makeRe(field, re.source, wireFlags(re));
}

// Keep only the flags MongoDB acts on, sorted and de-duplicated. Flags live on
// the node, never inside the pattern, so they cost nothing against RE_MAX_LEN.
function makeRe (field, source, raw) {
  const flags = [...new Set(raw)].filter(f => RE_FLAGS.includes(f)).sort().join('');
  const node = { op: 're', field, value: source };
  if (flags) node.options = flags;
  return node;
}

// An ObjectId (or any driver value) is a value, not a nested query document.
function isDriverObject (v) {
  return typeof v === 'object' && v !== null
    && (typeof v.toHexString === 'function' || v._bsontype !== undefined);
}

// ---------------------------------------------------------------- API v1 dialect
//
// API v1 must answer every request exactly as it did before its reads moved
// onto this interface: the same documents, the same status, the same error
// body. The strict AST above is narrower than what API v1 admits today --
// plain-identifier field paths, a 128-character regex bound, operands read
// the way mongod reads them -- and narrowing v1 is a separate, measured change.
// So v1 reads use this dialect, selected with {v1: true} on fromMongo,
// validate and toMongo.
//
// What it admits is exactly what lib/server/query.js and
// lib/server/query-operator-allowlist.js admit, and nothing more: the same
// operators ($eq $ne $gt $gte $lt $lte $in $nin $regex $options $exists $type,
// and $and/$or), plus the one internal shape dev's own code adds
// ({$not: {$type: 'array'}}, BF-121's fallback key). Any other operator still
// throws here, as in the strict dialect.
//
// What it does NOT do is reinterpret anything. Operands are kept verbatim
// (a $type list, a non-array $in, an $exists of '', a RegExp object, a $regex
// that is not a string), field names are any key the caller sent, and the
// form is recorded -- implicit equality, an explicit $and/$or, a document of
// several fields -- so that toMongo(fromMongo(f, v1), v1) is f again, operand
// for operand. MongoDB therefore receives the same query document, gives the
// same answer and, for a document it refuses, the same error. That identity is
// the property the tests and the differential check.
//
// Shapes mongod refuses are kept too, rather than refused here: a logical
// operator whose operand is not a non-empty array of documents ({$or: 'x'},
// {$or: ['']}, both reachable from a query string) is carried as `operand`
// and only ever in that refused form, so it can reach mongod only to be
// refused by it, as it is today.

function isV1 (options) {
  return !!(options && options.v1);
}

// A query document, as mongod uses the word for an $and/$or entry: a plain
// object, not an array, date, regex or driver value.
function isDocument (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp)
    && !(v instanceof Date) && !isDriverObject(v);
}

function v1Error (message, operator) {
  const err = new TypeError(message);
  if (operator !== undefined) err.operator = operator;
  return err;
}

function fromMongoV1 (filter) {
  if (filter === null || filter === undefined) return and();
  if (!isDocument(filter)) throw v1Error('filter must be an object');
  const nodes = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' || key === '$or') {
      const op = key === '$and' ? 'and' : 'or';
      nodes.push(Array.isArray(value) && value.length && value.every(isDocument)
        ? { op, explicit: true, nodes: value.map(fromMongoV1) }
        : { op, explicit: true, operand: value });
      continue;
    }
    if (key.startsWith('$')) throw v1Error(`unsupported top-level operator '${key}'`, key);
    nodes.push(...fieldNodesV1(key, value));
  }
  return nodes.length === 1 ? nodes[0] : { op: 'and', nodes };
}

function fieldNodesV1 (field, value) {
  if (value instanceof RegExp) return [{ op: 're', field, value, implicit: true }];
  const keys = isDocument(value) ? Object.keys(value) : [];
  if (!keys.some(k => k.startsWith('$'))) return [{ op: 'eq', field, value, implicit: true }];

  const nodes = [];
  let re = null;
  for (const k of keys) {
    if (k === '$regex' || k === '$options') {
      if (!re) nodes.push(re = { op: 're', field });
      re[k === '$regex' ? 'value' : 'options'] = value[k];
      continue;
    }
    if (k === '$exists') { nodes.push({ op: 'exists', field, value: value[k] }); continue; }
    if (k === '$type') { nodes.push({ op: 'type', field, value: value[k] }); continue; }
    if (k === '$not' && isDocument(value[k]) && Object.keys(value[k]).length === 1
        && value[k].$type === 'array') {
      nodes.push({ op: 'nottype', field, value: 'array' });
      continue;
    }
    const op = FROM_MONGO_OP[k];
    if (!op) throw v1Error(`unsupported operator '${k}' on field '${field}'`, k);
    nodes.push({ op, field, value: value[k] });
  }
  return nodes;
}

function checkV1 (node, path) {
  if (!isDocument(node)) throw v1Error(`${path}: filter node must be an object`);
  const { op } = node;
  if (GROUP.has(op)) {
    if (Object.prototype.hasOwnProperty.call(node, 'operand')) {
      // Only ever a form mongod refuses; a well-formed operand is nodes[].
      const operand = node.operand;
      if (!node.explicit || (Array.isArray(operand) && operand.length && operand.every(isDocument))) {
        throw v1Error(`${path}: ${op} operand must be expressed as nodes`);
      }
      return node;
    }
    if (!Array.isArray(node.nodes)) throw v1Error(`${path}: ${op} requires nodes[]`);
    if (!node.explicit && op === 'or') throw v1Error(`${path}: or must be explicit`);
    node.nodes.forEach((n, i) => checkV1(n, `${path}.${op}[${i}]`));
    return node;
  }
  if (!CMP.has(op)) throw v1Error(`${path}: unsupported operator '${op}'`, op);
  if (typeof node.field !== 'string' || node.field.startsWith('$')) {
    throw v1Error(`${path}: invalid field '${node.field}'`);
  }
  if (node.implicit && op !== 'eq' && op !== 're') throw v1Error(`${path}: ${op} cannot be implicit`);
  if (op === 're' && !node.implicit && !Object.prototype.hasOwnProperty.call(node, 'value')
      && !Object.prototype.hasOwnProperty.call(node, 'options')) {
    throw v1Error(`${path}: re requires $regex or $options`);
  }
  if (op === 'nottype' && node.value !== 'array') throw v1Error(`${path}: nottype supports only 'array'`);
  return node;
}

function buildV1 (n) {
  if (GROUP.has(n.op) && n.explicit) {
    const key = n.op === 'and' ? '$and' : '$or';
    return { [key]: Object.prototype.hasOwnProperty.call(n, 'operand') ? n.operand : n.nodes.map(buildV1) };
  }
  return mergeV1(GROUP.has(n.op) ? n.nodes : [ n ]);
}

// One query document from the nodes of an implicit conjunction, field by field
// in the order they were read. fromMongoV1 never produces two nodes that would
// share a key here; a hand-built AST that does is refused, because merging it
// would not be the document it describes.
function mergeV1 (nodes) {
  const doc = { };
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  for (const n of nodes) {
    if (GROUP.has(n.op)) {
      const built = buildV1(n);
      const key = Object.keys(built)[0];
      if (!n.explicit || own(doc, key)) throw v1Error(`cannot merge '${key}' into one query document`);
      doc[key] = built[key];
      continue;
    }
    if (n.implicit) {
      if (own(doc, n.field)) throw v1Error(`cannot merge field '${n.field}' into one query document`);
      doc[n.field] = n.value;
      continue;
    }
    if (!own(doc, n.field)) doc[n.field] = { };
    const ops = doc[n.field];
    if (!isDocument(ops) || ops instanceof RegExp) {
      throw v1Error(`cannot merge field '${n.field}' into one query document`);
    }
    for (const [k, v] of operatorsV1(n)) {
      if (own(ops, k)) throw v1Error(`cannot merge '${k}' on field '${n.field}' twice`);
      ops[k] = v;
    }
  }
  return doc;
}

function operatorsV1 (n) {
  const own = k => Object.prototype.hasOwnProperty.call(n, k);
  if (n.op === 're') {
    return [own('value') && ['$regex', n.value], own('options') && ['$options', n.options]].filter(Boolean);
  }
  if (n.op === 'exists') return [['$exists', n.value]];
  if (n.op === 'type') return [['$type', n.value]];
  if (n.op === 'nottype') return [['$not', { $type: n.value }]];
  return [[MONGO_OP[n.op], n.value]];
}

// ---------------------------------------------------------------- helpers

const and = (...nodes) => ({ op: 'and', nodes });
const or = (...nodes) => ({ op: 'or', nodes });
const cmp = (op, field, value, options) => options === undefined
  ? ({ op, field, value })
  : ({ op, field, value, options });

module.exports = { validate, toMongo, fromMongo, and, or, cmp, CMP, GROUP,
  RE_MAX_LEN, RE_FLAGS };
