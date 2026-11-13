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
function metadata (value, namespaces, { placement = false } = {}) {
  if (value === undefined) return undefined;
  if (!exact(value, ['realtime'])) invalid();
  const v = value.realtime;
  const fields = ['outbox', 'suppression', 'route', 'maxPayloadBytes', 'maxInflight', 'attemptTimeoutMs', 'retryDelayMs', 'pollIntervalMs', 'retryIntervalMs'];
  // Optional (decision cost-proportional-to-activity): the slow backstop pass
  // over every tenant, and how many tenants a pass works at once.
  const optional = ['backstopIntervalMs', 'maxConcurrentTenants'];
  if (!exact(v, fields, optional) || !fields.filter(k => !['outbox', 'suppression', 'route'].includes(k)).every(k => bounded(v[k])) ||
      optional.some(k => v[k] !== undefined && !bounded(v[k])) ||
      !exact(v.route, ['id', 'maxMessageBytes', 'operationTimeoutMs']) ||
      typeof v.route.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v.route.id) ||
      !bounded(v.route.maxMessageBytes) || !bounded(v.route.operationTimeoutMs) || v.route.operationTimeoutMs > v.attemptTimeoutMs) invalid();
  postgresShape(v.outbox); postgresShape(v.suppression);
  if (v.outbox.namespace === v.suppression.namespace || [v.outbox.namespace, v.suppression.namespace].some(n => Object.values(namespaces).includes(n)) ||
      v.maxPayloadBytes > v.outbox.maxBytes) invalid();
  const envelope = { tenant: '0'.repeat(36), id: '0'.repeat(36), attempt: 2147483647, notification: {}, receipts: [] };
  if (placement) envelope.placement = { generation: Number.MAX_SAFE_INTEGER, shard: 65535, worker: 'w'.repeat(63), incarnation: '0'.repeat(36) };
  const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope)) - 2;
  if (v.route.maxMessageBytes < v.maxPayloadBytes + envelopeBytes) invalid();
  return JSON.parse(JSON.stringify(value));
}
// The route names limits only: alarms go to the realtime role's peer address
// (listener-config), the process's own serve.internal when realtime is co-resident.
module.exports = function consumers (value, source, namespaces, connectionString, internal) {
  const described = metadata(value, namespaces, { placement: source.MULTITENANT_REALTIME_PLACEMENT !== undefined || source.MULTITENANT_REALTIME_ROUTES !== undefined });
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
  // Placement is transport state, excluded deliberately from clinical/config
  // identity so an owner move cannot retire or mint notification intent.
  const placement = require('../../realtime-placement').loadRoutes(source, { internal: internal || listenerConfig.resolve(['evaluator'], source), maxBytes: v.route.maxMessageBytes, timeoutMs: v.route.operationTimeoutMs });
  if (placement) Object.defineProperty(selected, 'placement', { value: placement, enumerable: false });
  return Object.freeze({ realtime: Object.freeze(selected) });
};
module.exports.endpoint = endpoint;
module.exports.metadata = metadata;
