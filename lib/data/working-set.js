'use strict';

// A materialised working set kept between evaluations (evaluator cost lane,
// candidate B), and the copies handed out from it.
//
// The plugins change the working set they are given (lib/client-core/
// devicestatus/loop.js attaches moments to each status; pump.js writes
// clockMills; the sandbox replaces profiles), so the kept set is never handed
// out: keep() takes a frozen copy, and every evaluation gets copy(), its own.
//
// A copy is exact for plain data only: objects whose prototype is
// Object.prototype or null, arrays, and primitives (undefined, NaN and -0
// included, which a JSON copy would change). keep() returns null for anything
// else, and the caller loads afresh instead. Sharing is kept: the loader puts
// the same treatment in ddata.treatments and in sitechangeTreatments (and the
// other per-kind lists), so a copy holds one copy of it in both places, as a
// fresh load holds one object.

const FAIL = Symbol('not plain');

function plain (value, seen) {
  if (value === null || typeof value !== 'object') return typeof value === 'function' || typeof value === 'symbol' ? FAIL : value;
  if (seen.has(value)) return seen.get(value); // shared (or cyclic): one copy
  if (Object.getOwnPropertySymbols(value).length) return FAIL;
  const names = Object.getOwnPropertyNames(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return FAIL;
    const out = new Array(value.length);
    seen.set(value, out);
    for (const name of names) {
      if (name === 'length') continue;
      const index = Number(name);
      const d = Object.getOwnPropertyDescriptor(value, name);
      if (!Number.isInteger(index) || String(index) !== name || !('value' in d) || !d.enumerable) return FAIL;
      const v = plain(d.value, seen);
      if (v === FAIL) return FAIL;
      out[index] = v;
    }
    return Object.freeze(out);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return FAIL;
  const out = proto === null ? Object.create(null) : {};
  seen.set(value, out);
  for (const name of names) {
    const d = Object.getOwnPropertyDescriptor(value, name);
    if (!('value' in d) || !d.enumerable || !d.writable || !d.configurable) return FAIL;
    const v = plain(d.value, seen);
    if (v === FAIL) return FAIL;
    Object.defineProperty(out, name, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return Object.freeze(out);
}

/**
 * A frozen plain copy of a working set's data members (its methods are
 * re-created with each copy), or null when it holds anything not plain.
 * @param {Object} ddata a lib/data/ddata.js working set
 * @returns {Object|null}
 */
function keep (ddata) {
  const seen = new Map();
  const data = {};
  for (const key of Object.keys(ddata)) {
    if (typeof ddata[key] === 'function') continue;
    const v = plain(ddata[key], seen);
    if (v === FAIL) return null;
    data[key] = v;
  }
  return Object.freeze(data);
}

function thaw (value, seen) {
  if (value === null || typeof value !== 'object') return value;
  let out = seen.get(value);
  if (out) return out;
  if (Array.isArray(value)) {
    out = new Array(value.length);
    seen.set(value, out);
    for (let i = 0; i < value.length; i++) if (i in value) out[i] = thaw(value[i], seen);
    return out;
  }
  out = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
  seen.set(value, out);
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === '__proto__') Object.defineProperty(out, key, { value: thaw(value[key], seen), enumerable: true, writable: true, configurable: true });
    else out[key] = thaw(value[key], seen);
  }
  return out;
}

/**
 * A working set of its own: a new ddata (from createData) holding a mutable
 * copy of every kept data member.
 * @param {Object} kept from keep()
 * @param {Function} createData () -> a fresh ddata
 */
function copy (kept, createData) {
  const ddata = createData();
  const seen = new Map();
  for (const key of Object.keys(kept)) ddata[key] = thaw(kept[key], seen);
  return ddata;
}

module.exports = { keep, copy };
