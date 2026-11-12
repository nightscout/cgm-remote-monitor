'use strict';

// Explicit configuration for the multitenant `admin` role (D7): the private
// operator plane. MULTITENANT_ADMIN_CONFIG names a JSON file:
//
//   { "version": 1, "maxBytes": 65536, "timeoutMs": 10000,
//     "pools": { "connectionEnv": "NS_POOL_OPERATOR_PG", "namespace": "<pool namespace>",
//                "kinds": ["evaluator", "vcpool"] },
//     "ownership": { "connectionEnv": "NS_OWNERSHIP_PG", "namespace": "<authorization namespace>",
//                    "lifecycleNamespace": "<lifecycle control namespace>",
//                    "operator": { "principal": "...", "consumer": "..." },
//                    "tenants": ["<tenant uuid>", ...] } }
//
// `pools` (optional) composes the pool-operations service (lib/pool-membership/
// operator.js): read a pool kind and set its member count, on the separate
// pool operator database identity (SELECT on membership; INSERT and column
// UPDATE on pool_desired only), for the listed kinds only.
// `ownership` composes the ownership-operations service (lib/tenant-ownership)
// on the admin listener. Its connection is the separate ownership_operator
// database identity, read from the named environment variable; the operator
// identity is fixed here and acts only for the listed tenants. Changes refuse
// on a tenant that is not active in the lifecycle control namespace
// (lib/tenant-lifecycle/tenant-phase.js). maxBytes and
// timeoutMs bound every request on the listener. No other key is accepted.
const { readRaw } = require('./listeners');
const { PreviewConfigError } = require('./preview-config');

const NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const { PREVIEW_MAX_TENANTS: MAX_TENANTS } = require('./tenant-ceiling');
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

// `provisioning` (optional) composes the tenant provisioning REST resource
// (lib/tenant-registry/rest.js, decisions provisioning-split and
// operator-rest-api) on the provisioning database identity and a Vault
// credential that may create tenant keys:
//   { "connectionEnv": "NS_PROVISIONER_PG", "mode": "direct-alias",
//     "namespaces": { "registry", "legacy", "secrets", "authorization", "access", "clock", "control", "settings", "operatorPolicy" },
//     "checkpoints": [{ "namespace", "consumer", "digest" }],
//     "ownerPolicy": { "catalogue": ["*"] },
//     "vault": { "address", "mount", "tokenFile" | "tokenEnv", "timeoutMs"?, "allowInsecureLoopback"? },
//     "operator": { "principal", "consumer" } }
function provisioningSection (selected, source) {
  fields(selected, ['connectionEnv', 'namespaces', 'checkpoints', 'vault', 'operator'], ['mode', 'ownerPolicy']);
  const mode = selected.mode === undefined ? 'direct-alias' : selected.mode;
  if (!['direct-alias', 'canonical-internal'].includes(mode)) invalid();
  fields(selected.namespaces, ['registry', 'legacy', 'secrets', 'authorization', 'access', 'clock', 'control', 'settings', 'operatorPolicy']);
  const namespaces = Object.fromEntries(Object.entries(selected.namespaces).map(([key, value]) => [key, namespace(value)]));
  if (new Set(Object.values(namespaces)).size !== 9) invalid();
  if (!Array.isArray(selected.checkpoints) || selected.checkpoints.length > 8) invalid();
  const checkpoints = selected.checkpoints.map(row => {
    fields(row, ['namespace', 'consumer', 'digest']);
    if (typeof row.consumer !== 'string' || !NAME.test(row.consumer) || typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.digest)) invalid();
    return Object.freeze({ namespace: namespace(row.namespace), consumer: row.consumer, digest: row.digest });
  });
  let catalogue = ['*'];
  if (selected.ownerPolicy !== undefined) {
    fields(selected.ownerPolicy, ['catalogue']);
    try { require('../../subject-admin/owner-policy').catalogueDigest(selected.ownerPolicy.catalogue); } catch { invalid(); }
    catalogue = selected.ownerPolicy.catalogue.slice();
  }
  const vault = selected.vault;
  fields(vault, ['address', 'mount'], ['tokenFile', 'tokenEnv', 'timeoutMs', 'allowInsecureLoopback']);
  if ((vault.tokenFile === undefined) === (vault.tokenEnv === undefined) || typeof vault.address !== 'string' ||
      typeof vault.mount !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(vault.mount) ||
      (vault.timeoutMs !== undefined && !Number.isSafeInteger(vault.timeoutMs)) ||
      (vault.allowInsecureLoopback !== undefined && typeof vault.allowInsecureLoopback !== 'boolean')) invalid();
  const { tokenFilePath, tokenFileReader } = require('../../secrets/vault-token-source');
  const getToken = vault.tokenFile !== undefined ? tokenFileReader(tokenFilePath(vault.tokenFile, invalid))
    : (() => { reference(vault.tokenEnv, source); return async () => reference(vault.tokenEnv, source); })();
  fields(selected.operator, ['principal', 'consumer']);
  const { principal, consumer } = selected.operator;
  if (typeof principal !== 'string' || !NAME.test(principal) || typeof consumer !== 'string' || !NAME.test(consumer)) invalid();
  return Object.freeze({ connectionString: database(reference(selected.connectionEnv, source)), mode, namespaces: Object.freeze(namespaces),
    checkpoints: Object.freeze(checkpoints), ownerCatalogue: Object.freeze(catalogue),
    vault: Object.freeze({ address: vault.address, mount: vault.mount, getToken, timeoutMs: vault.timeoutMs === undefined ? 5000 : vault.timeoutMs,
      allowInsecureLoopback: vault.allowInsecureLoopback === true }),
    actor: Object.freeze({ principal, consumer }) });
}

