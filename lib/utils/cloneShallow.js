'use strict';

const toString = Object.prototype.toString;

/**
 * Gets the `toStringTag` of `value`.
 * @private
 * @param {*} value The value to query.
 * @returns {string} Returns the `toStringTag`.
 */
function getTag(value) {
  if (value == null) {
    return value === undefined ? '[object Undefined]' : '[object Null]';
  }
  return toString.call(value);
}

/**
 * Creates a shallow clone of a `value`.
 *
 * **Note:** This method supports cloning arrays, array buffers, booleans, date objects, maps,
 * numbers, Object objects, regexes, sets, strings, symbols, and typed arrays.
 * The own enumerable properties of `arguments` objects are cloned as plain objects.
 * An empty object is returned for uncloneable values such as error objects,
 * functions, DOM nodes, and WeakMaps.
 *
 * @template T
 * @param {T} value The value to clone.
 * @returns {T | {}} A shallow clone of the value, or an empty object for uncloneable values.
 */
function cloneShallow(value) {
  const type = typeof value;

  // Handle primitives (including symbols) and null
  if (type !== 'object' && type !== 'function') {
    return value; // Numbers, strings, booleans, undefined, symbols, bigint
  }
  if (value === null) {
    return null;
  }

  const tag = getTag(value);

  // Handle uncloneable types by returning an empty object
  if (
    tag === '[object Error]' ||
    tag === '[object Function]' ||
    tag === '[object WeakMap]' ||
    (typeof value.nodeType === 'number' && typeof value.cloneNode === 'function') // Basic DOM node check
  ) {
    return {};
  }

  const Ctor = value.constructor;

  // Handle specific cloneable types
  switch (tag) {
    case '[object Arguments]': {
      const plainObjectForArgs = {};
      for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          plainObjectForArgs[key] = value[key];
        }
      }
      return plainObjectForArgs;
    }

    case '[object ArrayBuffer]': {
      const result = new Ctor(value.byteLength);
      new Uint8Array(result).set(new Uint8Array(value));
      return result;
    }

    case '[object Boolean]':
    case '[object Date]':
    case '[object Number]':
    case '[object RegExp]':
    case '[object String]':
      return new Ctor(value.valueOf());

    case '[object Symbol]': // Symbol wrapper objects
      return Object(Symbol.prototype.valueOf.call(value));

    case '[object Int8Array]':
    case '[object Uint8Array]':
    case '[object Uint8ClampedArray]':
    case '[object Int16Array]':
    case '[object Uint16Array]':
    case '[object Int32Array]':
    case '[object Uint32Array]':
    case '[object Float32Array]':
    case '[object Float64Array]':
    case '[object BigInt64Array]':
    case '[object BigUint64Array]':
      return new Ctor(value);

    case '[object Map]': {
      const mapResult = new Ctor();
      value.forEach((v, k) => {
        mapResult.set(k, v);
      });
      return mapResult;
    }

    case '[object Set]': {
      const setResult = new Ctor();
      value.forEach((v) => {
        setResult.add(v);
      });
      return setResult;
    }
  }

  // Handle Arrays
  if (Array.isArray(value)) {
    return value.slice();
  }

  // Handle other Objects (plain objects and custom class instances)
  if (type === 'object') {
    let result;
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      result = Object.create(proto);
    } else if (typeof Ctor === 'function') {
      try {
        result = new Ctor();
      } catch (e) {
        result = Object.create(proto);
      }
    } else {
      result = Object.create(proto);
    }
    return Object.assign(result, value);
  }

  // Fallback for any unhandled cases (should be rare)
  return {};
}

module.exports = cloneShallow;
