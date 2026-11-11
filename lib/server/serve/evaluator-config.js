'use strict';

// Operator-trusted preview configuration, independent of human authorization and
// current owner settings. Read afresh at every cycle; no clinical row is rewritten.
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const environment = require('../tenant-app/environment');
const domains = require('../../data/tenant-projection-evaluator').domains;
const { PreviewConfigError } = require('./preview-config');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const identity = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const invalid = () => { throw new PreviewConfigError('invalid explicit evaluator preview configuration'); };
const exact = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const integer = n => Number.isSafeInteger(n) && n >= 1;

function parseInternal (value, source, metadataOnly, internal) {
  const required = ['version', 'postgres', 'consumer', 'pageSize', 'maxRows', 'maxBytes', 'maxTenants',
    'recoveryIntervalMs', 'timeIntervalMs', 'tenants'];
  if (!exact(value, required, ['consumers', 'socketOrderDomains', 'datastore', 'tenantSettings', 'activity']) || value.version !== 1 ||
      !['pageSize', 'maxRows', 'maxBytes', 'maxTenants', 'recoveryIntervalMs', 'timeIntervalMs'].every(k => integer(value[k])) ||
      value.pageSize > value.maxRows || value.recoveryIntervalMs > 2147483647 || value.timeIntervalMs > 2147483647 ||
      typeof value.consumer !== 'string' || !/^evaluator-[A-Za-z0-9_-]{1,112}$/.test(value.consumer) ||
      !exact(value.postgres, ['connectionEnv', 'namespaces']) ||
      !exact(value.postgres.namespaces, [...domains, 'clock', 'checkpoint'])) invalid();
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
  if (!Array.isArray(value.tenants) || !value.tenants.length || value.tenants.length > value.maxTenants) invalid();
  const tenants = new Map();
  for (const tenant of value.tenants) {
    if (!exact(tenant, ['id', 'revision', 'settings'], ['extendedSettings']) || typeof tenant.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant.id) || tenants.has(tenant.id) ||
        typeof tenant.revision !== 'string' || !tenant.revision.length || tenant.revision.length > 128 ||
        !tenant.settings || typeof tenant.settings !== 'object' || Array.isArray(tenant.settings)) invalid();
    if (value.tenantSettings && Object.keys(tenant.settings).length) invalid();
    const env = environment(tenant);
    // Refuse unsupported/mistyped input rather than pretending it is effective.
    if (!isDeepStrictEqual(tenant.settings, env.settings.filteredSettings(tenant.settings)) ||
        tenant.extendedSettings !== undefined && !isDeepStrictEqual(tenant.extendedSettings, env.extendedSettings)) invalid();
    const effective = { revision: tenant.revision, settings: env.settings.filteredSettings(env.settings),
      extendedSettings: env.extendedSettings, plugins: [...env.settings.enable] };
    tenants.set(tenant.id, Object.freeze({ tenant: tenant.id, revision: tenant.revision, identity: identity(effective), env }));
  }
  const consumers = metadataOnly ? require('./evaluator-consumer-config').metadata(value.consumers, namespaces)
    : require('./evaluator-consumer-config')(value.consumers, source, namespaces, connectionString, internal);
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
  const infrastructure = { ...value }; delete infrastructure.tenants;
  return { ...value, tenantSettings, activity, namespaces, ...(metadataOnly ? {} : {connectionString}), tenants, consumers,
    infrastructure: identity(metadataOnly ? [infrastructure] : [infrastructure, connectionString, consumers]) };
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
function parse (value, source, internal) {return parseInternal(value, source, false, internal);}
function parseMetadata (value) {return parseInternal(value, undefined, true);}
function loadInternal (source, metadataOnly, internal) {
  const file = source.MULTITENANT_EVALUATOR_CONFIG;
  if (typeof file !== 'string' || !file) invalid();
  function read () {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 1048576) invalid();
      const bytes = fs.readFileSync(file); if (bytes.length > 1048576) invalid();
      return parseInternal(JSON.parse(bytes.toString('utf8')), source, metadataOnly, internal);
    } catch { invalid(); }
  }
  const initial = read();
  return Object.freeze({ ...initial, async readCurrent (tenant) {
    const current = read();
    if (current.infrastructure !== initial.infrastructure || [...current.tenants.keys()].some(id => !initial.tenants.has(id))) {
      throw new PreviewConfigError('evaluator preview infrastructure or tenant expansion requires restart');
    }
    const selected = current.tenants.get(tenant);
    if (!selected) return null;
    if (!current.tenantSettings) return selected;
    // A finite per-operation resource keeps metadata-only consumers free of
    // hidden persistent pools. It is closed before success or refusal returns.
    const reader = await require('../../tenant-settings/effective-postgres')(current.tenantSettings);
    try { return applySettings(selected, await reader.read(tenant)); }
    finally { await reader.close(); }
  } });
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
module.exports = { load, parse, loadMetadata, parseMetadata, descriptorEndpoint, applySettings, partitionFor, inspectionFor };
