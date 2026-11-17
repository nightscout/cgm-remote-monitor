'use strict';

const { PreviewConfigError } = require('./preview-config');
const listenerConfig = require('../internal-api/listener-config');
const exact = (v, keys, optional = []) => v && typeof v === 'object' && !Array.isArray(v) && keys.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => keys.includes(k) || optional.includes(k));
const invalid = () => { throw new PreviewConfigError('invalid explicit evaluator consumer configuration'); };
const bounded = n => Number.isSafeInteger(n) && n >= 1 && n <= 2147483647;
function reference (name, source) {
  if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || typeof source[name] !== 'string' || !source[name]) invalid();
  return source[name];
}
function endpoint (text) {
  let url;
  try { url = new URL(text); } catch { invalid(); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || !url.pathname.slice(1) ||
      url.hash || [...url.searchParams.keys()].some(k => k !== 'sslmode') || url.searchParams.getAll('sslmode').length > 1 ||
      url.search && !['disable', 'verify-full'].includes(url.searchParams.get('sslmode'))) invalid();
  try { return JSON.stringify([url.hostname.toLowerCase(), url.port || '5432', decodeURIComponent(url.pathname.slice(1))]); } catch { invalid(); }
}
function postgresShape (value) {
  if (!exact(value, ['connectionEnv', 'namespace', 'maxRows', 'maxBytes', 'maxConnections']) ||
      !['maxRows', 'maxBytes', 'maxConnections'].every(k => bounded(value[k])) ||
      typeof value.connectionEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(value.connectionEnv) ||
      typeof value.namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value.namespace) ||
      ['public', 'information_schema'].includes(value.namespace) || value.namespace.startsWith('pg_')) invalid();
}
function metadata (value, namespaces, { sliced = false, consumer, metadataNamespaces = [], intakeProfile } = {}) {
  if (value === undefined) return undefined;
  if (!exact(value, ['realtime'])) invalid();
  const v = value.realtime;
  const fields = ['outbox', 'suppression', 'route', 'maxPayloadBytes', 'maxInflight', 'attemptTimeoutMs', 'retryDelayMs', 'pollIntervalMs', 'retryIntervalMs'];
  // Bound startup/recovery and active work without quiet-roster discovery.
  const optional = ['maxConcurrentTenants'];
  if (!exact(v, fields, [...optional, 'partitionMetadata']) || !fields.filter(k => !['outbox', 'suppression', 'route'].includes(k)).every(k => bounded(v[k])) ||
      optional.some(k => v[k] !== undefined && !bounded(v[k])) ||
      !exact(v.route, ['id', 'maxMessageBytes', 'operationTimeoutMs']) ||
      typeof v.route.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v.route.id) ||
      !bounded(v.route.maxMessageBytes) || !bounded(v.route.operationTimeoutMs) || v.route.operationTimeoutMs > v.attemptTimeoutMs) invalid();
  postgresShape(v.outbox); postgresShape(v.suppression);
  if (v.outbox.namespace === v.suppression.namespace || [v.outbox.namespace, v.suppression.namespace].some(n => Object.values(namespaces).includes(n)) ||
      v.maxPayloadBytes > v.outbox.maxBytes) invalid();
  const envelope = { tenant: '0'.repeat(36), id: '0'.repeat(36), attempt: 2147483647, notification: {}, receipts: [] };
  if (sliced) envelope.slice = {count: 1024, ordinal: 1023};
  const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope)) - 2;
  if (v.route.maxMessageBytes < v.maxPayloadBytes + envelopeBytes) invalid();
  const described = JSON.parse(JSON.stringify(value));
  // Static schema expectation only; this does not select a worker topology.
  if (v.partitionMetadata !== undefined) {
    const binding = v.partitionMetadata;
    if (!exact(binding, ['checkpointNamespace', 'membershipNamespace', 'lifecycleNamespace']) ||
        binding.checkpointNamespace !== namespaces.checkpoint || typeof consumer !== 'string' ||
        !/^evaluator-[A-Za-z0-9_-]{1,100}$/.test(consumer)) invalid();
    const reserved = new Set([...Object.entries(namespaces).filter(([key]) => key !== 'checkpoint').map(([,name]) => name),
      ...metadataNamespaces, v.outbox.namespace, v.suppression.namespace]);
    const profile=intakeProfile===undefined?undefined:require('../../pgstream/intake-profile').validate(intakeProfile);
    if(profile&&(binding.checkpointNamespace!==profile.binding.namespace||binding.membershipNamespace!==profile.binding.membershipNamespace||binding.lifecycleNamespace!==profile.binding.lifecycleNamespace||consumer!==profile.binding.consumer))invalid();
    if (Object.entries(binding).some(([key,name]) => reserved.has(name)&&!(profile&&key==='lifecycleNamespace'&&name===profile.binding.lifecycleNamespace))) invalid();
    try {
      described.realtime.expectedCatalogue = require('../../tenant-notifications/partition-candidate').build({
        ...binding, consumer: v.route.id, evaluatorConsumer: consumer + '-completed' }).catalogue;
    } catch { invalid(); }
  }
  return described;
}
// The route names limits only: alarms go to the realtime role's peer address
// (listener-config), the process's own serve.internal when realtime is co-resident.
module.exports = function consumers (value, source, namespaces, connectionString, internal, metadataContext = {}) {
  const described = metadata(value, namespaces, { ...metadataContext, sliced: true });
  if (!described) return undefined;
  const v = described.realtime;
  const postgres = value => {
    const connectionString = reference(value.connectionEnv, source); endpoint(connectionString);
    return Object.freeze({...value, connectionString});
  };
  const outbox = postgres(v.outbox), suppression = postgres(v.suppression);
  if (endpoint(outbox.connectionString) !== endpoint(connectionString) || endpoint(suppression.connectionString) !== endpoint(connectionString)) invalid();
  let transport;
  try { transport = (internal || listenerConfig.resolve(['evaluator'], source)).peer('realtime', {maxBytes:v.route.maxMessageBytes, timeoutMs:v.route.operationTimeoutMs}); } catch { invalid(); }
  const selected = { ...v, outbox, suppression, route: Object.freeze({ id: v.route.id, ...transport }) };
  const slicePeers = require('../../realtime-ownership').peers(source, internal || listenerConfig.resolve(['evaluator'], source), {maxBytes: v.route.maxMessageBytes, timeoutMs: v.route.operationTimeoutMs});
  if (slicePeers) Object.defineProperty(selected, 'slicePeers', {value: slicePeers, enumerable: false});
  return Object.freeze({ realtime: Object.freeze(selected) });
};
module.exports.endpoint = endpoint;
module.exports.metadata = metadata;
