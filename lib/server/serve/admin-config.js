'use strict';

// Explicit configuration for the multitenant `admin` role (D7): the private
// operator plane. MULTITENANT_ADMIN_CONFIG names a JSON file:
//
//   { "version": 1, "maxBytes": 65536, "timeoutMs": 10000,
//     "ownership": { "connectionEnv": "NS_OWNERSHIP_PG", "namespace": "<authorization namespace>",
//                    "lifecycleNamespace": "<lifecycle control namespace>",
//                    "operator": { "principal": "...", "consumer": "..." },
//                    "tenants": ["<tenant uuid>", ...] } }
//
// `ownership` composes the ownership-operations service (lib/tenant-ownership)
// on the admin listener. Its connection is the separate ownership_operator
// database identity, read from the named environment variable; the operator
// identity is fixed here and acts only for the listed tenants. Changes refuse
// on a tenant that is not active in the lifecycle control namespace
// (lib/tenant-lifecycle/tenant-phase.js). maxBytes and
// timeoutMs bound every request on the listener. No other key is accepted.
const fs = require('node:fs');
const { readRaw } = require('./listeners');
const { PreviewConfigError } = require('./preview-config');

const NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TENANTS = 10000;
const invalid = () => { throw new PreviewConfigError('invalid explicit admin operator configuration'); };

function fields (value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function reference (name, source) {
  if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || typeof source[name] !== 'string' || !source[name].trim()) invalid();
  return source[name];
}
function database (value) {
  let url; try { url = new URL(value); } catch { invalid(); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password ||
      !url.pathname.slice(1) || url.hash || [...url.searchParams.keys()].some(key => key !== 'sslmode') ||
      url.searchParams.getAll('sslmode').length > 1 ||
      (url.search && !['disable', 'verify-full'].includes(url.searchParams.get('sslmode')))) invalid();
  return value;
}
function namespace (value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value) || value === 'public' ||
      value === 'information_schema' || value.startsWith('pg_')) invalid();
  return value;
}
function bound (value, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) invalid();
  return value;
}

function parse (config, source) {
  fields(config, ['version', 'maxBytes', 'timeoutMs', 'ownership']);
  if (config.version !== 1) invalid();
  const maxBytes = bound(config.maxBytes, 1048576), timeoutMs = bound(config.timeoutMs, 60000);
  const ownership = config.ownership;
  fields(ownership, ['connectionEnv', 'namespace', 'lifecycleNamespace', 'operator', 'tenants']);
  if (ownership.lifecycleNamespace === ownership.namespace) invalid();
  fields(ownership.operator, ['principal', 'consumer']);
  const { principal, consumer } = ownership.operator;
  if (typeof principal !== 'string' || !NAME.test(principal) || typeof consumer !== 'string' || !NAME.test(consumer)) invalid();
  const tenants = ownership.tenants;
  if (!Array.isArray(tenants) || !tenants.length || tenants.length > MAX_TENANTS ||
      tenants.some(tenant => typeof tenant !== 'string' || !UUID.test(tenant) || tenant === '00000000-0000-0000-0000-000000000000') ||
      new Set(tenants).size !== tenants.length) invalid();
  return Object.freeze({
    maxBytes, timeoutMs,
    ownership: Object.freeze({
      connectionString: database(reference(ownership.connectionEnv, source)),
      namespace: namespace(ownership.namespace),
      lifecycleNamespace: namespace(ownership.lifecycleNamespace),
      operator: Object.freeze({ principal, consumer }),
      tenants: Object.freeze(tenants.slice())
    })
  });
}

function load (source) {
  const file = readRaw(source, 'MULTITENANT_ADMIN_CONFIG');
  if (!file) throw new PreviewConfigError('admin requires MULTITENANT_ADMIN_CONFIG (explicit operator configuration JSON file)');
  try {
    const stat = fs.statSync(file); if (!stat.isFile() || stat.size > 1048576) invalid();
    const bytes = fs.readFileSync(file); if (bytes.length > 1048576) invalid();
    return parse(JSON.parse(bytes.toString('utf8')), source);
  } catch { invalid(); }
}

module.exports = { load, parse };
