'use strict';

const LIMIT = 8192;

// Diagnostic URLs never need credentials, queries or fragments. Drop the whole
// query rather than maintaining a list of every possible credential spelling.
function urlForLog (value) {
  if (typeof value !== 'string') return '[invalid URL]';
  if (['inline', 'eval', 'self', 'none'].includes(value)) return value;
  try {
    const absolute = /^https?:\/\//i.test(value);
    const parsed = new URL(value, 'http://nightscout.invalid');
    if (!['http:', 'https:'].includes(parsed.protocol)) return parsed.protocol;
    const pathname = parsed.pathname.replace(/(\/authorization\/request\/)[^/]+/ig, '$1[REDACTED]');
    return ((absolute ? parsed.origin : '') + pathname).slice(0, 2048);
  } catch {
    return '[invalid URL]';
  }
}

// Every spelling of a credential that may appear in diagnostic text, longest
// first so a longer value is matched before a shorter one it contains.
function credentialSpellings (values) {
  const credentials = new Set();
  for (const value of values.flat()) {
    if (typeof value !== 'string' || !value) continue;
    credentials.add(value);
    try { credentials.add(encodeURIComponent(value)); } catch {
      // An invalid Unicode scalar must not break error handling.
    }
    credentials.add(JSON.stringify(value).slice(1, -1));
    if (/^Bearer /i.test(value) && value.length > 7) credentials.add(value.slice(7));
  }
  return [...credentials].sort((a, b) => b.length - a.length);
}

