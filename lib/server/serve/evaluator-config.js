'use strict';

// Operator-trusted preview configuration, independent of human authorization and
// current owner settings. Read afresh at every cycle; no clinical row is rewritten.
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const environment = require('../tenant-app/environment');
const domains = require('../../data/tenant-projection-evaluator').domains;
const { PreviewConfigError } = require('./preview-config');
const configFile = require('./config-file');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const identity = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const invalid = () => { throw new PreviewConfigError('invalid explicit evaluator preview configuration'); };
const exact = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const integer = n => Number.isSafeInteger(n) && n >= 1;

function registryEntry (id) {
  return entryOf({ id, revision: 'registry', settings: {} });
}
function entryOf (tenant) {
  const env = environment(tenant);
  const effective = { revision: tenant.revision, settings: env.settings.filteredSettings(env.settings),
    extendedSettings: env.extendedSettings, plugins: [...env.settings.enable] };
  return Object.freeze({ tenant: tenant.id, revision: tenant.revision, identity: identity(effective), env });
}

function parseInternal (value, source, metadataOnly, internal, { settingsRequired = true } = {}) {
  // Registry mode (decision tenant-registry): `registry` in place of `tenants`;
  // settings come from the tenant settings store, so it is required.
  const registryMode = !!value && typeof value === 'object' && Object.hasOwn(value, 'registry');
  if (registryMode && Object.hasOwn(value, 'tenants')) throw new PreviewConfigError(require('./registry-config').REFUSAL);
  const required = ['version', 'postgres', 'consumer', 'pageSize', 'maxRows', 'maxBytes', 'maxTenants',
    'recoveryIntervalMs', 'timeIntervalMs', registryMode ? 'registry' : 'tenants'];
  // recoveryIntervalMs: the change backstop pass (D6); timeIntervalMs: the
  // bounded slow timer for output that changes continuously with time;
  // evictAfterMs (optional): release an unchanged tenant's retained input;
  // evaluationAlertMs (optional, default 60000): alert a tenant not evaluated within it.
  if (!exact(value, required, ['consumers', 'socketOrderDomains', 'datastore', 'tenantSettings', 'activity', 'changeFeed', 'evictAfterMs', 'evaluationAlertMs']) || value.version !== 1 ||
      ['evictAfterMs', 'evaluationAlertMs'].some(key => value[key] !== undefined && (!integer(value[key]) || value[key] > 2147483647)) ||
      !['pageSize', 'maxRows', 'maxBytes', 'maxTenants', 'recoveryIntervalMs', 'timeIntervalMs'].every(k => integer(value[k])) ||
      value.pageSize > value.maxRows || value.recoveryIntervalMs > 2147483647 || value.timeIntervalMs > 2147483647 ||
      typeof value.consumer !== 'string' || !/^evaluator-[A-Za-z0-9_-]{1,112}$/.test(value.consumer) ||
      !exact(value.postgres, ['connectionEnv', 'namespaces']) ||
      !exact(value.postgres.namespaces, [...domains, 'clock', 'checkpoint'], ['changeStamps'])) invalid();
  const namespaces = value.postgres.namespaces, names = Object.values(namespaces);
  if (new Set(names).size !== names.length || names.some(name => typeof name !== 'string' ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(name) || ['public', 'information_schema'].includes(name) || name.startsWith('pg_'))) invalid();
  const reference = value.postgres.connectionEnv;
  if (typeof reference !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(reference)) invalid();
  let connectionString;
  if (!metadataOnly) {
    if (typeof source[reference] !== 'string') invalid();
    connectionString = source[reference];
    require('./evaluator-consumer-config').endpoint(connectionString);
  }
  if (value.datastore !== undefined) {
    const expected = descriptorEndpoint(value.datastore);
    if (!metadataOnly && require('./evaluator-consumer-config').endpoint(connectionString) !== expected) invalid();
  }
  if (registryMode ? settingsRequired && value.tenantSettings === undefined : (!Array.isArray(value.tenants) || !value.tenants.length || value.tenants.length > value.maxTenants)) invalid();
  const tenants = new Map();
  for (const tenant of registryMode ? [] : value.tenants) {
    if (!exact(tenant, ['id', 'revision', 'settings'], ['extendedSettings']) || typeof tenant.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant.id) || tenants.has(tenant.id) ||
        typeof tenant.revision !== 'string' || !tenant.revision.length || tenant.revision.length > 128 ||
        !tenant.settings || typeof tenant.settings !== 'object' || Array.isArray(tenant.settings)) invalid();
    if (value.tenantSettings && Object.keys(tenant.settings).length) invalid();
    const env = environment(tenant);
    // Refuse unsupported/mistyped input rather than pretending it is effective.
    if (!isDeepStrictEqual(tenant.settings, env.settings.filteredSettings(tenant.settings)) ||
        tenant.extendedSettings !== undefined && !isDeepStrictEqual(tenant.extendedSettings, env.extendedSettings)) invalid();
    tenants.set(tenant.id, entryOf(tenant));
  }
  if (value.socketOrderDomains !== undefined && (!Array.isArray(value.socketOrderDomains) ||
      new Set(value.socketOrderDomains).size !== value.socketOrderDomains.length ||
      value.socketOrderDomains.some(domain => !['treatments', 'devicestatus', 'profile'].includes(domain)))) invalid();
  let tenantSettings;
  if (value.tenantSettings !== undefined) {
    // Metadata readers still need their own explicit read credential to match
    // notification identities to the committed configuration; never reuse the
    // clinical/notification database identity for this capability.
    if (source) tenantSettings = require('./settings-config')(value.tenantSettings, source,
      { namespaces, connections: metadataOnly ? [] : [connectionString] }, { invalid });
    else if (!metadataOnly || !exact(value.tenantSettings, ['connectionEnv', 'namespaces']) ||
      typeof value.tenantSettings.connectionEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(value.tenantSettings.connectionEnv) ||
      !exact(value.tenantSettings.namespaces, ['settings', 'operatorPolicy']) ||
      new Set(Object.values(value.tenantSettings.namespaces)).size !== 2 ||
      Object.values(value.tenantSettings.namespaces).some(name => typeof name !== 'string' ||
        !/^[a-z][a-z0-9_]{0,62}$/.test(name) || ['public', 'information_schema'].includes(name) ||
        name.startsWith('pg_') || names.includes(name))) invalid();
  }
  if (tenantSettings && value.datastore &&
      require('./evaluator-consumer-config').endpoint(tenantSettings.connectionString) !== descriptorEndpoint(value.datastore)) invalid();
  // Optional durable pause/suspend eligibility (lib/tenant-activity).
  const activity = value.activity === undefined ? undefined
    : require('../../tenant-activity/config').parse(value.activity, metadataOnly ? undefined : source, { invalid, reserved: names });
  if (value.changeFeed !== undefined && !activity) invalid();
  const infrastructure = { ...value }; delete infrastructure.tenants;
  const registry = registryMode ? require('./registry-config').registry(value.registry, invalid) : undefined;
  const changeFeed = value.changeFeed === undefined ? undefined : require('../../change-feed/config').parse(value.changeFeed,metadataOnly ? undefined : source);
  // Acquire retained placement resources only after pure configuration checks.
  const consumers = metadataOnly ? require('./evaluator-consumer-config').metadata(value.consumers, namespaces)
    : require('./evaluator-consumer-config')(value.consumers, source, namespaces, connectionString, internal);
  try {
    return { ...value, tenantSettings, activity, changeFeed, namespaces, ...(metadataOnly ? {} : {connectionString}), tenants, consumers, registry,
    ...(registryMode ? { tenantIds: Object.freeze(['registry:' + registry.namespace]) } : {}),
    infrastructure: identity(metadataOnly ? [infrastructure] : [infrastructure, connectionString, consumers]) };
  } catch (error) { consumers?.realtime?.placement?.close(); throw error; }
}

