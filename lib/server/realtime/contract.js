'use strict';

const { createHash } = require('node:crypto');
const configFile = require('../serve/config-file');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys, optional = []) => object(v) && keys.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => keys.includes(k) || optional.includes(k));
const integer = (n, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= 1 && n <= max;
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const canonical = v => Array.isArray(v) ? v.map(canonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const identity = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
// Bounded read (MULTITENANT_CONFIG_MAX_BYTES, lib/server/serve/config-file.js).
// A refusal carries the reader's stable code (CONFIG_FILE_TOO_LARGE, ...) with
// the code first in its message, as fail() does; callers pass it on.
const refusal = error => Object.assign(new Error(error.code + ': ' + error.message), { code: error.code,
  ...(error.size !== undefined ? { size: error.size, limit: error.limit } : {}), ...(error.errno ? { errno: error.errno } : {}) });
// options: {label, source} (source: the environment holding the bound; default process.env).
function text (name, { label = 'realtime configuration file', source = process.env } = {}) {
  if (typeof name !== 'string' || !name) fail('REALTIME_CONFIG_REFUSED');
  try { return configFile.read(name, { label, source }).toString('utf8'); } catch (error) { throw configFile.isRefusal(error) ? refusal(error) : error; }
}
function json (current, { label = 'realtime configuration file' } = {}) {
  try { return configFile.parse(current, { label }); } catch (error) { throw refusal(error); }
}
function file (name, options) { return json(text(name, options), options); }
// The file is read on every call (a change is seen at once), but parsed only
// when its text differs from the last accepted text. Measured: one parse of a
// 1,000-tenant realtime configuration costs 85 ms, and it ran several times
// per refresh and once per detection tick.
function parsedFile (name, parse, options) {
  let last = null, value;
  return () => {
    const current = text(name, options);
    if (current !== last) { value = parse(json(current, options)); last = current; }
    return value;
  };
}
function reference (name, source) {
  if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || typeof source[name] !== 'string' || !source[name]) fail('REALTIME_CONFIG_REFUSED');
  return source[name];
}
module.exports = { isConfigFileRefusal: configFile.isRefusal, fail, object, exact, integer, uuid, identity, file, parsedFile, reference };