function managementSection (value, source) {
  fields(value, ['connectionEnv', 'namespaces', 'issuer', 'audience', 'consumer', 'vault', 'operator'], ['maxLifetimeSeconds']);
  try { require('../../management-sessions/authority').selected(value.namespaces); } catch { invalid(); }
  if (![value.issuer, value.audience].every(text => typeof text === 'string' && text.length > 0 && text.length <= 256) ||
      typeof value.consumer !== 'string' || !NAME.test(value.consumer)) invalid();
  const maxLifetimeSeconds = value.maxLifetimeSeconds === undefined ? 600 : value.maxLifetimeSeconds;
  if (!Number.isSafeInteger(maxLifetimeSeconds) || maxLifetimeSeconds < 1 || maxLifetimeSeconds > 600) invalid();
  fields(value.operator, ['principal', 'consumer']);
  if (typeof value.operator.principal !== 'string' || !NAME.test(value.operator.principal) || typeof value.operator.consumer !== 'string' || !NAME.test(value.operator.consumer)) invalid();
  const vault = require('./registry-config').vault(value.vault, source, invalid);
  try { require('../../management-sessions/vault').createVaultKeySource(vault); } catch { invalid(); }
  return Object.freeze({ connectionString: database(reference(value.connectionEnv, source)), namespaces: Object.freeze({ ...value.namespaces }),
    issuer: value.issuer, audience: value.audience, consumer: value.consumer, maxLifetimeSeconds, vault,
    actor: Object.freeze({ ...value.operator }) });
}

function parse (config, source) {
  // At least one operator service; each is optional on its own.
  fields(config, ['version', 'maxBytes', 'timeoutMs'], ['ownership', 'pools', 'provisioning', 'managementSessions']);
  if (config.version !== 1 || (config.ownership === undefined && config.pools === undefined && config.provisioning === undefined && config.managementSessions === undefined)) invalid();
  const maxBytes = bound(config.maxBytes, 1048576), timeoutMs = bound(config.timeoutMs, 60000);
  let ownership;
  if (config.ownership !== undefined) {
    const selected = config.ownership;
    // Registry mode (decision tenant-registry): `registry` in place of `tenants`; both refuse.
    const registryMode = !!selected && typeof selected === 'object' && Object.hasOwn(selected, 'registry');
    if (registryMode && Object.hasOwn(selected, 'tenants')) throw new PreviewConfigError(require('./registry-config').REFUSAL);
    fields(selected, ['connectionEnv', 'namespace', 'lifecycleNamespace', 'operator', registryMode ? 'registry' : 'tenants']);
    if (selected.lifecycleNamespace === selected.namespace) invalid();
    fields(selected.operator, ['principal', 'consumer']);
    const { principal, consumer } = selected.operator;
    if (typeof principal !== 'string' || !NAME.test(principal) || typeof consumer !== 'string' || !NAME.test(consumer)) invalid();
    const tenants = registryMode ? null : selected.tenants;
    if (!registryMode && (!Array.isArray(tenants) || !tenants.length || tenants.length > MAX_TENANTS ||
        tenants.some(tenant => typeof tenant !== 'string' || !UUID.test(tenant) || tenant === '00000000-0000-0000-0000-000000000000') ||
        new Set(tenants).size !== tenants.length)) invalid();
    ownership = Object.freeze({
      connectionString: database(reference(selected.connectionEnv, source)),
      namespace: namespace(selected.namespace),
      lifecycleNamespace: namespace(selected.lifecycleNamespace),
      operator: Object.freeze({ principal, consumer }),
      ...(registryMode ? { registry: require('./registry-config').registry(selected.registry, invalid) } : { tenants: Object.freeze(tenants.slice()) })
    });
  }
  let pools;
  if (config.pools !== undefined) {
    fields(config.pools, ['connectionEnv', 'namespace', 'kinds']);
    const kinds = config.pools.kinds;
    if (!Array.isArray(kinds) || !kinds.length || kinds.length > 32 || new Set(kinds).size !== kinds.length ||
        kinds.some(kind => typeof kind !== 'string' || !/^[a-z][a-z0-9]{0,31}$/.test(kind))) invalid();
    pools = Object.freeze({ connectionString: database(reference(config.pools.connectionEnv, source)),
      namespace: namespace(config.pools.namespace), kinds: Object.freeze(kinds.slice()) });
  }
  const provisioning = config.provisioning === undefined ? undefined : provisioningSection(config.provisioning, source);
  const managementSessions = config.managementSessions === undefined ? undefined : managementSection(config.managementSessions, source);
  return Object.freeze({ maxBytes, timeoutMs, ...(managementSessions ? { managementSessions } : {}), ...(ownership ? { ownership } : {}), ...(pools ? { pools } : {}), ...(provisioning ? { provisioning } : {}) });
}

function load (source) {
  const file = readRaw(source, 'MULTITENANT_ADMIN_CONFIG');
  if (!file) throw new PreviewConfigError('admin requires MULTITENANT_ADMIN_CONFIG (explicit operator configuration JSON file)');
  // Bounded read (MULTITENANT_CONFIG_MAX_BYTES); each refusal names its cause.
  const value = require('./config-file').readJson(file, { source, label: 'MULTITENANT_ADMIN_CONFIG', Type: PreviewConfigError });
  // The registry refusal keeps its own message; any other parse failure is the generic refusal.
  try { return parse(value, source); } catch (error) { if (error instanceof PreviewConfigError && error.message === require('./registry-config').REFUSAL) throw error; invalid(); }
}

module.exports = { load, parse };
