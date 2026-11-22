'use strict';

// Request-body size policy for the routes that take bulk uploads: entries,
// treatments and device status. One operator setting, UPLOAD_BODY_LIMIT,
// default 50mb, the limit entries and treatments have carried since before
// 15.0. Loop sends device status 50 records at a time, each batch sized to
// about 1 MB, so device status's former 1 MB limit was the edge of normal use.
//
// The parsers run before authorization, so this is also how much one
// unauthenticated request can make the server buffer and parse.

const DEFAULT_UPLOAD = 50 * 1024 * 1024;
const UNITS = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 };
const MAX = UNITS.gb;

// Reads the body-parser byte format ('50mb', '512kb', '1048576'). Anything else,
// including zero, a negative value or more than 1gb, returns null. body-parser
// throws at construction on a limit it cannot parse (tests/dependency-express),
// which would stop the server starting over a typo in one setting.
function parseBytes (value) {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 && value <= MAX ? value : null;
  if (typeof value !== 'string') return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(value);
  if (!match) return null;
  const bytes = Math.floor(parseFloat(match[1]) * UNITS[(match[2] || 'b').toLowerCase()]);
  return bytes > 0 && bytes <= MAX ? bytes : null;
}

// An operator setting, never a tenant one: lib/server/env.js reads it into
// env.uploadBodyLimit, and an env built without it (a multitenant tenant's,
// a test's) falls back to the process environment.
function bodyLimits (env) {
  const configured = env && env.uploadBodyLimit != null ? env.uploadBodyLimit : process.env.UPLOAD_BODY_LIMIT;
  let upload = DEFAULT_UPLOAD;
  if (configured !== undefined && configured !== null) {
    const parsed = parseBytes(configured);
    if (parsed === null) {
      console.warn('UPLOAD_BODY_LIMIT=' + JSON.stringify(configured) + ' is not a size Nightscout can read '
        + '(for example 50mb, 512kb or 1048576, at most 1gb); using the default, 50mb.');
    } else {
      upload = parsed;
    }
  }
  return { upload };
}

bodyLimits.parseBytes = parseBytes;
bodyLimits.DEFAULT_UPLOAD = DEFAULT_UPLOAD;
module.exports = bodyLimits;
