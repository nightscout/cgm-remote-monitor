'use strict';

const { isDeepStrictEqual } = require('node:util');
const c = require('./contract');
const admission = require('./admission');
const common = require('../serve/evaluator-config');
const listenerConfig = require('../internal-api/listener-config');
// The alarm-delivery contract is served on this process's serve.internal; the
// api is reached at its peer address (listener-config). `internal` defaults to
// a realtime-only process.
function parse (value, source, internal = listenerConfig.resolve(['realtime'], source)) {
  const fields = ['version', 'postgres', 'consumer', 'pageSize', 'maxRows', 'maxBytes', 'maxTenants', 'recoveryIntervalMs',
    'tenants', 'admissionFileEnv', 'maxMessageBytes', 'operationTimeoutMs', 'maxSockets'];
  if (!c.exact(value, fields, ['socketOrderDomains', 'activity', 'authorizationRecheckMs']) ||
      ['authorizationRecheckMs'].some(k => value[k] !== undefined && !c.integer(value[k], 2147483647)) || typeof value.consumer !== 'string' || !/^realtime-[A-Za-z0-9_-]{1,112}$/.test(value.consumer) ||
      !['maxMessageBytes', 'maxSockets'].every(k => c.integer(value[k])) || !c.integer(value.operationTimeoutMs, 2147483647)) c.fail('REALTIME_CONFIG_REFUSED');
  // Reuse bounded PG/domain/safe-environment validation, not evaluator scheduling.
  const selected = Object.fromEntries(fields.slice(0, 9).map(k => [k, value[k]]));
  if (value.socketOrderDomains !== undefined) selected.socketOrderDomains = value.socketOrderDomains;
  selected.consumer = 'evaluator-realtime-validation'; selected.timeIntervalMs = value.recoveryIntervalMs;
  const commonConfig = common.parse(selected, source);
  const api = internal.peer('api', {maxBytes:value.maxMessageBytes, timeoutMs:value.operationTimeoutMs});
  // Optional pause/suspend: sockets of a paused or suspended tenant are refused and disconnected.
  const activity = value.activity === undefined ? undefined : require('../../tenant-activity/config').parse(value.activity, source,
    { invalid: () => c.fail('REALTIME_CONFIG_REFUSED'), reserved: Object.values(commonConfig.namespaces) });
  return { ...commonConfig, ...value, activity, connectionString: commonConfig.connectionString, namespaces: commonConfig.namespaces,
    tenants: commonConfig.tenants, api, admissionFile: c.reference(value.admissionFileEnv, source),
    infrastructure: c.identity([commonConfig.infrastructure, value.consumer, value.maxMessageBytes, value.operationTimeoutMs, value.maxSockets, api, c.reference(value.admissionFileEnv, source)]) };
}
function load (source, internal) {
  const parsed = c.parsedFile(source.MULTITENANT_REALTIME_CONFIG, value => parse(value, source, internal));
  const read = () => { try { return parsed(); } catch { c.fail('REALTIME_CONFIG_REFUSED'); } };
  const initial = read();
  let allow;
  try { allow = admission.load({ file: initial.admissionFile, maxTenants: initial.maxTenants }); } catch { c.fail('REALTIME_CONFIG_REFUSED'); }
  if (allow.ids.some(id => !initial.tenants.has(id))) c.fail('REALTIME_CONFIG_REFUSED');
  return Object.freeze({ ...initial, admission: allow,
    async readCurrent (tenant) {
      const current = read();
      if (current.infrastructure !== initial.infrastructure || !isDeepStrictEqual([...current.tenants.keys()].filter(id => !initial.tenants.has(id)), [])) c.fail('REALTIME_RESTART_REQUIRED');
      return await allow.allows(tenant) ? current.tenants.get(tenant) || null : null;
    },
    // Every requested tenant from one configuration and one admission read.
    async readAll (tenants) {
      const current = read();
      if (current.infrastructure !== initial.infrastructure || !isDeepStrictEqual([...current.tenants.keys()].filter(id => !initial.tenants.has(id)), [])) c.fail('REALTIME_RESTART_REQUIRED');
      const enabled = await allow.enabled();
      return new Map([...tenants].map(tenant => [tenant, enabled.has(tenant) ? current.tenants.get(tenant) || null : null]));
    }
  });
}
module.exports = { parse, load };