function descriptorEndpoint (value) {
  if (!exact(value, ['hostname','port','database']) || typeof value.hostname !== 'string' || !value.hostname ||
      !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535 ||
      typeof value.database !== 'string' || !value.database || Buffer.byteLength(value.database) > 63 || Array.from(value.database).some(char=>char.charCodeAt(0)<32 || char.charCodeAt(0)===127)) invalid();
  let url;
  try {url = new URL('postgres://' + value.hostname + ':' + value.port + '/' + encodeURIComponent(value.database));} catch {invalid();}
  if (url.hostname !== value.hostname.toLowerCase() || url.username || url.password || url.search || url.hash ||
      url.port !== String(value.port) || decodeURIComponent(url.pathname.slice(1)) !== value.database) invalid();
  return JSON.stringify([url.hostname,value.port.toString(),value.database]);
}
function parse (value, source, internal, options) {return parseInternal(value, source, false, internal, options);}
function parseMetadata (value) {return parseInternal(value, undefined, true);}
function loadInternal (source, metadataOnly, internal) {
  const file = source.MULTITENANT_EVALUATOR_CONFIG;
  if (typeof file !== 'string' || !file) invalid();
  let initialized = false;
  function read () {
    // Bounded read (MULTITENANT_CONFIG_MAX_BYTES); each refusal names its cause.
    const value = configFile.readJson(file, { source, label: 'MULTITENANT_EVALUATOR_CONFIG', Type: PreviewConfigError });
    try {
      const parsed = parseInternal(value, source, metadataOnly, internal);
      // Only boot owns the consumer transport. Later parses validate current
      // tenant settings/infrastructure and must not retain another file handle.
      if (initialized) {
        parsed.consumers?.realtime?.placement?.close();
        // Infrastructure identity was computed from the fresh parse above;
        // this cached projection explicitly borrows the boot-owned transport.
        parsed.consumers = initial.consumers;
      }
      return parsed;
    } catch (error) { if (error instanceof PreviewConfigError && error.message === require('./registry-config').REFUSAL) throw error; invalid(); }
  }
  const initial = read(); initialized = true;
  // readCurrent runs for every tenant on every check and cycle; parsing the
  // whole file (every tenant's environment) each time made a pass O(N^2) in
  // tenants (measured: the evaluator process CPU-bound at 1,000 tenants). The
  // parse is reused while the file's identity (inode, size, mtime, ctime) is
  // unchanged, so an edit or an atomic replacement is still read on the next call.
  let cached = null;
  function currentConfig () {
    let key;
    try { const stat = fs.statSync(file); key = [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':'); } catch { invalid(); }
    if (cached && cached.key === key) return cached.value;
    const value = read(); cached = { key, value };
    return value;
  }
  let validated = initial;
  return Object.freeze({ ...initial, async readCurrent (tenant) {
    const current = currentConfig();
    if (current !== validated && (current.infrastructure !== initial.infrastructure || [...current.tenants.keys()].some(id => !initial.tenants.has(id)))) {
      throw new PreviewConfigError('evaluator preview infrastructure or tenant expansion requires restart');
    }
    validated = current;
    const selected = current.tenants.get(tenant);
    if (!selected) return null;
    return withSettings(current, selected, tenant);
  } });
}
// The current effective configuration of one tenant: its entry, with the
// committed tenant settings applied when the settings store is selected.
async function withSettings (current, selected, tenant) {
  if (!current.tenantSettings) return selected;
  // A finite per-operation resource keeps metadata-only consumers free of
  // hidden persistent pools. It is closed before success or refusal returns.
  const reader = await require('../../tenant-settings/effective-postgres')(current.tenantSettings);
  try { return applySettings(selected, await reader.read(tenant)); }
  finally { await reader.close(); }
}
// The evaluator is one pool kind of lib/pool-membership. Partition off: one
// evaluator owns every configured tenant. Partition on: this process's ordinal
// comes from MULTITENANT_POOL_EVALUATOR_ORDINAL and the member count from the
// pool table (set by the operator on the admin role); the slice is read on
// every scheduled pass (lib/server/serve/evaluator-pool.js).
function partitionFor (source) {
  try { return require('../../pool-membership').config.fromEnvironment('evaluator', source); }
  catch (error) { throw new PreviewConfigError(error.code === 'POOL_CONFIG_INVALID' ? error.message : 'invalid evaluator pool configuration'); }
}
// The evaluator-inspection contract is served on serve.internal by every
// partitioned member, and by a standalone evaluator only when serve.internal
// is configured explicitly (a default socket per evaluator process would
// collide between co-hosted processes).
const INTERNAL_KEYS = ['NS_SERVE_INTERNAL_SOCKET', 'NS_SERVE_INTERNAL_HOST', 'NS_SERVE_INTERNAL_PORT'];
function inspectionFor (partition, source) {
  return partition.partitioned || INTERNAL_KEYS.some(key => source && typeof source[key] === 'string' && source[key].trim() !== '');
}
function load (source, internal) {
  const partition = partitionFor(source);
  return Object.freeze({ ...loadInternal(source,false,internal), partition, inspection: inspectionFor(partition, source) });
}
function loadMetadata (source) {return loadInternal(source,true);}
function applySettings (current, state) {
  const settings = require('../../tenant-settings/catalogue').project(state.effective);
  const env = environment({ settings: { ...current.env.settings, ...settings }, extendedSettings: current.env.extendedSettings });
  return Object.freeze({ ...current, sourceIdentity: current.identity, env,
    identity: identity([current.identity, state.version, env.settings.filteredSettings(env.settings), env.settings.enable]) });
}
module.exports = { load, parse, loadMetadata, parseMetadata, descriptorEndpoint, applySettings, withSettings, registryEntry, partitionFor, inspectionFor };
