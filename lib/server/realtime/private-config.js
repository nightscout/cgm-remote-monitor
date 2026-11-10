'use strict';

const c = require('./contract');
const endpoint = require('../internal-api/endpoint-config');
module.exports = function privateConfig (value, source, existing) {
  if (value === undefined) return undefined;
  if (!c.exact(value, ['admissionFileEnv', 'maxTenants', 'maxMessageBytes', 'operationTimeoutMs', 'alarm'], ['consumerState', 'socketPathEnv', 'endpoint']) ||
      !c.integer(value.maxTenants) || !c.integer(value.maxMessageBytes) || !c.integer(value.operationTimeoutMs, 2147483647) ||
      !c.exact(value.alarm, ['connectionEnv', 'namespace'])) c.fail('SOCKET_PRIVATE_CONFIG_REFUSED');
  const namespace = value.alarm.namespace;
  require('../../tenant-alarms/contract').table(namespace);
  if (Object.values(existing.namespaces).includes(namespace)) c.fail('SOCKET_PRIVATE_CONFIG_REFUSED');
  const connectionString = c.reference(value.alarm.connectionEnv, source);
  let url; try { url = new URL(connectionString); } catch { c.fail('SOCKET_PRIVATE_CONFIG_REFUSED'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || !url.pathname.slice(1) ||
      url.hash || [...url.searchParams.keys()].some(k => k !== 'sslmode') || url.searchParams.getAll('sslmode').length > 1 ||
      url.search && !['disable', 'verify-full'].includes(url.searchParams.get('sslmode'))) c.fail('SOCKET_PRIVATE_CONFIG_REFUSED');
  for (const address of existing.connections) {
    const other = new URL(address);
    let sameUser;
    try { sameUser = decodeURIComponent(url.username) === decodeURIComponent(other.username); } catch { c.fail('SOCKET_PRIVATE_CONFIG_REFUSED'); }
    if (sameUser || url.hostname !== other.hostname || url.port !== other.port || url.pathname !== other.pathname) c.fail('SOCKET_PRIVATE_CONFIG_REFUSED');
  }
  return Object.freeze({ ipc: endpoint(endpoint.select(value), source, {maxBytes:value.maxMessageBytes, timeoutMs:value.operationTimeoutMs}),
    admissionFile: c.reference(value.admissionFileEnv, source), maxTenants: value.maxTenants,
    consumerState: require('./notification-state-config')(value.consumerState, source, {connectionString, namespace}),
    alarm: Object.freeze({ connectionString, namespace }) });
};
