'use strict';

// Maintained evaluator configuration and committed presentation settings.
// Product work comes only from pgstream and actual clinical due times.
const { createHash } = require('node:crypto');
const environment = require('../tenant-app/environment');
const domains = require('../../data/tenant-projection-evaluator').domains;
const { PreviewConfigError } = require('./preview-config');
const configFile = require('./config-file');
const listenerConfig = require('../internal-api/listener-config');
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

function parseInternal (value, source, metadataOnly, internal) {
  if (!metadataOnly) assertSupportedPartition(partitionFor(source));
  // The product evaluator has one maintained input transport and one durable
  // output handoff. Removed discovery transports are refused, never selected.
  const registryMode = !!value && typeof value === 'object' && Object.hasOwn(value, 'registry');
  if (registryMode && Object.hasOwn(value, 'tenants')) throw new PreviewConfigError(require('./registry-config').REFUSAL);
  if (!registryMode) invalid();
  const required = ['version', 'postgres', 'consumer', 'pageSize', 'maxRows', 'maxBytes', 'maxTenants',
    'timeIntervalMs', 'registry', 'pgstream', 'trustedWorker', 'tenantSettings', 'activity'];
  if (!exact(value, required, ['consumers', 'socketOrderDomains', 'datastore', 'evictAfterMs', 'evaluationAlertMs']) || value.version !== 1 ||
      ['evictAfterMs', 'evaluationAlertMs'].some(key => value[key] !== undefined && (!integer(value[key]) || value[key] > 2147483647)) ||
      !['pageSize', 'maxRows', 'maxBytes', 'maxTenants', 'timeIntervalMs'].every(k => integer(value[k])) ||
      value.pageSize > value.maxRows || value.timeIntervalMs > 2147483647 ||
      typeof value.consumer !== 'string' || !/^evaluator-[A-Za-z0-9_-]{1,112}$/.test(value.consumer) ||
      !exact(value.postgres, ['connectionEnv', 'namespaces']) ||
      !exact(value.postgres.namespaces, [...domains, 'clock', 'checkpoint'])) invalid();
  const namespaces = value.postgres.namespaces, names = Object.values(namespaces);
  if (value.trustedWorker !== undefined) {
    const worker = require('../../trusted-worker/postgres').parse(value.trustedWorker);
    if (!registryMode || worker.clock !== namespaces.clock || worker.activity !== value.activity?.namespace ||
        worker.settings !== value.tenantSettings?.namespaces?.settings || worker.operatorPolicy !== value.tenantSettings?.namespaces?.operatorPolicy) invalid();
  }
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
  const tenants = new Map();
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
  let pgstream=require('../../pgstream/config').parse(value.pgstream,metadataOnly?undefined:source);
  if(!metadataOnly)pgstream={...pgstream,outputPeer:(internal||listenerConfig.resolve(['evaluator'],source)).peer('realtime',{maxBytes:4096,timeoutMs:1000})};
  if(value.consumer.length>110)invalid();
  const infrastructure = { ...value };
  const registry = require('./registry-config').registry(value.registry, invalid);
  // Acquire retained placement resources only after pure configuration checks.
  const consumers = metadataOnly ? require('./evaluator-consumer-config').metadata(value.consumers, namespaces)
    : require('./evaluator-consumer-config')(value.consumers, source, namespaces, connectionString, internal);
  try {
    return { ...value, tenantSettings, activity, pgstream, namespaces, ...(metadataOnly ? {} : {connectionString}), tenants, consumers, registry,
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
  let initialized = false, lastText, lastParsed;
  function read () {
    // Bounded read (MULTITENANT_CONFIG_MAX_BYTES); each refusal names its cause.
    const options = { source, label: 'MULTITENANT_EVALUATOR_CONFIG', Type: PreviewConfigError };
    const current = configFile.read(file, options).toString('utf8');
    if (current === lastText) return lastParsed;
    const value = configFile.parse(current, options);
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
      lastText = current; lastParsed = parsed;
      return parsed;
    } catch (error) { if (error instanceof PreviewConfigError && error.message === require('./registry-config').REFUSAL) throw error; invalid(); }
  }
  const initial = read(); initialized = true;
  // Metadata callers revalidate bounded infrastructure on explicit access.
  // The product registry runtime installs its admitted per-tenant SQL reader.
  const currentConfig = read;
  let validated = initial;
  return Object.freeze({ ...initial, async readCurrent (tenant, settingsReader, registryAdmission) {
    const current = currentConfig();
    if (current !== validated && (current.infrastructure !== initial.infrastructure)) {
      throw new PreviewConfigError('evaluator infrastructure change requires restart');
    }
    validated = current;
    if (current.registry) {
      // Metadata-only ACK readers borrow the API's existing admitted registry
      // capability. A registry file is not a static roster and cannot admit a
      // tenant by itself. No tenant is inserted into this metadata reader's map.
      if (!metadataOnly || !exact(registryAdmission, ['namespace', 'allows']) ||
          registryAdmission.namespace !== current.registry.namespace || typeof registryAdmission.allows !== 'function' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant || '') ||
          tenant === '00000000-0000-0000-0000-000000000000' || !await registryAdmission.allows(tenant)) return null;
      const selected = registryEntry(tenant);
      const result = await withSettings(current, selected, tenant, settingsReader);
      return await registryAdmission.allows(tenant) ? result : null;
    }
    return null;
  } });
}
// The current effective configuration of one tenant: its entry, with the
// committed tenant settings applied when the settings store is selected.
async function withSettings (current, selected, tenant, settingsReader) {
  if (!current.tenantSettings) return selected;
  if (settingsReader) {
    if (!settingsReader.matches(current.tenantSettings)) throw new PreviewConfigError('evaluator settings connection or namespaces require restart');
    return applySettings(selected, await settingsReader.read(tenant));
  }
  // A finite per-operation resource keeps metadata-only consumers free of
  // hidden persistent pools. It is closed before success or refusal returns.
  const reader = await require('../../tenant-settings/effective-postgres')(current.tenantSettings);
  try { return applySettings(selected, await reader.read(tenant)); }
  finally { await reader.close(); }
}
// Pure pool metadata remains available to roster and inspection tooling.
// The maintained evaluator runner admits only its qualified standalone mode.
function partitionFor (source) {
  try { return require('../../pool-membership').config.fromEnvironment('evaluator', source); }
  catch (error) { throw new PreviewConfigError(error.code === 'POOL_CONFIG_INVALID' ? error.message : 'invalid evaluator pool configuration'); }
}
// Pure inspection selection is independent of execution support. Standalone
// execution exposes this read only with an explicit serve.internal address.
const INTERNAL_KEYS = ['NS_SERVE_INTERNAL_SOCKET', 'NS_SERVE_INTERNAL_HOST', 'NS_SERVE_INTERNAL_PORT'];
function inspectionFor (partition, source) {
  return partition.partitioned || INTERNAL_KEYS.some(key => source && typeof source[key] === 'string' && source[key].trim() !== '');
}
const PARTITION_UNQUALIFIED = 'PGSTREAM_EVALUATOR_PARTITION_UNQUALIFIED';
function assertSupportedPartition (partition) {
  if (partition?.partitioned) throw Object.assign(new PreviewConfigError(PARTITION_UNQUALIFIED), { code: PARTITION_UNQUALIFIED });
}
function load (source, internal) {
  const partition = partitionFor(source);
  assertSupportedPartition(partition);
  return Object.freeze({ ...loadInternal(source,false,internal), partition, inspection: inspectionFor(partition, source) });
}
function loadMetadata (source) {return loadInternal(source,true);}
function applySettings (current, state) {
  const settings = require('../../tenant-settings/catalogue').project(state.effective);
  const env = environment({ settings: { ...current.env.settings, ...settings }, extendedSettings: current.env.extendedSettings });
  return Object.freeze({ ...current, sourceIdentity: current.identity, env, settingsVersion: state.version, policyGeneration: state.policyGeneration, settingsReadAt: state.readAt,
    identity: identity([current.identity, state.version, env.settings.filteredSettings(env.settings), env.settings.enable]) });
}
module.exports = { load, parse, loadMetadata, parseMetadata, descriptorEndpoint, applySettings, withSettings, registryEntry, partitionFor, inspectionFor, assertSupportedPartition, PARTITION_UNQUALIFIED };
