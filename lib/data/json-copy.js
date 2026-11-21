'use strict';

// A deep copy with exactly the result of JSON.parse(JSON.stringify(value)),
// without building the text. Plain data (objects whose prototype is
// Object.prototype or null, arrays, strings, finite numbers, booleans, null)
// is copied directly; anything JSON.stringify treats specially (a toJSON
// method, a Date, an ObjectId, a boxed primitive, a bigint, a cycle) is handed
// to the JSON round trip, so it gives the same value or throws the same error.
//
// JSON rules kept on the direct path:
//   - undefined, functions and symbols: dropped as object members, null in arrays
//   - NaN, Infinity, -Infinity: null; -0: 0
//   - only own enumerable string keys, in Object.keys order
//   - a "__proto__" member stays an own data member (JSON.parse defines it)
//   - sparse array holes: null
//
// The copy shares nothing with its source.

const objectProto = Object.prototype;

function roundTrip (value) {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
}

const FALLBACK = Symbol('json-copy fallback');

function member (value, inArray, depth) {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (value === 0) return 0; // -0 serialises as 0
      return Number.isFinite(value) ? value : null;
    case 'undefined':
    case 'function':
    case 'symbol':
      return inArray ? null : undefined;
    case 'bigint':
      return FALLBACK;
    default:
      if (value === null) return null;
      return copyObject(value, depth + 1);
  }
}

function copyObject (value, depth) {
  // Deep or cyclic structures: let JSON report them as it would.
  if (depth > 512) return FALLBACK;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || typeof value.toJSON === 'function') return FALLBACK;
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const v = member(value[i], true, depth);
      if (v === FALLBACK) return FALLBACK;
      out[i] = v;
    }
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if ((proto !== objectProto && proto !== null) || typeof value.toJSON === 'function') return FALLBACK;
  const out = {};
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const v = member(value[key], false, depth);
    if (v === FALLBACK) return FALLBACK;
    if (v === undefined) continue;
    if (key === '__proto__') Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
    else out[key] = v;
  }
  return out;
}

function jsonCopy (value) {
  if (value === null || typeof value !== 'object') return roundTrip(value);
  const out = copyObject(value, 0);
  return out === FALLBACK ? roundTrip(value) : out;
}

/**
 * Freeze a value and everything it contains (plain data only).
 * @param {*} value
 * @returns {*} the same value, frozen
 */
function deepFreeze (value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

module.exports = jsonCopy;
module.exports.jsonCopy = jsonCopy;
module.exports.roundTrip = roundTrip;
module.exports.deepFreeze = deepFreeze;
