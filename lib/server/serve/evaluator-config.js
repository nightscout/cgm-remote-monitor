'use strict';

// Maintained evaluator configuration and committed presentation settings.
// Product work comes only from pgstream and actual clinical due times.
const { createHash } = require('node:crypto');
const environment = require('../tenant-app/environment');
const domains = require('../../data/tenant-projection-evaluator').domains;
const { PreviewConfigError } = require('./preview-config');
const listenerConfig = require('../internal-api/listener-config');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const identity = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const invalid = () => { throw new PreviewConfigError('invalid explicit evaluator preview configuration'); };
const exact = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const integer = n => Number.isSafeInteger(n) && n >= 1;
const DEFAULT_WORKING_SET_LIMIT = 10000;

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
  // The product evaluator has one maintained input transport and one durable
  // output handoff. Removed discovery transports are refused, never selected.
  const registryMode = !!value && typeof value === 'object' && Object.hasOwn(value, 'registry');
  if (registryMode && Object.hasOwn(value, 'tenants')) throw new PreviewConfigError(require('./registry-config').REFUSAL);
  if (!registryMode) invalid();
  const required = ['version', 'postgres', 'consumer', 'pageSize', 'maxRows', 'maxBytes',
    'timeIntervalMs', 'registry', 'pgstream', 'trustedWorker', 'tenantSettings', 'activity'];
  if (!exact(value, required, ['maxTenants', 'consumers', 'socketOrderDomains', 'datastore', 'evictAfterMs', 'evaluationAlertMs', 'writerDriven']) || value.version !== 1 ||
      ['evictAfterMs', 'evaluationAlertMs'].some(key => value[key] !== undefined && (!integer(value[key]) || value[key] > 2147483647)) ||
      !['pageSize', 'maxRows', 'maxBytes', 'timeIntervalMs'].every(k => integer(value[k])) ||
      Object.hasOwn(value, 'maxTenants') && !integer(value.maxTenants) ||
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
  // Writer-driven input (lib/writer-driven): no stream source, recovery login
  // or incarnation; the pending sweep interval and the lifecycle catalogue.
  let writerDriven;
  if (value.writerDriven !== undefined) {
    if (!exact(value.writerDriven, ['sweepMs', 'lifecycleNamespace']) || !integer(value.writerDriven.sweepMs) || value.writerDriven.sweepMs < 100 ||
        value.writerDriven.sweepMs > 600000 || typeof value.writerDriven.lifecycleNamespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value.writerDriven.lifecycleNamespace) ||
        value.writerDriven.lifecycleNamespace !== value.activity?.namespace || value.pgstream?.recovery !== undefined || value.pgstream?.generation !== undefined) invalid();
    writerDriven = Object.freeze({ ...value.writerDriven });
  }
  let pgstream=require('../../pgstream/config').parse(value.pgstream);
  if(!metadataOnly&&pgstream.recovery){const uri=source[pgstream.recovery.connectionEnv];if(typeof uri!=='string'||require('./evaluator-consumer-config').endpoint(uri)!==require('./evaluator-consumer-config').endpoint(connectionString)||decodeURIComponent(new URL(uri).username)!==pgstream.streamRole)invalid();pgstream={...pgstream,recovery:{...pgstream.recovery,connectionString:uri}};}
  if(!metadataOnly)pgstream={...pgstream,outputPeer:(internal||listenerConfig.resolve(['evaluator'],source)).peer('realtime',{maxBytes:4096,timeoutMs:1000}),outputPeers:require('../../realtime-ownership').peers(source,internal||listenerConfig.resolve(['evaluator'],source),{maxBytes:4096,timeoutMs:1000})};
  const assigned=metadataOnly?undefined:require('../../pgstream/assigned-worker').hostAssignment(source,pgstream.receiver);
  // The slice's own receiver address comes from its hostname, like its ordinal.
  if(assigned)pgstream={...pgstream,receiver:{...pgstream.receiver,url:assigned.receiver}};
  const processAssignment=assigned&&Object.freeze({count:assigned.count,ordinal:assigned.ordinal,receivers:assigned.receivers});
  if(value.consumer.length>110)invalid();
  const infrastructure = { ...value };
  const registry = require('./registry-config').registry(value.registry, invalid);
  // Acquire retained placement resources only after pure configuration checks.
  const consumers = metadataOnly ? require('./evaluator-consumer-config').metadata(value.consumers, namespaces)
    : require('./evaluator-consumer-config')(value.consumers, source, namespaces, connectionString, internal);
  try {
    return { ...value, ...(writerDriven ? { writerDriven } : {}), maxTenants: value.maxTenants ?? DEFAULT_WORKING_SET_LIMIT, tenantSettings, activity, pgstream,processAssignment, namespaces, ...(metadataOnly ? {} : {connectionString, residentLimit: residentLimit(source)}), tenants, consumers, registry,
    ...(registryMode ? { tenantIds: Object.freeze(['registry:' + registry.namespace]) } : {}),
    infrastructure: identity(metadataOnly ? [infrastructure] : [infrastructure, connectionString, consumers]) };
  } catch (error) { consumers?.realtime?.slicePeers?.close?.(); throw error; }
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
// The evaluator configuration, built from the environment
// (lib/server/serve/deployment-settings.js). `metadataOnly` is the api's
// read-only view: outbox and suppression, no evaluator credentials.
function loadInternal (raw, metadataOnly, internal) {
  const settings = require('./deployment-settings'), source = settings.withSecrets(raw);
  let initial;
  try { initial = parseInternal(settings.evaluator(source, { metadata: metadataOnly }), source, metadataOnly, internal); }
  catch (error) { if (error instanceof PreviewConfigError && error.message === require('./registry-config').REFUSAL) throw error; invalid(); }
  return Object.freeze({ ...initial, async readCurrent (tenant, settingsReader, registryAdmission) {
    // Metadata-only ACK readers borrow the API's existing admitted registry
    // capability; no tenant is inserted into this metadata reader's map.
    if (!metadataOnly || !exact(registryAdmission, ['namespace', 'allows']) ||
        registryAdmission.namespace !== initial.registry.namespace || typeof registryAdmission.allows !== 'function' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant || '') ||
        tenant === '00000000-0000-0000-0000-000000000000' || !await registryAdmission.allows(tenant)) return null;
    const result = await withSettings(initial, registryEntry(tenant), tenant, settingsReader);
    return await registryAdmission.allows(tenant) ? result : null;
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
  const reader = await require('../../tenant-settings/effective-postgres')(current.tenantSettings, { pool: require('./pool-config').pool('evaluator') });
  try { return applySettings(selected, await reader.read(tenant)); }
  finally { await reader.close(); }
}
// The private inspection read is exposed only with an explicit serve.internal address.
const INTERNAL_KEYS = ['NS_SERVE_INTERNAL_SOCKET', 'NS_SERVE_INTERNAL_HOST', 'NS_SERVE_INTERNAL_PORT'];
function inspectionFor (source) {
  return INTERNAL_KEYS.some(key => source && typeof source[key] === 'string' && source[key].trim() !== '');
}
// Clinical models kept in memory between cycles: NS_EVALUATOR_RESIDENT_MAX
// (default 256). Independent of the evaluator pool size; an evicted model is
// rebuilt from its durable output on the next cycle.
function residentLimit (source = process.env) {
  const raw = source.NS_EVALUATOR_RESIDENT_MAX;
  if (raw === undefined || raw === '') return 256;
  if (!/^[1-9][0-9]{0,5}$/.test(raw)) throw new PreviewConfigError('invalid NS_EVALUATOR_RESIDENT_MAX: a whole number from 1 to 999999 is required');
  return Number(raw);
}
function load (source, internal) {
  const value=loadInternal(source,false,internal);
  return Object.freeze({ ...value, inspection: inspectionFor(source) });
}
function loadMetadata (source) {return loadInternal(source,true);}
function applySettings (current, state) {
  const settings = require('../../tenant-settings/catalogue').project(state.effective);
  const env = environment({ settings: { ...current.env.settings, ...settings }, extendedSettings: current.env.extendedSettings });
  return Object.freeze({ ...current, sourceIdentity: current.identity, env, settingsVersion: state.version, policyGeneration: state.policyGeneration, settingsReadAt: state.readAt,
    identity: identity([current.identity, state.version, env.settings.filteredSettings(env.settings), env.settings.enable]) });
}
module.exports = { load, parse, loadMetadata, parseMetadata, descriptorEndpoint, applySettings, withSettings, registryEntry, inspectionFor, residentLimit };
