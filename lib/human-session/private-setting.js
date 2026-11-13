'use strict';

const fs = require('node:fs');
const LIMIT = 1048576;
const present = value => typeof value === 'string' && value.trim().length > 0;
const refuse = message => { throw Object.assign(new TypeError(message), { code: 'OIDC_CONFIGURATION_INVALID' }); };

function readPrivateFile (name, filename, limit) {
  let bytes;
  try {
    // Private operator-selected path from the process environment; no request
    // value can select it.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > limit) throw new Error();
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    bytes = fs.readFileSync(filename);
  } catch { refuse(name + ' must name a readable private file of at most ' + limit + ' bytes'); }
  if (bytes.length > limit) refuse(name + ' must name a readable private file of at most ' + limit + ' bytes');
  return bytes.toString('utf8');
}

// A private setting is given inline in NAME, or as a file path in NAME_FILE,
// exactly as LOOP_APNS_KEY carries a key inline. Setting both refuses at load.
// legacyPath(value) marks an inline value that is the earlier path form.
function privateSource (source, name, { legacyPath, limit = LIMIT } = {}) {
  const inline = source[name], file = source[name + '_FILE'];
  if (present(inline) && present(file)) refuse('Set ' + name + ' or ' + name + '_FILE, not both');
  if (present(file)) return { value: readPrivateFile(name + '_FILE', file, limit), filename: file };
  if (!present(inline)) return { value: undefined, filename: null };
  if (legacyPath && legacyPath(inline)) return { value: readPrivateFile(name, inline, limit), filename: inline };
  if (Buffer.byteLength(inline) > limit) refuse(name + ' is longer than ' + limit + ' bytes');
  return { value: inline, filename: null };
}

const privateSetting = (source, name, options) => privateSource(source, name, options).value;
const configured = (source, name) => present(source[name]) || present(source[name + '_FILE']);

module.exports = { privateSetting, privateSource, configured, refuse };
