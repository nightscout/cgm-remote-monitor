'use strict';

/**
 * @module query coercion
 *
 * Every value in an HTTP query string arrives as text. Deciding that
 * `find[insulin][$gte]=1.5` means the number 1.5 and not the string "1.5"
 * requires knowing the field's declared type, so this module pairs a
 * generated field->type table with the small number of conversions the query
 * layer performs.
 *
 * The table in `query-coercion.json` is generated from the collection schemas
 * and must not be edited by hand; the header inside it names the generator.
 * Coercion lives here rather than in a storage driver because it is the step
 * that turns text into a typed value, which every backend needs and none
 * should redefine.
 */

const TABLE = require('./query-coercion.json');

/**
 * Operators whose operand is not a value drawn from the field's domain.
 * `{$exists: 'true'}` asks a yes/no question and `{$regex: '^a'}` carries a
 * pattern; a numeric conversion destroys both. `{$regex: NaN}` is an error --
 * "$regex has to be a string". `{$exists: NaN}` is NOT inverted: MongoDB's
 * numeric truthiness is `value != 0`, and NaN != 0, so it reads as true.
 * Measured on mongod 3.6.8 and 7.0.43.
 */
const NON_VALUE_OPERATORS = {
  $exists: true, $type: true, $regex: true, $options: true, $where: true,
  $expr: true, $text: true, $comment: true, $jsonSchema: true
};

/**
 * Operators whose operand has a type of its own, unrelated to the field's.
 *
 * `$type` takes a BSON type code or its string alias, so a digits-only operand
 * is a CODE and has to reach the server as a number. Leaving it as text is an
 * error, not a harmless pass-through: `{$type: "2"}` is rejected with "Unknown
 * type name alias: 2", where `{$type: 2}` is a valid query. Aliases such as
 * "number" are already correct and are left alone.
 *
 * This exists because leaving every non-value operand untouched WAS a
 * regression for this one. `origin/dev` coerced the operand along with
 * everything else, so `find[sgv][$type]=2` became `{$type: 2}` and worked;
 * excluding it without reading it would have turned a working request into an
 * HTTP 500. Measured on mongod 3.6.8 and 7.0.43.
 */
const OPERAND_READERS = { $type: readTypeOperand };

/**
 * Read a `$type` operand: digits are a BSON type code, anything else is an
 * alias and is passed through.
 *
 * @param {*} value The operand as it arrived.
 * @returns {*} A number for a digits-only string, otherwise `value`.
 */
function readTypeOperand (value) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) { return value; }
  return Number(value);
}

/**
 * The reader for the operand at `path`, or null when the nearest enclosing
 * operator has none and the operand should be left exactly as it arrived --
 * which is the right answer for `$regex`, `$options`, `$where` and the rest.
 *
 * @param {Array} path Key path from the field's fragment to the leaf.
 * @returns {?function}
 */
function operandReaderFor (path) {
  for (let i = path.length - 1; i >= 0; i--) {
    const key = path[i];
    if (typeof key === 'string' && key.charAt(0) === '$') {
      return OPERAND_READERS[key] || null;
    }
  }
  return null;
}

/**
 * Parse a numeric bound without truncating it. Applied to `integer` fields as
 * well as `number` ones: the value being converted is a *bound*, not a stored
 * value, and `$gte=1.5` on an integer field means "2 and above", which a
 * truncation to 1 gets wrong in the other direction.
 *
 * A value that will not parse becomes NaN, matching what the hand-maintained
 * `parseInt` walkers did with the same input.
 */
function toNumber (value) {
  if (typeof value !== 'string') { return value; }
  return parseFloat(value);
}

/**
 * Only the two spellings a query string can plausibly mean. Anything else is
 * passed through untouched rather than guessed at.
 */
function toBoolean (value) {
  if (typeof value !== 'string') { return value; }
  const lowered = value.toLowerCase();
  if (lowered === 'true') { return true; }
  if (lowered === 'false') { return false; }
  return value;
}

const COERCERS = {
  integer: toNumber
  , number: toNumber
  , boolean: toBoolean
};

/**
 * The conversion to apply to `field` in `collection`, or null when the schema
 * declares nothing usable for it. Fields the table omits keep today's
 * behaviour: the value stays a string.
 *
 * @param {string} collection Collection name, eg 'treatments'.
 * @param {string} field Field name as it appears in the query, dotted for
 *   nested fields, eg 'uploader.battery'.
 * @returns {?function} Conversion function, or null.
 */
function coercerFor (collection, field) {
  const fields = collection && TABLE.collections[collection];
  if (!fields) { return null; }
  if (!Object.prototype.hasOwnProperty.call(fields, field)) { return null; }
  return COERCERS[fields[field]] || null;
}

/**
 * Whether a leaf reached at `path` inside a field's query fragment holds a
 * value to convert. The nearest enclosing `$operator` decides; array indices
 * under `$in` are looked through, so `{$in: ['1','2']}` converts both.
 *
 * @param {Array} path Key path from the field's fragment to the leaf.
 * @returns {boolean}
 */
function isValueLeaf (path) {
  for (let i = path.length - 1; i >= 0; i--) {
    const key = path[i];
    if (typeof key === 'string' && key.charAt(0) === '$') {
      return !NON_VALUE_OPERATORS[key];
    }
  }
  return true;
}

/**
 * Whether the schema declares any coercible field for a collection. Used to
 * tell "this collection has no typed fields" from "this collection is not in
 * the table at all"; both leave values alone, only one is a gap.
 *
 * @param {string} collection
 * @returns {boolean}
 */
function knows (collection) {
  return Object.prototype.hasOwnProperty.call(TABLE.collections, collection);
}

module.exports = {
  coercerFor: coercerFor
  , isValueLeaf: isValueLeaf
  , operandReaderFor: operandReaderFor
  , readTypeOperand: readTypeOperand
  , knows: knows
  , toNumber: toNumber
  , toBoolean: toBoolean
  , table: TABLE
};