// Redact lines that contain a credential and strip queries, fragments and
// legacy token paths from every URL in the text.
function redactText (value, secrets) {
  // Redact whole sensitive lines before parsing URLs: replacing a credential
  // such as "/" inside a URL could otherwise hide its scheme from redaction.
  if (secrets.some(secret => /[\r\n]/.test(secret) && value.includes(secret))) return '[REDACTED]';
  return value.split('\n').map(function (line) {
    if (secrets.some(secret => line.includes(secret))) return '[REDACTED]';
    // Tokenization avoids backtracking on long relative paths without a query.
    return line.replace(/[^\s"'<>]+/g, function (word) {
      const absolute = word.search(/https?:\/\/|mongodb(?:\+srv)?:\/\//i);
      const slash = word.indexOf('/');
      if (slash >= 0 && (absolute < 0 || slash < absolute) &&
          (word.includes('?') || word.includes('#') || /\/authorization\/request\//i.test(word))) {
        return word.slice(0, slash) + urlForLog(word.slice(slash));
      }
      if (absolute >= 0) return word.slice(0, absolute) + urlForLog(word.slice(absolute));
      return word;
    });
  }).join('\n');
}

function errorForLog (error, req) {
  const query = req.query || {};
  const headers = req.headers || {};
  const values = [query.token, query.secret, headers['api-secret'], headers.authorization,
    req.api_secret, req.auth_token, req.params && req.params.accessToken];
  const pathToken = /\/authorization\/request\/([^/?#]+)/i.exec(req.originalUrl || req.url || '');
  if (pathToken) {
    values.push(pathToken[1]);
    try { values.push(decodeURIComponent(pathToken[1])); } catch {
      // A malformed path still has its raw value redacted.
    }
  }
  const secrets = credentialSpellings(values);
  function text (value) {
    if (typeof value !== 'string') return undefined;
    if (value.length > LIMIT) return '[oversized diagnostic omitted]';
    return redactText(value, secrets).slice(0, LIMIT);
  }
  return {
    name: text(error && error.name),
    code: typeof (error && error.code) === 'number' ? error.code : text(error && error.code),
    message: text(error && error.message),
    stack: text(error && error.stack)
  };
}

// Field names whose values are credentials wherever they appear in a record.
const CREDENTIAL_FIELD = /^(?:secret|api[-_]?secret|token|access[-_]?token|auth[-_]?token|authorization|jwt|password)$/i;

// A summary value as one bounded line: a client controls these strings.
function field (value) {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'object') {
    return typeof value.toHexString === 'function' ? value.toHexString() : '[' + (Array.isArray(value) ? 'array' : 'object') + ']';
  }
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 128);
}

function reference (record) {
  return record.identifier || record._id || record.created_at || record.date;
}

function summarize (record, ref) {
  if (Array.isArray(record)) return 'items=' + record.length;
  if (record !== null && typeof record === 'object') {
    let text = 'ref=' + field(ref !== undefined ? ref : reference(record));
    if (record.eventType !== undefined) text += ' eventType=' + field(record.eventType);
    return text;
  }
  if (ref !== undefined) return 'ref=' + field(ref);
  return 'record=' + (record === null ? 'null' : typeof record);
}

function payloadJSON (payload) {
  try {
    const json = JSON.stringify(payload, function (key, value) {
      return key && CREDENTIAL_FIELD.test(key) && value !== null && value !== undefined ? '[REDACTED]' : value;
    });
    return json === undefined ? String(payload) : json;
  } catch {
    return '[unserializable payload]';
  }
}

// The one gate for record payloads in the server log: DEBUG_LOGGING
// (env.debug.logging). Every recordForLog caller reads it through here.
function debugLogging (env) {
  return Boolean(env && env.debug && env.debug.logging);
}

/**
 * One log line for a record a client wrote or tried to write.
 *
 * Without debug it is a summary only: the operation, collection, client id,
 * the record's reference (identifier, _id, created_at or date) and eventType,
 * or the item count of an array. Record values are health data, so the whole
 * payload is appended only when DEBUG_LOGGING is on (`debug: true`).
 *
 * `untrusted: true` is for lines about a refused or invalid write, whose
 * caller may not be authenticated: with debug on the payload is also run
 * through errorForLog's credential redaction (plus `credentials`, strings
 * known to be secret) and the whole line is bounded to 8192 characters.
 *
 * Options: debug, untrusted, credentials, op, collection, client, ref (the
 * reference to show when it is not in the record, e.g. an update's _id) and
 * payload (what to append in debug, when it differs from the record).
 */
function recordForLog (record, options) {
  const opts = options || {};
  const parts = [];
  if (opts.op !== undefined) parts.push(field(opts.op));
  if (opts.collection !== undefined) parts.push('collection=' + field(opts.collection));
  if (opts.client !== undefined) parts.push('client=' + field(opts.client));
  parts.push(summarize(record, opts.ref));
  let line = parts.join(' ');
  if (!opts.debug) return line;
  let payload = payloadJSON(Object.prototype.hasOwnProperty.call(opts, 'payload') ? opts.payload : record);
  if (!opts.untrusted) return line + ' payload: ' + payload;
  payload = redactText(payload, credentialSpellings(opts.credentials || []));
  line += ' payload: ' + payload;
  if (line.length <= LIMIT) return line;
  const marker = ' [truncated]';
  return line.slice(0, LIMIT - marker.length) + marker;
}

function cspReportForLog (body) {
  const report = body && body['csp-report'];
  if (!report || typeof report !== 'object' || Array.isArray(report)) return {};
  const safe = {};
  for (const field of ['document-uri', 'blocked-uri', 'source-file', 'referrer']) {
    if (typeof report[field] === 'string') safe[field] = urlForLog(report[field]);
  }
  for (const field of ['effective-directive', 'violated-directive']) {
    if (typeof report[field] !== 'string') continue;
    const directive = report[field].split(/\s/, 1)[0];
    if (/^[a-z][a-z-]{0,63}$/.test(directive)) safe[field] = directive;
  }
  for (const field of ['line-number', 'column-number', 'status-code']) {
    if (Number.isSafeInteger(report[field]) && report[field] >= 0) safe[field] = report[field];
  }
  // original-policy, script-sample and unknown fields may contain credentials
  // or user data. They are deliberately excluded from diagnostic output.
  return safe;
}

module.exports = {urlForLog, errorForLog, cspReportForLog, recordForLog, debugLogging, LOG_LIMIT: LIMIT};
