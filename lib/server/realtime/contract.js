'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys, optional = []) => object(v) && keys.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => keys.includes(k) || optional.includes(k));
const integer = (n, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= 1 && n <= max;
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const canonical = v => Array.isArray(v) ? v.map(canonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const identity = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
function file (name) {
  if (typeof name !== 'string' || !name) fail('REALTIME_CONFIG_REFUSED');
  const stat = fs.statSync(name);
  if (!stat.isFile() || stat.size > 1048576) fail('REALTIME_CONFIG_REFUSED');
  const bytes = fs.readFileSync(name); if (bytes.length > 1048576) fail('REALTIME_CONFIG_REFUSED');
  return JSON.parse(bytes.toString('utf8'));
}
function reference (name, source) {
  if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || typeof source[name] !== 'string' || !source[name]) fail('REALTIME_CONFIG_REFUSED');
  return source[name];
}
module.exports = { fail, object, exact, integer, uuid, identity, file, reference };
