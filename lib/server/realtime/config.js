'use strict';

const { isDeepStrictEqual } = require('node:util');
const c = require('./contract');
const admission = require('./admission');
const common = require('../serve/evaluator-config');
const listenerConfig = require('../internal-api/listener-config');
// The alarm-delivery contract is served on this process's serve.internal; the
// api is reached at its peer address (listener-config). `internal` defaults to
// a realtime-only process.
//
// Registry mode (decision tenant-registry): `registry` in place of `tenants`
// and `admissionFileEnv`. The tenant set, socket admission and per-tenant
// entries come from the registry at boot (lib/server/serve/preview-realtime.js);
// a configuration that also names a tenant list or an admission file is refused
// (REALTIME_REGISTRY_REFUSES_TENANT_LIST).
function parse (value, source, internal = listenerConfig.resolve(['realtime'], source)) {
  const registryMode = c.object(value) && Object.hasOwn(value, 'registry');
  if (registryMode && (Object.hasOwn(value, 'tenants') || Object.hasOwn(value, 'admissionFileEnv'))) c.fail('REALTIME_REGISTRY_REFUSES_TENANT_LIST');
  const fields = ['version', 'postgres', 'consumer', 'pageSize', 'maxRows', 'maxBytes', 'maxTenants', 'recoveryIntervalMs',
    ...(registryMode ? ['registry'] : ['tenants', 'admissionFileEnv']), 'maxMessageBytes', 'operationTimeoutMs', 'maxSockets'];
  if (!c.exact(value, fields, ['socketOrderDomains', 'activity', 'authorizationRecheckMs']) ||
      ['authorizationRecheckMs'].some(k => value[k] !== undefined && !c.integer(value[k], 2147483647)) || typeof value.consumer !== 'string' || !/^realtime-[A-Za-z0-9_-]{1,112}$/.test(value.consumer) ||
      !['maxMessageBytes', 'maxSockets'].every(k => c.integer(value[k])) || !c.integer(value.operationTimeoutMs, 2147483647)) c.fail('REALTIME_CONFIG_REFUSED');
  // Reuse bounded PG/domain/safe-environment validation, not evaluator scheduling.
  const selected = Object.fromEntries(fields.slice(0, 9).map(k => [k, value[k]]));
  if (value.socketOrderDomains !== undefined) selected.socketOrderDomains = value.socketOrderDomains;
  selected.consumer = 'evaluator-realtime-validation'; selected.timeIntervalMs = value.recoveryIntervalMs;
  // Realtime frames use each tenant's default server settings in registry mode
  // (as a static entry with empty settings), so no settings reader is required.
  const commonConfig = common.parse(selected, source, undefined, { settingsRequired: false });
  const api = internal.peer('api', {maxBytes:value.maxMessageBytes, timeoutMs:value.operationTimeoutMs});
  // Optional pause/suspend: sockets of a paused or suspended tenant are refused and disconnected.
  const activity = value.activity === undefined ? undefined : require('../../tenant-activity/config').parse(value.activity, source,
    { invalid: () => c.fail('REALTIME_CONFIG_REFUSED'), reserved: Object.values(commonConfig.namespaces) });
  const admissionFile = registryMode ? null : c.reference(value.admissionFileEnv, source);
  return { ...commonConfig, ...value, activity, connectionString: commonConfig.connectionString, namespaces: commonConfig.namespaces,
    tenants: commonConfig.tenants, api, admissionFile, registry: commonConfig.registry,
    infrastructure: c.identity([commonConfig.infrastructure, value.consumer, value.maxMessageBytes, value.operationTimeoutMs, value.maxSockets, api, admissionFile]) };
}
function load (source, internal) {
  const parsed = c.parsedFile(source.MULTITENANT_REALTIME_CONFIG, value => parse(value, source, internal), { label: 'MULTITENANT_REALTIME_CONFIG', source });
  // A bounded-read refusal (too large, not a regular file, unreadable, invalid
  // JSON) keeps its own code; any other refusal is REALTIME_CONFIG_REFUSED.
  const read = () => { try { return parsed(); } catch (error) { if (c.isConfigFileRefusal(error)) throw error; c.fail('REALTIME_CONFIG_REFUSED'); } };
  const initial = read();
  // Registry mode: the admission object, readCurrent and readAll are built at
  // boot over the registry's tenant set (preview-realtime.js); the file is read
  // once, at start (registry mode carries no per-tenant field to re-read).
  if (initial.registry) return Object.freeze({ ...initial, admission: null, readCurrent: null, readAll: null });
  let allow;
  try { allow = admission.load({ file: initial.admissionFile, maxTenants: initial.maxTenants, source }); } catch (error) { if (c.isConfigFileRefusal(error)) throw error; c.fail('REALTIME_CONFIG_REFUSED'); }
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
