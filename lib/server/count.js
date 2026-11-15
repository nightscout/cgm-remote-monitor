'use strict';

/**
 * The API's `count` parameter, which every v1 read uses to say how many
 * documents it wants.
 *
 * It arrives as a string from the query string, and `parseInt` will turn most
 * things into some number: `'0'` into `0`, `'1e2'` into `1`, `'abc'` into
 * `NaN`. None of those is the number the client wrote, and `0` is worse than
 * wrong - MongoDB defines `.limit(0)` as *no limit*, so a request for zero
 * documents is answered with the whole collection.
 *
 * Zero is therefore a count of its own: it is a valid request, and its answer
 * is no documents, which the driver has no way to express as a limit.
 */

/**
 * Read a `count` as a number of documents.
 * @param {any} value - the value supplied for `count`
 * @returns {number|null} a positive whole number, or null if it is not one
 */
function parseCount (value) {

  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  if (typeof value !== 'string' || !/^\s*\d+\s*$/.test(value)) {
    return null;
  }

  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}


/**
 * Does a `count` ask for zero documents? Written with the same digits rule as
 * `parseCount`, so `'0'` and `'00'` are zero and `'0x10'` or `'-0'` are not.
 * @param {any} value - the value supplied for `count`
 */
function isZeroCount (value) {
  if (typeof value === 'number') {
    return value === 0;
  }
  return typeof value === 'string' && /^\s*0+\s*$/.test(value);
}


/**
 * Was a `count` supplied at all? An absent or empty one means "use the
 * endpoint's default", which is not an error.
 * @param {any} value - the value supplied for `count`
 */
function hasCount (value) {
  return value !== undefined && value !== null && value !== '';
}


/**
 * The count oref0 sends. Its `ns-get.sh` appends its credential to the query
 * with a second `?`, so `count=1` arrives as `1?<credential>` or
 * `1?token=<token>`. 15.0.8 read the leading number, and this reads it the
 * same way - but only when the number is followed by `?`, so every other
 * spelling `parseInt` used to guess at is still refused.
 * @param {any} value - the value supplied for `count`
 * @returns {string|null} the leading whole number, or null for any other shape
 */
function leadingCount (value) {
  if (typeof value !== 'string') {
    return null;
  }
  const found = /^\s*(\d+)\?/.exec(value);
  return found ? found[1] : null;
}


// The fields a v1 `find` can bound in time.
const DATE_FIELDS = ['date', 'dateString', 'created_at', 'mills', 'sysTime', 'startDate', 'srvCreated', 'srvModified'];

/**
 * Does a v1 `find` bound one date field from both sides? A `count=0` read
 * with such a window is answered with everything in it, as 15.0.8 answered
 * it; GluPredKit asks for a date range this way.
 * @param {any} find - the `find` object from the query string
 */
function hasDateWindow (find) {
  if (!find || typeof find !== 'object') {
    return false;
  }
  return DATE_FIELDS.some(function bounded (field) {
    const range = find[field];
    if (!range || typeof range !== 'object') {
      return false;
    }
    const lower = range.$gte !== undefined || range.$gt !== undefined;
    const upper = range.$lte !== undefined || range.$lt !== undefined;
    return lower && upper;
  });
}


// The count a `count=0` read with a date window is given: no limit in
// practice, written as a number every read path already handles. It is the
// largest limit that fits the 32-bit integer MongoDB stores a limit in.
const NO_LIMIT_COUNT = '2147483647';


// What a zero count reads instead of a cursor. Every `list()` helper ends its
// chain with `.toArray()`, and must not reach the driver at all, because the
// only limit that could stand for zero is `.limit(0)`, which means *no limit*.
const NO_DOCUMENTS = Object.freeze({
  toArray: function toArray ( ) { return Promise.resolve([ ]); }
});


/**
 * Apply `opts.count` to a cursor, if it names a number of documents.
 * A count of zero answers with no documents rather than an unbounded read.
 * @param {Object} cursor - a mongodb cursor
 * @param {Object} opts - query options carrying an optional `count`
 */
function applyCount (cursor, opts) {
  if (isZeroCount(opts && opts.count)) {
    return NO_DOCUMENTS;
  }
  const count = parseCount(opts && opts.count);
  return count === null ? cursor : cursor.limit(count);
}


module.exports = {
  parseCount,
  isZeroCount,
  hasCount,
  leadingCount,
  hasDateWindow,
  NO_LIMIT_COUNT,
  applyCount
};
