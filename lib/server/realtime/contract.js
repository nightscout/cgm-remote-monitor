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
// Operator hot files support arbitrary in-place edits, even when filesystem
// timestamps collide. Read bounded bytes each time, but parse unchanged text once.
// Atomic machine publications may opt into metadata caching; see placement.
const release = state => {
  const handle = state.handle;
  state.handle = null; state.key = null;
  if (handle) handle.close();
};
// Explicit owner close is primary; this only protects abandoned reader objects.
const abandonedReaders = new globalThis.FinalizationRegistry(release);
const statKey = (stat, limit) => stat.isFile() ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, limit].join(':') : null;
function parsedFile (name, parse, options) {
  const atomic = options?.publication === 'atomic';
  if (options?.publication !== undefined && !atomic) fail('REALTIME_CONFIG_REFUSED');
  const state = { handle: null, key: null, closed: false };
  let last = null, value;
  const read = () => {
    if (state.closed) fail('REALTIME_CONFIG_REFUSED');
    let candidate;
    try {
      let limit;
      if (atomic) {
        limit = configFile.maxBytes(options?.source);
        let key = null;
        // Follow valid deployment symlinks: the accepted target inode is pinned.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        try { key = statKey(fs.statSync(name, { bigint: true }), limit); } catch { /* Bounded reader names the refusal. */ }
        if (key !== null && key === state.key) return value;
        release(state);
        candidate = configFile.readHandle(name, options);
      }
      const current = atomic ? candidate.bytes.toString('utf8') : text(name, options);
      if (current !== last) { value = parse(json(current, options)); last = current; }
      if (atomic) {
        release(state);
        candidate.bytes = null;
        state.handle = candidate; state.key = statKey(candidate.stat, limit); candidate = null;
      }
      return value;
    } catch (error) {
      release(state);
      throw error instanceof configFile.ConfigFileError ? refusal(error) : error;
    } finally { if (candidate) candidate.close(); }
  };
  read.close = () => { state.closed = true; abandonedReaders.unregister(state); release(state); };
  if (atomic) abandonedReaders.register(read, state, state);
  return read;
}

function reference (name, source) {
  if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || typeof source[name] !== 'string' || !source[name]) fail('REALTIME_CONFIG_REFUSED');
  return source[name];
}
module.exports = { isConfigFileRefusal: configFile.isRefusal, fail, object, exact, integer, uuid, identity, file, parsedFile, reference };
