'use strict';

// Configuration for the multitenant `admin` role (D7): the private operator
// plane, built from the environment (lib/server/serve/deployment-settings.js)
// and validated here. `ownership` composes the ownership-operations service
// (lib/tenant-ownership) on the admin listener, on the separate
// ownership_operator database identity; changes refuse on a tenant that is not
// active in the lifecycle control namespace (lib/tenant-lifecycle/tenant-phase.js).
// maxBytes and timeoutMs bound every request on the listener. No other key is accepted.
const { PreviewConfigError } = require('./preview-config');

const NAME = /^[a-zA-Z0-9_-]{1,128}$/;
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
  fields(selected, ['connectionEnv', 'namespaces', 'checkpoints', 'vault', 'operator'], ['mode', 'ownerPolicy', 'pendingConsumer']);
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
  // Writer-driven input: provisioning creates this checkpoint row typed and pending.
  let pendingConsumer;
  if (selected.pendingConsumer !== undefined) {
    try { pendingConsumer = require('../../writer-driven').binding(selected.pendingConsumer); } catch { invalid(); }
    if (!checkpoints.some(row => row.namespace === pendingConsumer.namespace && row.consumer === pendingConsumer.consumer)) invalid();
  }
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
    checkpoints: Object.freeze(checkpoints), ownerCatalogue: Object.freeze(catalogue), ...(pendingConsumer ? { pendingConsumer } : {}),
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
  fields(config, ['version', 'maxBytes', 'timeoutMs'], ['ownership', 'provisioning', 'connectorSources', 'managementSessions']);
  if (config.version !== 1 || (config.ownership === undefined && config.provisioning === undefined && config.connectorSources === undefined && config.managementSessions === undefined)) invalid();
  const maxBytes = bound(config.maxBytes, 1048576), timeoutMs = bound(config.timeoutMs, 60000);
  let ownership;
  if (config.ownership !== undefined) {
    const selected = config.ownership;
    if (!selected || typeof selected !== 'object' || !Object.hasOwn(selected, 'registry') || Object.hasOwn(selected, 'tenants')) throw new PreviewConfigError(require('./registry-config').REFUSAL);
    fields(selected, ['connectionEnv', 'namespace', 'lifecycleNamespace', 'operator', 'registry'], ['configurationNamespace']);
    if (selected.lifecycleNamespace === selected.namespace) invalid();
    fields(selected.operator, ['principal', 'consumer']);
    const { principal, consumer } = selected.operator;
    if (typeof principal !== 'string' || !NAME.test(principal) || typeof consumer !== 'string' || !NAME.test(consumer)) invalid();
    ownership = Object.freeze({
      connectionString: database(reference(selected.connectionEnv, source)),
      namespace: namespace(selected.namespace),
      lifecycleNamespace: namespace(selected.lifecycleNamespace),
      ...(selected.configurationNamespace === undefined ? {} : { configurationNamespace: namespace(selected.configurationNamespace) }),
      operator: Object.freeze({ principal, consumer }),
      registry: require('./registry-config').registry(selected.registry, invalid)
    });
  }
  let connectorSources;
  if (config.connectorSources !== undefined) {
    const selected = config.connectorSources;
    fields(selected, ['connectionEnv', 'namespaces', 'operator']);
    fields(selected.namespaces, ['settings', 'registry', 'secrets', 'control']);
    fields(selected.operator, ['principal', 'consumer']);
    if (![selected.operator.principal, selected.operator.consumer].every(value => typeof value === 'string' && NAME.test(value)) ||
        new Set(Object.values(selected.namespaces)).size !== 4) invalid();
    connectorSources = Object.freeze({ connectionString: database(reference(selected.connectionEnv, source)),
      namespaces: Object.freeze(Object.fromEntries(Object.entries(selected.namespaces).map(([key, value]) => [key, namespace(value)]))),
      operator: Object.freeze({ ...selected.operator }) });
  }
  const provisioning = config.provisioning === undefined ? undefined : provisioningSection(config.provisioning, source);
  const managementSessions = config.managementSessions === undefined ? undefined : managementSection(config.managementSessions, source);
  return Object.freeze({ maxBytes, timeoutMs, ...(managementSessions ? { managementSessions } : {}), ...(ownership ? { ownership } : {}), ...(provisioning ? { provisioning } : {}), ...(connectorSources ? { connectorSources } : {}) });
}

// The admin configuration, built from the environment (lib/server/serve/deployment-settings.js).
function load (raw) {
  const settings = require('./deployment-settings'), source = settings.withSecrets(raw);
  const value = settings.configuration('admin', source);
  if (Object.keys(value).length === 3) throw new PreviewConfigError('admin requires at least one service identity: NS_PROVISIONER_PG, NS_OWNERSHIP_PG, NS_CONNECTOR_SOURCES_PG or NS_MANAGEMENT_SESSIONS_PG');
  // The registry refusal keeps its own message; any other parse failure is the generic refusal.
  try { return parse(value, source); } catch (error) { if (error instanceof PreviewConfigError && error.message === require('./registry-config').REFUSAL) throw error; invalid(); }
}

module.exports = { load, parse };
