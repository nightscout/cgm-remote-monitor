'use strict';

// Operator configuration of the vcpool role (MT-CONNECTOR-REVERSE): the
// tenant-side Nightscout connector, built from the environment
// (lib/server/serve/deployment-settings.js: NS_VCPOOL_API_URL,
// NS_VCPOOL_ALLOW_HOSTS, NS_VCPOOL_ALLOW_INSECURE_HTTP). Tenants and their
// connector definitions come from the registry and the definitions store.
//
// The member's egress is its own environment, MULTITENANT_VCPOOL_EGRESS_PROXY
// (decision vcpool-egress-capacity): an http(s) proxy origin that every source
// request of this member goes through. Unset means direct egress; the process's
// HTTP_PROXY variables are never consulted. The tenant API is never proxied.

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,127}$/;
const SECRET_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const HOST = /^[a-z0-9.-]{1,253}$/;
const COLLECTIONS = Object.freeze(['entries', 'treatments', 'devicestatus', 'profiles']);
const EGRESS_ENV = 'MULTITENANT_VCPOOL_EGRESS_PROXY';
const DEFAULTS = Object.freeze({ cycleMs: 15000, pollIntervalMs: 300000, retryMs: 150000 });

class ConnectorConfigError extends Error {
  constructor (message) { super(message); this.code = 'CONNECTOR_CONFIG_INVALID'; }
}
const invalid = message => { throw new ConnectorConfigError('vcpool: ' + message); };
function exact (value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) return false;
  return true;
}
function namespace (value) {
  return typeof value === 'string' && NAME.test(value) && !value.startsWith('pg_') && !['public', 'information_schema'].includes(value);
}
function reference (name, source) {
  if (typeof name !== 'string' || !ENV.test(name) || typeof source[name] !== 'string' || !source[name].trim()) {
    invalid('credential environment reference is missing or invalid');
  }
  return source[name];
}
function integer (value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }

