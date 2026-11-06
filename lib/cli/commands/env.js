'use strict';

// `nightscout env`: the configuration the server would run with, built by
// the server's own parser (lib/server/env.js), printed as JSON with secrets
// redacted. Redaction is deliberately broad; an operator can read a redacted
// value from their own environment, but a printed one may end up in an issue.
//
// Three layers, each enough on its own for the common cases:
//   1. key names that look sensitive are redacted wherever they appear;
//   2. URLs lose their credentials, query and fragment, and email addresses
//      are redacted;
//   3. any value taken from a sensitive-looking environment variable is
//      redacted wherever it appears in the output, under any key.

const REDACTED = '[redacted]';

// Key names (environment variables or parsed settings, any case) whose values
// are withheld. Matched against the name with separators removed.
const SENSITIVE_KEY = /secret|passw|passphrase|pwd|token|apikey|key|credential|auth|private|cert|cookie|session|salt|signature|connstr|account|user|login|email|phone|serial|^ca$|^ssl$/i;
// Settings that match the pattern above but carry no secret and are needed
// to diagnose a site. apiSecretSet and sslEnabled are booleans this command computes.
// Compared with separators removed, ignoring case, so AUTH_DEFAULT_ROLES is kept too.
const KEEP_KEYS = new Set(['authdefaultroles', 'apisecretset', 'sslenabled']);

// Fields of the parsed configuration that are not configuration, or that hold
// key material or the secret's derivatives.
const OMIT = new Set(['enclave', 'api_secret', 'err', 'notifies']);

function sensitiveKey (key) {
  const bare = String(key).replace(/[_\-.\s]/g, '');
  if (KEEP_KEYS.has(bare.toLowerCase())) return false;
  return SENSITIVE_KEY.test(bare);
}

// scheme://user:pass@host/path?query#fragment keeps scheme, host and path.
function scrubURL (url) {
  const schemeEnd = url.indexOf('://') + 3;
  let rest = url.slice(schemeEnd);
  let suffix = '';
  const hash = rest.indexOf('#');
  if (hash >= 0) { rest = rest.slice(0, hash); suffix = '#' + REDACTED; }
  const query = rest.indexOf('?');
  if (query >= 0) { rest = rest.slice(0, query); suffix = '?' + REDACTED + suffix; }
  const at = rest.lastIndexOf('@');
  if (at >= 0) rest = REDACTED + '@' + rest.slice(at + 1);
  return url.slice(0, schemeEnd) + rest + suffix;
}

function scrubString (value, secrets) {
  let out = value;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  out = out.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, scrubURL);
  out = out.replace(/[^\s@/:[\]]+@[^\s@/:[\]]+\.[a-z]{2,}/gi, REDACTED);
  return out;
}

function redact (value, secrets, key) {
  if (key !== undefined && sensitiveKey(key)) {
    return value === undefined || value === null || value === '' ? value : REDACTED;
  }
  if (typeof value === 'string') return scrubString(value, secrets);
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (Buffer.isBuffer(value)) return REDACTED;
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (typeof value[k] === 'function') continue;
      out[k] = redact(value[k], secrets, k);
    }
    return out;
  }
  return value;
}

// Values of sensitive-looking variables, longest first so a secret that
// contains another is replaced whole. Very short values are skipped: they
// would redact unrelated text and are not secrets anyone relies on.
function secretValues (source) {
  const values = new Set();
  for (const [key, value] of Object.entries(source)) {
    if (!sensitiveKey(key) && !/MONGO|STORAGE_URI|DATABASE/i.test(key)) continue;
    const trimmed = String(value).trim();
    if (trimmed.length >= 6) values.add(trimmed);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

// Build the configuration with the server's parser. It logs as it goes;
// keep stdout for the JSON.
function effectiveConfig () {
  const log = console.log;
  const info = console.info;
  console.log = console.info = (...args) => console.error(...args);
  try {
    return require('../../server/env')();
  } finally {
    console.log = log;
    console.info = info;
  }
}

function describe (env) {
  const out = {};
  for (const key of Object.keys(env)) {
    if (OMIT.has(key)) continue;
    out[key] = env[key];
  }
  delete out.ssl;
  delete out.ca;
  out.sslEnabled = Boolean(env.ssl);
  out.apiSecretSet = Boolean(env.enclave && env.enclave.isApiKeySet && env.enclave.isApiKeySet());
  out.settings = env.settings && typeof env.settings === 'object' ? Object.assign({}, env.settings) : env.settings;
  return out;
}

function run (args, io) {
  if (args.length) {
    io.stderr.write('Usage: nightscout env\n');
    return 64;
  }
  const secrets = secretValues(io.env);
  const config = describe(effectiveConfig());
  io.stdout.write(JSON.stringify(redact(config, secrets), null, 2) + '\n');
  return 0;
}

module.exports = { run, redact, sensitiveKey, secretValues, REDACTED };
