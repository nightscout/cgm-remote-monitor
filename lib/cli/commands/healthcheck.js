'use strict';

// `nightscout healthcheck`: probe the server this environment configures and
// exit 0 when it answers, 1 when it does not. It needs no curl, so an
// operator can use it as a compose health check; the image does not set one.
//
// It asks GET /api/versions, which needs no secret and no database read. A
// booted server answers 200 with a JSON list; a server that booted with
// errors answers every path with its 500 error page, which counts as
// unhealthy. The address comes from the same settings the server listens on:
// PORT, NIGHTSCOUT_HOSTNAME / HOSTNAME, SSL_KEY + SSL_CERT, INSECURE_USE_HTTP.
//
// With --role ROLE it asks that role's listener instead (lib/server/serve/
// listeners.js: <PREFIX>_HOSTNAME and <PREFIX>_PORT, falling back as the role
// does), on the role's own unauthenticated path. `serve api` has no
// /api/versions, so for api that is GET /api/v3/version, which answers 200
// with API v3's version once storage is reachable.

const envValue = require('../../utils/env-value');
const listeners = require('../../server/serve/listeners');

const EX_USAGE = 64;
const DEFAULT_TIMEOUT_MS = 5000;
const PATH = '/api/versions';
// The path each role that can be probed answers on.
const ROLE_PATHS = { api: '/api/v3/version' };

function normalize (source) {
  const normalized = {};
  for (const [key, value] of Object.entries(source)) normalized[key.trim()] = String(value).trim();
  return normalized;
}

// lib/server/env.js readENVRaw: present-but-empty counts as set.
function readRaw (env, name) {
  for (const key of ['CUSTOMCONNSTR_' + name, 'CUSTOMCONNSTR_' + name.toLowerCase(), name, name.toLowerCase()]) {
    if (Object.prototype.hasOwnProperty.call(env, key)) return env[key];
  }
  return undefined;
}

function truthy (value) {
  return typeof value === 'string' && ['on', 'true'].includes(value.toLowerCase());
}

// Where to reach the listener that lib/server/server.js opens with
// listen(PORT, HOSTNAME). A wildcard or unset bind address is reached on
// loopback. The legacy HOSTNAME is used as given: when the server ignores it
// (a container's generated hostname), it binds every interface, and that
// name still resolves to one of them.
function target (source, role) {
  const env = normalize(source);
  let port = envValue(env, 'PORT') || 1337;
  let host = readRaw(env, 'NIGHTSCOUT_HOSTNAME');
  if (host === undefined) host = readRaw(env, 'HOSTNAME');
  if (role) {
    const spec = listeners.listenerFor(role, env, { host, port });
    host = spec.host;
    port = spec.port;
  }
  if (!host || host === '0.0.0.0') host = '127.0.0.1';
  else if (host === '::' || host === '[::]') host = '::1';
  const ssl = Boolean(envValue(env, 'SSL_KEY') && envValue(env, 'SSL_CERT'));
  const insecureUseHttp = truthy(envValue(env, 'INSECURE_USE_HTTP'));
  const hostPart = host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host;
  return {
    url: (ssl ? 'https' : 'http') + '://' + hostPart + ':' + port + (role ? ROLE_PATHS[role] : PATH)
    , ssl
    , insecureUseHttp
  };
}

function probe (url, opts) {
  const parsed = new URL(url);
  const transport = parsed.protocol === 'https:' ? require('https') : require('http');
  const headers = { accept: 'application/json' };
  // Without INSECURE_USE_HTTP the app redirects plain http to https unless
  // the request says it arrived over https. Say so; the app believes it when
  // TRUST_PROXY trusts the loopback hop (the default does).
  if (parsed.protocol === 'http:' && !opts.insecureUseHttp) headers['x-forwarded-proto'] = 'https';
  return new Promise(resolve => {
    const req = transport.request(parsed, {
      method: 'GET'
      , headers
      , timeout: opts.timeout
      // The certificate names the public host, not loopback.
      , rejectUnauthorized: false
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (body.length < 65536) body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => req.destroy(new Error('no answer within ' + opts.timeout + ' ms')));
    req.on('error', err => resolve({ error: err }));
    req.end();
  });
}

function verdict (result, role) {
  if (result.error) return { healthy: false, reason: result.error.code || result.error.message };
  if (result.status === 200) {
    try {
      const body = JSON.parse(result.body);
      if (!role && Array.isArray(body)) return { healthy: true, reason: '200' };
      if (role && body && body.result && body.result.apiVersion) return { healthy: true, reason: '200' };
    } catch { /* fall through */ }
    return { healthy: false, reason: '200 without the version ' + (role ? 'record' : 'list') };
  }
  // The app answered, but its http-to-https redirect is in force because
  // TRUST_PROXY does not trust loopback. The listener is up; whether boot
  // finished cleanly cannot be seen through the redirect.
  if (result.status === 307 && /^https:\/\//.test(result.headers.location || '')) {
    return { healthy: true, reason: '307 to https (listener up; boot state not visible; set INSECURE_USE_HTTP or TRUST_PROXY to see it)' };
  }
  if (result.status === 500) {
    return { healthy: false, reason: '500 (the server is up and showing its boot-error page; open the site to read why)' };
  }
  return { healthy: false, reason: String(result.status) };
}

function parseArgs (args) {
  const opts = { timeout: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--timeout' && /^[1-9][0-9]*$/.test(args[i + 1] || '')) opts.timeout = Number(args[++i]);
    else if (args[i] === '--url' && args[i + 1]) opts.url = args[++i];
    else if (args[i] === '--role' && Object.prototype.hasOwnProperty.call(ROLE_PATHS, args[i + 1] || '')) opts.role = args[++i];
    else return null;
  }
  return opts.url && opts.role ? null : opts;
}

async function run (args, io) {
  const opts = parseArgs(args);
  if (!opts) {
    io.stderr.write('Usage: nightscout healthcheck [--timeout MS] [--url URL | --role ' + Object.keys(ROLE_PATHS).join('|') + ']\n');
    return EX_USAGE;
  }
  let t;
  try {
    t = target(io.env, opts.role);
  } catch (err) {
    if (!(err instanceof listeners.ListenerError)) throw err;
    io.stderr.write('nightscout healthcheck: ' + err.message + '\n');
    return EX_USAGE;
  }
  const url = opts.url || t.url;
  const result = verdict(await probe(url, { timeout: opts.timeout, insecureUseHttp: t.insecureUseHttp }), opts.role);
  (result.healthy ? io.stdout : io.stderr).write((result.healthy ? 'healthy' : 'unhealthy') + ': ' + url + ' ' + result.reason + '\n');
  return result.healthy ? 0 : 1;
}

module.exports = { run, target, probe, verdict };
