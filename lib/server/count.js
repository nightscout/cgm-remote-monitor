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
 * Was a `count` supplied at all? An absent or empty one means "use the
 * endpoint's default", which is not an error.
 * @param {any} value - the value supplied for `count`
 */
function hasCount (value) {
  return value !== undefined && value !== null && value !== '';
}


/**
 * Apply `opts.count` to a cursor, if it names a number of documents.
 * @param {Object} cursor - a mongodb cursor
 * @param {Object} opts - query options carrying an optional `count`
 */
function applyCount (cursor, opts) {
  const count = parseCount(opts && opts.count);
  return count === null ? cursor : cursor.limit(count);
}


module.exports = {
  parseCount,
  hasCount,
  applyCount
};
