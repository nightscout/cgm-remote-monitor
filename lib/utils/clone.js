'use strict';

const cloneShallow = require('./cloneShallow.js'); // Corrected path for sibling file

// Helper to get [[ToString]] tag.
const objectToString = Object.prototype.toString;
function getTag(value) {
  if (value == null) {
    return value === undefined ? '[object Undefined]' : '[object Null]';
  }
  return objectToString.call(value);
}

/**
 * Creates a deep clone of a `value`.
 * It recursively clones arrays and plain objects.
 * For other complex types like Date, RegExp, Map, Set, TypedArrays, etc.,
 * it utilizes `cloneShallow` to create a new instance with copied values/structure.
 * Functions are returned by reference.
 * Uncloneable values (like Error objects, DOM nodes) will result in an empty object `{}`
 * as per `cloneShallow`'s behavior.
 *
 * @template T
 * @param {T} value The value to clone.
 * @returns {T} A deep clone of the original value.
 */
function cloneDeep(value) {
  // 1. Handle primitives and null
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  // 2. Handle functions (return by reference)
  if (typeof value === 'function') {
    return value;
  }

  const tag = getTag(value);

  // 3. Handle Arrays (recurse)
  if (tag === '[object Array]') {
    const clonedArray = [];
    for (let i = 0; i < value.length; i++) {
      clonedArray[i] = cloneDeep(value[i]);
    }
    return /** @type {T} */ (clonedArray);
  }

  // 4. Handle plain Objects (recurse)
  // Check if it's a plain object. Custom class instances will be handled by cloneShallow.
  if (tag === '[object Object]') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
        const clonedObject = {};
        for (const key in value) {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
            clonedObject[key] = cloneDeep(value[key]);
            }
        }
        return /** @type {T} */ (clonedObject);
    }
    // If not a plain object (e.g., instance of a custom class with [object Object] tag but different prototype),
    // fall through to cloneShallow.
  }

  // 5. Handle Map (recurse for values, keys are typically primitive or handled by cloneDeep if complex)
  if (tag === '[object Map]') {
    const clonedMap = new Map();
    value.forEach((mapValue, mapKey) => {
      // Assuming keys are typically primitive or don't need deep cloning themselves in this context.
      // If keys can be complex objects needing deep clone, mapKey should also be cloneDeep(mapKey).
      clonedMap.set(mapKey, cloneDeep(mapValue));
    });
    return /** @type {T} */ (clonedMap);
  }

  // 6. Handle Set (recurse for values)
  if (tag === '[object Set]') {
    const clonedSet = new Set();
    value.forEach(setValue => {
      clonedSet.add(cloneDeep(setValue));
    });
    return /** @type {T} */ (clonedSet);
  }

  // 7. For all other object types, use cloneShallow.
  // This includes Date, RegExp, TypedArrays, ArrayBuffer, custom class instances not caught above,
  // Error objects (which become {}), etc.
  return cloneShallow(value);
}

module.exports = cloneDeep;
