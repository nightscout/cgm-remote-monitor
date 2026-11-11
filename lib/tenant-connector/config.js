'use strict';

// Operator configuration of the vcpool role (MT-CONNECTOR-REVERSE): the
// tenant-side Nightscout connector. Read from the JSON file named by
// MULTITENANT_VCPOOL_CONFIG; every credential is an environment reference or a
// tenant secret reference, never a value in the file.
//
// {
//   "version": 1,
//   "api": { "url": "http://api:1337/" },          the api role; the tenant is chosen by Host
//   "postgres": { "connectionEnv": "...", "namespaces": { "secrets": "..." } },
//   "vault": { "address", "mount", "allowInsecureLoopback"?, "timeoutMs"? },
//   "activity": { "connectionEnv", "namespace" },   required: work lists come from eligibility
//   "sources": { "allowHosts": ["ns.example.org"], "allowInsecureHttp"? },
//   "cycleMs"?, "pollIntervalMs"?, "retryMs"?, "maxTenants"?,
//   "tenants": [{
//     "id": "<uuid>", "host": "<tenant alias the api resolves>",
//     "vault": { "encryptionKey", "signingKey", "signingVersion", "tokenEnv" | "tokenFile" },
//     "connector": { "collections": ["entries", "treatments"],
//       "sourceEndpoint": "<secret id>", "sourceCredential": "<secret id>",
//       "sourceCredentialKind": "token" | "api-secret", "writeCredential": "<secret id>" }
//   }]
// }
//
// The member's egress is its own environment, MULTITENANT_VCPOOL_EGRESS_PROXY
// (decision vcpool-egress-capacity): an http(s) proxy origin that every source
// request of this member goes through. Unset means direct egress; the process's
// HTTP_PROXY variables are never consulted. The tenant API is never proxied.
const { createVaultTransit } = require('../secrets/vault-transit');
const { tokenFilePath, tokenFileReader } = require('../secrets/vault-token-source');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,127}$/;
const SECRET_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const HOST = /^[a-z0-9.-]{1,253}$/;
const COLLECTIONS = Object.freeze(['entries', 'treatments', 'devicestatus', 'profiles']);
const EGRESS_ENV = 'MULTITENANT_VCPOOL_EGRESS_PROXY';
const CONFIG_ENV = 'MULTITENANT_VCPOOL_CONFIG';
const DEFAULTS = Object.freeze({ cycleMs: 15000, pollIntervalMs: 300000, retryMs: 150000, maxTenants: 1000 });

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
  if (!exact(value, ['version', 'api', 'postgres', 'vault', 'activity', 'sources', 'tenants'],
    ['cycleMs', 'pollIntervalMs', 'retryMs', 'maxTenants']) || value.version !== 1) invalid('unsupported configuration fields or version');
  const timing = { ...DEFAULTS };
  for (const key of ['cycleMs', 'pollIntervalMs', 'retryMs']) {
    if (value[key] !== undefined && !integer(value[key], 100, 86400000)) invalid(key + ' must be 100..86400000 ms');
    if (value[key] !== undefined) timing[key] = value[key];
  }
  if (value.maxTenants !== undefined && !integer(value.maxTenants, 1, 100000)) invalid('maxTenants must be 1..100000');
  if (value.maxTenants !== undefined) timing.maxTenants = value.maxTenants;
  if (!exact(value.api, ['url'])) invalid('api requires url');
  const api = origin(value.api.url, 'api.url');
  if (!exact(value.postgres, ['connectionEnv', 'namespaces']) || !exact(value.postgres.namespaces, ['secrets']) ||
      !namespace(value.postgres.namespaces.secrets)) invalid('postgres requires connectionEnv and the secrets namespace');
  const secretsConnectionString = reference(value.postgres.connectionEnv, source);
  const activity = require('../tenant-activity/config').parse(value.activity, source,
    { invalid: () => invalid('activity requires connectionEnv and namespace'), reserved: [value.postgres.namespaces.secrets] });
  if (activity.connectionString === secretsConnectionString) invalid('activity and secrets require separate identities');
  if (!exact(value.vault, ['address', 'mount'], ['allowInsecureLoopback', 'timeoutMs'])) invalid('vault requires address and mount');
  if (!exact(value.sources, ['allowHosts'], ['allowInsecureHttp']) || !Array.isArray(value.sources.allowHosts) ||
      !value.sources.allowHosts.length || value.sources.allowHosts.some(host => typeof host !== 'string' || !HOST.test(host)) ||
      (value.sources.allowInsecureHttp !== undefined && typeof value.sources.allowInsecureHttp !== 'boolean')) {
    invalid('sources requires an explicit allowHosts list of lower-case host names');
  }
  const sources = Object.freeze({ allowHosts: Object.freeze([...new Set(value.sources.allowHosts)]),
    allowInsecureHttp: value.sources.allowInsecureHttp === true });
  if (!Array.isArray(value.tenants) || !value.tenants.length || value.tenants.length > timing.maxTenants) invalid('tenants must be a bounded non-empty list');
  const tenants = new Map(), keys = new Set(), tokenEnvs = new Set();
  for (const tenant of value.tenants) {
    if (!exact(tenant, ['id', 'host', 'vault', 'connector']) || typeof tenant.id !== 'string' || !UUID.test(tenant.id) ||
        tenants.has(tenant.id) || typeof tenant.host !== 'string' || !HOST.test(tenant.host)) invalid('invalid or duplicate tenant');
    if (!exact(tenant.vault, ['encryptionKey', 'signingKey', 'signingVersion'], ['tokenEnv', 'tokenFile']) ||
        (tenant.vault.tokenEnv === undefined) === (tenant.vault.tokenFile === undefined)) {
      invalid('tenant vault requires keys and exactly one of tokenEnv or tokenFile');
    }
    if ([tenant.vault.encryptionKey, tenant.vault.signingKey].some(key => keys.has(key)) ||
        (tenant.vault.tokenEnv !== undefined && tokenEnvs.has(tenant.vault.tokenEnv))) invalid('tenants require separate keys and token references');
    keys.add(tenant.vault.encryptionKey); keys.add(tenant.vault.signingKey);
    let getToken;
    if (tenant.vault.tokenEnv !== undefined) {
      tokenEnvs.add(tenant.vault.tokenEnv);
      reference(tenant.vault.tokenEnv, source);
      getToken = async () => reference(tenant.vault.tokenEnv, source);
    } else {
      getToken = tokenFileReader(tokenFilePath(tenant.vault.tokenFile, () => invalid('tenant vault tokenFile must be a normalized absolute path')));
    }
    const connector = connectorOf(tenant.connector);
    let provider;
    try {
      provider = createVaultTransit({ ...value.vault, encryptionKey: tenant.vault.encryptionKey, signingKey: tenant.vault.signingKey,
        signingVersion: tenant.vault.signingVersion, getToken });
    } catch { invalid('invalid tenant vault binding'); }
    tenants.set(tenant.id, Object.freeze({ id: tenant.id, host: tenant.host, connector, provider,
      // The secrets identity this role presents; the role's authorize admits decrypt of this tenant's references only.
      binding: Object.freeze({ tenant: tenant.id, principal: 'vcpool', consumer: 'tenant-connector' }) }));
  }
  return Object.freeze({ api: api.origin + '/', apiInsecure: api.protocol === 'http:', namespaces: Object.freeze({ secrets: value.postgres.namespaces.secrets }),
    secretsConnectionString, activity, sources, ...timing, tenants, egress: egress(source) });
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

function load (source) {
  const file = source[CONFIG_ENV];
  if (typeof file !== 'string' || !file) invalid('requires ' + CONFIG_ENV + ' (explicit JSON file)');
  // Bounded read (MULTITENANT_CONFIG_MAX_BYTES); each refusal names its cause.
  const value = require('../server/serve/config-file').readJson(file, { source, label: 'vcpool: ' + CONFIG_ENV, Type: ConnectorConfigError });
  const config = parse(value, source);
  let partition;
  try { partition = require('../pool-membership').config.fromEnvironment('vcpool', source); } catch (error) {
    invalid(error.code === 'POOL_CONFIG_INVALID' ? error.message : 'invalid vcpool pool configuration');
  }
  return Object.freeze({ ...config, partition, file });
}

module.exports = { load, parse, egress, sourceEndpoint, ConnectorConfigError, COLLECTIONS, EGRESS_ENV, CONFIG_ENV, DEFAULTS };
