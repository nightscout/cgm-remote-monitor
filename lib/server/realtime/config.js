'use strict';

const fs = require('node:fs');
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
// A process-wide cap is refused; deployment edge policies own flood limits.
const MAX_SOCKETS_REMOVED = 'REALTIME_CONFIG_MAX_SOCKETS_REMOVED';
function parse (value, source, internal = listenerConfig.resolve(['realtime'], source)) {
  if (c.object(value) && Object.hasOwn(value, 'maxSockets')) {
    throw Object.assign(new Error(MAX_SOCKETS_REMOVED + ': realtime has no per-process socket cap; remove maxSockets from MULTITENANT_REALTIME_CONFIG (connection limits belong to the edge)'), { code: MAX_SOCKETS_REMOVED });
  }
  const registryMode = c.object(value) && Object.hasOwn(value, 'registry');
  if (registryMode && (Object.hasOwn(value, 'tenants') || Object.hasOwn(value, 'admissionFileEnv'))) c.fail('REALTIME_REGISTRY_REFUSES_TENANT_LIST');
  const fields = ['version', 'postgres', 'consumer', 'pageSize', 'maxRows', 'maxBytes', 'maxTenants', 'recoveryIntervalMs',
    ...(registryMode ? ['registry'] : ['tenants', 'admissionFileEnv']), 'maxMessageBytes', 'operationTimeoutMs'];
  const timings = ['authorizationRecheckMs', 'unauthorizedDeadlineMs'];
  if (!c.exact(value, fields, ['socketOrderDomains', 'activity', 'changeFeed', ...timings]) ||
      timings.some(k => value[k] !== undefined && !c.integer(value[k], 2147483647)) || typeof value.consumer !== 'string' || !/^realtime-[A-Za-z0-9_-]{1,112}$/.test(value.consumer) ||
      !c.integer(value.maxMessageBytes) || !c.integer(value.operationTimeoutMs, 2147483647)) c.fail('REALTIME_CONFIG_REFUSED');
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
  if (value.changeFeed !== undefined && !activity) c.fail('REALTIME_CONFIG_REFUSED');
  const admissionFile = registryMode ? null : c.reference(value.admissionFileEnv, source);
  return { ...commonConfig, ...value, activity, changeFeed: value.changeFeed === undefined ? undefined : require('../../change-feed/config').parse(value.changeFeed,source), connectionString: commonConfig.connectionString, namespaces: commonConfig.namespaces,
    tenants: commonConfig.tenants, api, admissionFile, registry: commonConfig.registry,
    infrastructure: c.identity([commonConfig.infrastructure, value.consumer, value.maxMessageBytes, value.operationTimeoutMs, api, admissionFile]) };
}
function load (source, internal) {
  const parsed = c.parsedFile(source.MULTITENANT_REALTIME_CONFIG, value => parse(value, source, internal), { label: 'MULTITENANT_REALTIME_CONFIG', source });
  // A bounded-read refusal (too large, not a regular file, unreadable, invalid
  // JSON) keeps its own code; any other refusal is REALTIME_CONFIG_REFUSED.
  const reread = () => { try { return parsed(); } catch (error) { if (c.isConfigFileRefusal(error) || error?.code === MAX_SOCKETS_REMOVED) throw error; c.fail('REALTIME_CONFIG_REFUSED'); } };
  // readCurrent and readAll run per socket check, frame and detection tick
  // (measured: about 52 calls/s and 3.7% of realtime CPU at 1,000 tenants; the
  // file is 1.9 MB at 3,000). As evaluator-config does, the parse is reused
  // while the file's identity (inode, size, mtime, ctime) is unchanged, so an
  // edit or an atomic replacement is still read on the next call.
  let cached = null;
  function read () {
    let key;
    try { const stat = fs.statSync(source.MULTITENANT_REALTIME_CONFIG); key = [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':'); }
    catch { return reread(); } // the bounded reader names the refusal
    if (cached && cached.key === key) return cached.value;
    const value = reread(); cached = { key, value };
    return value;
  }
  const initial = read();
  // Registry mode: the admission object, readCurrent and readAll are built at
  // boot over the registry's tenant set (preview-realtime.js); the file is read
  // once, at start (registry mode carries no per-tenant field to re-read).
  if (initial.registry) return Object.freeze({ ...initial, admission: null, readCurrent: null, readAll: null });
  let allow;
  try { allow = admission.load({ file: initial.admissionFile, maxTenants: initial.maxTenants, source }); } catch (error) { if (c.isConfigFileRefusal(error)) throw error; c.fail('REALTIME_CONFIG_REFUSED'); }
  if (allow.ids.some(id => !initial.tenants.has(id))) c.fail('REALTIME_CONFIG_REFUSED');
  // Roster expansion and infrastructure changes are properties of a parsed
  // configuration, not of a socket check. Validate each changed parse once;
  // unchanged calls must not enumerate the cohort. A refused parse is never
  // accepted, so every subsequent read keeps refusing until it is repaired.
  let validated = initial;
  function currentConfig () {
    const current = read();
    if (current !== validated) {
      if (current.infrastructure !== initial.infrastructure || !isDeepStrictEqual([...current.tenants.keys()].filter(id => !initial.tenants.has(id)), [])) c.fail('REALTIME_RESTART_REQUIRED');
      validated = current;
    }
    return current;
  }
  return Object.freeze({ ...initial, admission: allow,
    async readCurrent (tenant) {
      const current = currentConfig();
      return await allow.allows(tenant) ? current.tenants.get(tenant) || null : null;
    },
    // Every requested tenant from one configuration and one admission read.
    async readAll (tenants) {
      const current = currentConfig();
      const enabled = await allow.enabledFor(tenants);
      return new Map([...tenants].map(tenant => [tenant, enabled.has(tenant) ? current.tenants.get(tenant) || null : null]));
    }
  });
}
module.exports = { parse, load, MAX_SOCKETS_REMOVED };