// An http(s) origin with no credentials, path or query.
function origin (text, label) {
  let url;
  try { url = new URL(text); } catch { invalid(label + ' must be an http(s) origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) invalid(label + ' must be an http(s) origin with no credentials, path or query');
  return url;
}

function egress (source) {
  const raw = source[EGRESS_ENV];
  if (raw === undefined || raw === '') return Object.freeze({ proxy: null });
  const url = origin(String(raw).trim(), EGRESS_ENV);
  return Object.freeze({ proxy: Object.freeze({ protocol: url.protocol.slice(0, -1), host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) }) });
}

function parse (value, source) {
  if (!value || !Object.hasOwn(value, 'registry') || Object.hasOwn(value, 'tenants')) invalid('registry mode refuses a tenants list');
  if (!exact(value, ['version', 'api', 'postgres', 'vault', 'activity', 'sources', 'registry', 'definitions'],
    ['cycleMs', 'pollIntervalMs', 'retryMs', 'maxTenants', 'maxSources', 'nativeSelection']) || value.version !== 1) invalid('unsupported configuration fields or version');
  const timing = { ...DEFAULTS };
  for (const key of ['cycleMs', 'pollIntervalMs', 'retryMs']) {
    if (value[key] !== undefined && !integer(value[key], 100, 86400000)) invalid(key + ' must be 100..86400000 ms');
    if (value[key] !== undefined) timing[key] = value[key];
  }
  if (!exact(value.api, ['url'])) invalid('api requires url');
  const api = origin(value.api.url, 'api.url');
  if (!exact(value.postgres, ['connectionEnv', 'namespaces']) || !exact(value.postgres.namespaces, ['secrets']) ||
      !namespace(value.postgres.namespaces.secrets)) invalid('postgres requires connectionEnv and the secrets namespace');
  const secretsConnectionString = reference(value.postgres.connectionEnv, source);
  const activity = require('../tenant-activity/config').parse(value.activity, source,
    { invalid: () => invalid('activity requires connectionEnv and namespace'), reserved: [value.postgres.namespaces.secrets] });
  if (activity.connectionString === secretsConnectionString) invalid('activity and secrets require separate identities');
  if (!exact(value.sources, ['allowHosts'], ['allowInsecureHttp']) || !Array.isArray(value.sources.allowHosts) ||
      !value.sources.allowHosts.length || value.sources.allowHosts.some(host => typeof host !== 'string' || !HOST.test(host)) ||
      (value.sources.allowInsecureHttp !== undefined && typeof value.sources.allowInsecureHttp !== 'boolean')) {
    invalid('sources requires an explicit allowHosts list of lower-case host names');
  }
  const sources = Object.freeze({ allowHosts: Object.freeze([...new Set(value.sources.allowHosts)]),
    allowInsecureHttp: value.sources.allowInsecureHttp === true });
  {
    const registry = require('../server/serve/registry-config').registry(value.registry, invalid);
    // Refresh enumerates every registry tenant before selecting active sources.
    const maxTenants = value.maxTenants === undefined ? registry.maxTenants : value.maxTenants;
    if (!integer(maxTenants, 1, 100000)) invalid('maxTenants must be 1..100000');
    if (!exact(value.definitions, ['connectionEnv', 'namespaces']) || !exact(value.definitions.namespaces, ['settings', 'registry', 'secrets', 'control']) ||
        Object.values(value.definitions.namespaces).some(name => !namespace(name)) || new Set(Object.values(value.definitions.namespaces)).size !== 4 ||
        value.definitions.namespaces.registry !== registry.namespace || value.definitions.namespaces.secrets !== value.postgres.namespaces.secrets ||
        value.definitions.namespaces.control !== activity.namespace) invalid('definitions requires settings,registry,secrets,control namespaces');
    const connectionString = reference(value.definitions.connectionEnv, source);
    if ([secretsConnectionString, activity.connectionString].includes(connectionString)) invalid('definitions,activity,secrets require separate identities');
    const maxSources = value.maxSources === undefined ? 10000 : value.maxSources;
    if (!integer(maxSources, 1, 100000)) invalid('maxSources must be 1..100000');
    return Object.freeze({ api: api.origin + '/', apiInsecure: api.protocol === 'http:', namespaces: Object.freeze({ secrets: value.postgres.namespaces.secrets }),
      secretsConnectionString, activity, sources, ...timing, maxTenants, maxSources, registry,
      registryVault: require('../server/serve/registry-config').vault(value.vault, source, invalid),
      definitions: Object.freeze({ connectionString, namespaces: Object.freeze({ ...value.definitions.namespaces }) }), tenants: new Map(), egress: egress(source),
      ...(value.nativeSelection !== undefined ? { nativeSelection: nativeOf(value.nativeSelection, activity.namespace) } : {}) });
  }
}

// The deployment's native lifecycle selection, bound to the activity (control) namespace.
function nativeOf (value, control) {
  try { return require('../tenant-lifecycle/native-selection').bind(value, control); } catch { return invalid('nativeSelection must be the deployment native selection of the control namespace'); }
}

function connectorOf (value) {
  if (!exact(value, ['collections', 'sourceEndpoint', 'sourceCredential', 'sourceCredentialKind', 'writeCredential']) ||
      !Array.isArray(value.collections) || !value.collections.length || new Set(value.collections).size !== value.collections.length ||
      value.collections.some(name => !COLLECTIONS.includes(name)) || !['token', 'api-secret'].includes(value.sourceCredentialKind) ||
      ['sourceEndpoint', 'sourceCredential', 'writeCredential'].some(key => typeof value[key] !== 'string' || !SECRET_ID.test(value[key])) ||
      new Set([value.sourceEndpoint, value.sourceCredential, value.writeCredential]).size !== 3) {
    invalid('tenant connector requires collections, three distinct secret references and a credential kind');
  }
  return Object.freeze({ collections: Object.freeze([...value.collections]), sourceEndpoint: value.sourceEndpoint,
    sourceCredential: value.sourceCredential, sourceCredentialKind: value.sourceCredentialKind, writeCredential: value.writeCredential });
}

// The decrypted source endpoint, checked against the operator allow-list
// (2026-10-27 outbound-endpoint floor) before any request is made.
function sourceEndpoint (text, sources) {
  let url;
  try { url = new URL(text); } catch { throw Object.assign(new Error('CONNECTOR_SOURCE_REFUSED'), { code: 'CONNECTOR_SOURCE_REFUSED' }); }
  const refused = !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash ||
    (url.protocol === 'http:' && !sources.allowInsecureHttp) || !sources.allowHosts.includes(url.hostname.toLowerCase());
  if (refused) throw Object.assign(new Error('CONNECTOR_SOURCE_REFUSED'), { code: 'CONNECTOR_SOURCE_REFUSED' });
  return url;
}

// The vcpool configuration, built from the environment (lib/server/serve/deployment-settings.js).
function load (raw) {
  const settings = require('../server/serve/deployment-settings'), source = settings.withSecrets(raw);
  let value;
  try { value = settings.configuration('vcpool', source); } catch (error) { invalid(error.message); }
  return parse(value, source);
}

module.exports = { load, parse, connectorOf, egress, sourceEndpoint, ConnectorConfigError, COLLECTIONS, EGRESS_ENV, DEFAULTS };
