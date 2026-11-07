'use strict';

const { isDeepStrictEqual } = require('node:util');
const c = require('./contract');
const admission = require('./admission');
const common = require('../serve/evaluator-config');
const ipc = require('./ipc');
function parse (value, source) {
  const fields = ['version', 'postgres', 'consumer', 'pageSize', 'maxRows', 'maxBytes', 'maxTenants', 'recoveryIntervalMs',
    'tenants', 'admissionFileEnv', 'apiSocketPathEnv', 'alarmSocketPathEnv', 'maxMessageBytes', 'operationTimeoutMs', 'maxSockets'];
  if (!c.exact(value, fields) || typeof value.consumer !== 'string' || !/^realtime-[A-Za-z0-9_-]{1,112}$/.test(value.consumer) ||
      !['maxMessageBytes', 'maxSockets'].every(k => c.integer(value[k])) || !c.integer(value.operationTimeoutMs, 2147483647)) c.fail('REALTIME_CONFIG_REFUSED');
  // Reuse bounded PG/domain/safe-environment validation, not evaluator scheduling.
  const selected = Object.fromEntries(fields.slice(0, 9).map(k => [k, value[k]]));
  selected.consumer = 'evaluator-realtime-validation'; selected.timeIntervalMs = value.recoveryIntervalMs;
  const commonConfig = common.parse(selected, source);
  const api = ipc.options({ socketPath: c.reference(value.apiSocketPathEnv, source), maxBytes: value.maxMessageBytes, timeoutMs: value.operationTimeoutMs });
  const alarms = ipc.options({ socketPath: c.reference(value.alarmSocketPathEnv, source), maxBytes: value.maxMessageBytes, timeoutMs: value.operationTimeoutMs });
  if (api.socketPath === alarms.socketPath) c.fail('REALTIME_CONFIG_REFUSED');
  return { ...commonConfig, ...value, connectionString: commonConfig.connectionString, namespaces: commonConfig.namespaces,
    tenants: commonConfig.tenants, api, alarms, admissionFile: c.reference(value.admissionFileEnv, source),
    infrastructure: c.identity([commonConfig.infrastructure, value.consumer, value.maxMessageBytes, value.operationTimeoutMs, value.maxSockets, api, alarms, c.reference(value.admissionFileEnv, source)]) };
}
function load (source) {
  const read = () => { try { return parse(c.file(source.MULTITENANT_REALTIME_CONFIG), source); } catch { c.fail('REALTIME_CONFIG_REFUSED'); } };
  const initial = read();
  let allow;
  try { allow = admission.load({ file: initial.admissionFile, maxTenants: initial.maxTenants }); } catch { c.fail('REALTIME_CONFIG_REFUSED'); }
  if (allow.ids.some(id => !initial.tenants.has(id))) c.fail('REALTIME_CONFIG_REFUSED');
  return Object.freeze({ ...initial, admission: allow,
    async readCurrent (tenant) {
      const current = read();
      if (current.infrastructure !== initial.infrastructure || !isDeepStrictEqual([...current.tenants.keys()].filter(id => !initial.tenants.has(id)), [])) c.fail('REALTIME_RESTART_REQUIRED');
      return await allow.allows(tenant) ? current.tenants.get(tenant) || null : null;
    }
  });
}
module.exports = { parse, load };
