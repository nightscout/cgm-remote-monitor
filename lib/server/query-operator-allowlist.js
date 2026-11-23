'use strict';

// API v1's query operator allowlist.
//
// WHY THIS EXISTS. Until now API v1 had no allowlist: `find[...]` was parsed
// by qs, type-walked by lib/server/query.js, and handed onward as a MongoDB
// filter document. Whatever operator a caller named, the query carried it.
// That is backfix register BF-04. On this branch the JavaScript operators are
// already refused by lib/storage/assert-no-query-javascript.js; this module is
// what refuses the rest, so that the set API v1 supports is a NAMED, TESTABLE
// list at the API boundary rather than "whatever the driver happens to accept".
//
// UNLIKE THE SEAM BRANCH'S COPY OF THIS FILE, THERE IS NOTHING BEHIND IT HERE.
// The seam closes this hole structurally -- its filter AST cannot REPRESENT
// $where, $expr, $elemMatch or $near, so fromMongo() throws -- and there the
// same module is a better error message in front of an existing guard. On
// origin/dev the AST does not exist, so on this branch the module IS the
// guard. That is the reason to land it ahead of the seam rather than with it.
//
// It fires on the caller's literal input, before enforceDateFilter() adds its
// own $gte and updateIdQuery() mints ObjectIds, so the operator named in the
// error is one the caller actually typed.
//
// WHICH OPERATORS. The census in docs/60-research/tenancy/v1-operator-census
// read 14 client projects and found 157 literal `find[field][$op]`
// occurrences: $gte 55, $eq 36, $lte 32, $gt 22, $lt 5, $ne 4, $exists 3, plus
// $or 2 and $and 1. Nothing in the corpus sends $where, $expr, $elemMatch or
// $near -- which is why refusing those is a security fix rather than a
// compatibility break.
//
// READ THE LIMIT WITH THE NUMBER. The census measured what client SOURCE
// contains. A filter assembled by string concatenation at runtime, or typed
// into a browser address bar, is invisible to it. It is a lower bound on the
// field set and a strong signal on the operator set -- the operator is almost
// always a literal even when the field and value are not -- and it is not
// proof that no deployment ever receives anything else.
//
// THE ACCEPT SET IS THE STORAGE SEAM'S ACCEPT SET, deliberately and exactly,
// and it is a SUPERSET of everything the census measured rather than a trim to
// it. Matching the seam is what stops this landing as the first of two
// narrowings: whatever this refuses today, the seam would have refused later.
//
// ONE OPERATOR IS REFUSED HERE THAT WORKS ON origin/dev TODAY:
//
//   $expr  -- reachable through /api/v1/profiles/ because profile.list_query
//             reaches the raw collection. It embeds the aggregation expression
//             language in a find filter, with $function and $accumulator held
//             out of it only by a denylist that enumerates them by name against
//             a language that grows each release; it cannot use an index; and
//             every future backend would owe an expression evaluator for it.
//
// $type IS THE ONE PLACE THIS SET DEPARTS FROM THE SEAM'S, and the departure is
// deliberate. The seam's AST cannot express $type, and an earlier draft of this
// file refused it on that ground alone. Then PR #8737 merged, and $type stopped
// being hypothetical: that branch added readTypeOperand() specifically so
// find[sgv][$type]=2 keeps reaching MongoDB as the NUMBER 2, because as the
// string "2" the server answers "Unknown type name alias: 2" and the request
// becomes an HTTP 500. It is code, a test and a measurement against mongod
// 3.6.8 and 7.0.43, shipped in the same release train as this change.
//
// Refusing it would therefore regress a fix that landed a week earlier, to gain
// nothing: $type executes nothing, evaluates nothing, and reads nothing outside
// the document -- it asks what BSON type a field holds. "Matches the seam" is a
// good tie-breaker and not a reason to undo a measured decision.
//
// CONSEQUENCE FOR THE SEAM, recorded so it is not rediscovered as a bug: when
// the storage seam lands, its AST must grow a $type node or v1 narrows by one
// operator at that point. That is the seam's cost, priced here.

// Comparison operators, as they are spelled inside a field's predicate object.
// $options is not a predicate: it is $regex's flag modifier.
const FIELD_OPERATORS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte',
  '$in', '$nin', '$regex', '$options', '$exists', '$type']);

// Logical operators, which are only meaningful at the top of a query document
// (or of a $and/$or branch). The seam's AST has group nodes for these two and
// no others -- notably not $nor, which it cannot express.
const LOGICAL_OPERATORS = new Set(['$and', '$or']);

function refuse (operator, where) {
  const error = new Error(
    'Query operator ' + operator + ' is not supported by the Nightscout API v1 ' +
    where + '. Supported operators: ' +
    [...LOGICAL_OPERATORS].join(' ') + ' (top level), ' +
    [...FIELD_OPERATORS].join(' ') + ' (on a field).');
  error.name = 'MongoQueryValidationError';
  error.operator = operator;
  error.status = error.statusCode = 400;
  throw error;
}

// A value that is data rather than a nested query document: a RegExp is a
// match predicate, a Date or an array or a driver value (ObjectId) is a
// literal, and so is a plain object with no $-prefixed keys -- {a: {b: 1}}
// matches the subdocument.
function isLiteralValue (value) {
  if (value === null || typeof value !== 'object') return true;
  if (value instanceof RegExp || value instanceof Date || Array.isArray(value)) return true;
  if (typeof value.toHexString === 'function' || value._bsontype !== undefined) return true;
  const keys = Object.keys(value);
  return keys.length > 0 && !keys.some(key => key.startsWith('$'));
}

// Walk one query document: the top level of `find`, or one branch of $and/$or.
function assertQueryDocument (filter) {
  if (filter === null || filter === undefined) return;
  if (typeof filter !== 'object' || Array.isArray(filter)) return;

  for (const key of Object.keys(filter)) {
    if (LOGICAL_OPERATORS.has(key)) {
      const branches = filter[key];
      if (Array.isArray(branches)) branches.forEach(assertQueryDocument);
      continue;
    }
    if (key.startsWith('$')) refuse(key, 'query');
    assertFieldPredicate(filter[key]);
  }
}

// Walk the right-hand side of `field: <here>`.
function assertFieldPredicate (value) {
  // VALUES ARE NOT RECURSED INTO. {payload: {$eq: {$where: 'literal'}}} asks
  // whether the stored document has a field literally named $where -- it is
  // data, not code, and MongoDB treats it as data too. Descending into it would
  // refuse a legitimate query, which is the one failure mode this guard must
  // not have. assert-no-query-javascript.js draws the same line.
  if (isLiteralValue(value)) return;

  for (const key of Object.keys(value)) {
    // A key in predicate position that is not an operator is not a field name
    // either: there is nowhere for it to go.
    if (!FIELD_OPERATORS.has(key)) refuse(key, 'field filter');
  }
}

module.exports = function assertAllowedQueryOperators (find) {
  assertQueryDocument(find);
  return find;
};

module.exports.FIELD_OPERATORS = FIELD_OPERATORS;
module.exports.LOGICAL_OPERATORS = LOGICAL_OPERATORS;
