'use strict';

const fs = require('node:fs');
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
// Reuse a parsed file only while its filesystem identity and byte limit are
// unchanged. An edit/replacement or a refused read must never preserve cached
// authority. Parsing (including roster validation) stays off the unchanged path.
function parsedFile (name, parse, options) {
  let last = null, value, acceptedKey = null;
  return () => {
    let limit;
    try { limit = configFile.maxBytes(options?.source); } catch (error) { throw refusal(error); }
    let key = null;
    try {
      // Operator-selected config path, never request input.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const stat = fs.statSync(name, { bigint: true });
      if (stat.isFile()) key = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, limit].join(':');
    } catch { /* The bounded reader below supplies the stable refusal code. */ }
    if (key !== null && key === acceptedKey) return value;
    const current = text(name, options);
    if (current !== last) { value = parse(json(current, options)); last = current; }
    acceptedKey = key;
    return value;
  };
}

function reference (name, source) {
  if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || typeof source[name] !== 'string' || !source[name]) fail('REALTIME_CONFIG_REFUSED');
  return source[name];
}
module.exports = { isConfigFileRefusal: configFile.isRefusal, fail, object, exact, integer, uuid, identity, file, parsedFile, reference };
