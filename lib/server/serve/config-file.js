'use strict';

// The one size bound on a multitenant role's configuration file, and the one
// reader that enforces it. Every role's configuration (api, realtime and its
// admission list, evaluator, tenant-admin, admin, vcpool, the operation cohort)
// is read here. These files carry the static tenant roster (id, aliases, Vault
// key references, token file, settings): about 640 bytes per tenant in the api
// file, so the default of 1 MiB holds about 1,600 tenants. An operator with a
// larger roster raises the bound with MULTITENANT_CONFIG_MAX_BYTES; the value
// is itself bounded, so a read is never unbounded.
//
// The bound is checked twice: on the file's size before reading, and on the
// bytes actually read (the read stops one byte past the bound), so a file that
// grows between the two checks is still refused.
//
// Each refusal names its cause with a stable code, and never carries the
// file's contents (a JSON syntax error message quotes the text, so it is not
// passed on):
//   CONFIG_FILE_LIMIT_INVALID  MULTITENANT_CONFIG_MAX_BYTES is not a whole number in range
//   CONFIG_FILE_UNREADABLE     the file cannot be opened or stat'ed (the errno code is named)
//   CONFIG_FILE_NOT_REGULAR    the path is not a regular file, or was replaced while it was read
//   CONFIG_FILE_TOO_LARGE      over the bound (size and limit are named)
//   CONFIG_FILE_INVALID_JSON   the bytes are not valid UTF-8 JSON text
const fs = require('node:fs');

const ENV = 'MULTITENANT_CONFIG_MAX_BYTES';
const DEFAULT_MAX_BYTES = 1048576;
const MIN_MAX_BYTES = 65536;
const MAX_MAX_BYTES = 67108864;
const CHUNK_BYTES = 65536;

class ConfigFileError extends Error {
  constructor (code, message, detail = {}) {
    super(message);
    this.code = code;
    Object.assign(this, detail);
  }
}

function refuse (Type, code, message, detail) {
  const error = Type === ConfigFileError ? new ConfigFileError(code, message, detail) : new Type(message);
  if (Type !== ConfigFileError) Object.assign(error, { code, ...detail });
  return error;
}

// The bound in bytes from the role process's environment. Unset keeps the
// default; a set value outside [MIN_MAX_BYTES, MAX_MAX_BYTES] refuses the boot.
function maxBytes (source = process.env, Type = ConfigFileError) {
  const raw = source?.[ENV];
  if (raw === undefined || raw === '') return DEFAULT_MAX_BYTES;
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,9}$/.test(raw) || Number(raw) < MIN_MAX_BYTES || Number(raw) > MAX_MAX_BYTES) {
    throw refuse(Type, 'CONFIG_FILE_LIMIT_INVALID',
      'invalid ' + ENV + ': a whole number of bytes from ' + MIN_MAX_BYTES + ' to ' + MAX_MAX_BYTES + ' is required');
  }
  return Number(raw);
}

function unreadable (Type, label, error) {
  const errno = typeof error?.code === 'string' && /^E[A-Z0-9]{1,31}$/.test(error.code) ? error.code : 'EIO';
  return refuse(Type, 'CONFIG_FILE_UNREADABLE', label + ' cannot be read (' + errno + ')', { errno });
}
function tooLarge (Type, label, size, limit) {
  return refuse(Type, 'CONFIG_FILE_TOO_LARGE', label + ' is too large: ' + (size === null ? 'more than ' + limit : size) +
    ' bytes, over the limit of ' + limit + ' bytes (' + ENV + ')', { size, limit });
}

// readHandle is internal to atomic metadata caches. Its caller owns exactly
// one descriptor and must close it. Keeping the accepted inode open prevents
// inode reuse (ABA) between unobserved atomic publications.
// read(file, {source, label, Type}) -> Buffer of at most maxBytes(source) bytes.
// `Type` is the caller's own error class (constructed with a message); the
// stable code is set on it.
function readHandle (file, { source = process.env, label = 'configuration file', Type = ConfigFileError } = {}) {
  const limit = maxBytes(source, Type);
  if (typeof file !== 'string' || !file) throw refuse(Type, 'CONFIG_FILE_UNREADABLE', label + ' is not set');
  let stat;
  // Operator-selected path from the process environment; no request selects it.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  try { stat = fs.statSync(file); } catch (error) { throw unreadable(Type, label, error); }
  // A FIFO or device is refused before it is opened (opening one can block).
  if (!stat.isFile()) throw refuse(Type, 'CONFIG_FILE_NOT_REGULAR', label + ' is not a regular file');
  if (stat.size > limit) throw tooLarge(Type, label, stat.size, limit);
  let fd;
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  try { fd = fs.openSync(file, 'r'); } catch (error) { throw unreadable(Type, label, error); }
  let retained = false;
  try {
    let opened;
    try { opened = fs.fstatSync(fd); } catch (error) { throw unreadable(Type, label, error); }
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) {
      throw refuse(Type, 'CONFIG_FILE_NOT_REGULAR', label + ' was replaced while it was read');
    }
    // Read at most limit + 1 bytes: one byte past the bound proves it exceeded.
    const chunks = [];
    let total = 0;
    while (total <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, limit + 1 - total));
      let count;
      try { count = fs.readSync(fd, chunk, 0, chunk.length, null); } catch (error) { throw unreadable(Type, label, error); }
      if (!count) break;
      chunks.push(count === chunk.length ? chunk : chunk.subarray(0, count));
      total += count;
    }
    if (total > limit) throw tooLarge(Type, label, null, limit);
    // The cached identity and bytes come from this same open regular file.
    let identity;
    try { identity = fs.fstatSync(fd, { bigint: true }); } catch (error) { throw unreadable(Type, label, error); }
    let closed = false;
    const handle = { bytes: Buffer.concat(chunks, total), stat: identity,
      close () { if (!closed) { closed = true; fs.closeSync(fd); } } };
    retained = true;
    return handle;
  } finally {
    if (!retained) fs.closeSync(fd);
  }
}

function read (file, options) {
  const handle = readHandle(file, options);
  try { return handle.bytes; } finally { handle.close(); }
}

// JSON text -> value; a syntax error is refused without quoting the text.
function parse (text, { label = 'configuration file', Type = ConfigFileError } = {}) {
  try { return JSON.parse(Buffer.isBuffer(text) ? text.toString('utf8') : text); } catch {
    throw refuse(Type, 'CONFIG_FILE_INVALID_JSON', label + ' is not valid JSON');
  }
}

function readJson (file, options = {}) {
  return parse(read(file, options), options);
}

const CODES = Object.freeze(['CONFIG_FILE_LIMIT_INVALID', 'CONFIG_FILE_UNREADABLE', 'CONFIG_FILE_NOT_REGULAR',
  'CONFIG_FILE_TOO_LARGE', 'CONFIG_FILE_INVALID_JSON']);
// Whether an error is one of this reader's refusals (whatever its class), so a
// caller's catch-all can pass the named cause on instead of collapsing it.
const isRefusal = error => !!error && CODES.includes(error.code);

module.exports = { ENV, DEFAULT_MAX_BYTES, MIN_MAX_BYTES, MAX_MAX_BYTES, CODES, ConfigFileError, maxBytes, read, readHandle, parse, readJson, isRefusal };
