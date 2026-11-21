'use strict';

const scope = require('../storage/tenant-scope');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIMIT = 8640000000000000;
const DEFAULT_DURATION = 30 * 60 * 1000;
const fail = code => { throw Object.assign(new Error(code), { code }); };
function tenant (value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('ALARM_TENANT_INVALID');
  const current = scope.currentTenant();
  if (current && current !== value) fail('ALARM_TENANT_MISMATCH');
  return value;
}
function instant (value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= LIMIT) fail('ALARM_TIME_INVALID');
  return value;
}
function group (value) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 512 || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) fail('ALARM_GROUP_INVALID');
  return value;
}
function level (value) {
  if (value !== 1 && value !== 2) fail('ALARM_LEVEL_INVALID');
  return value;
}
function args (values) {
  if (!Array.isArray(values) || values.length < 2 || values.length > 3) fail('ALARM_ARGUMENTS_INVALID');
  const duration = values[2] === undefined || values[2] === null || values[2] === 0 ? DEFAULT_DURATION : values[2];
  if (!Number.isSafeInteger(duration) || duration < 1 || duration >= LIMIT) fail('ALARM_DURATION_INVALID');
  return Object.freeze({ level: level(values[0]), group: group(values[1]), duration });
}
function table (namespace) {
  if (typeof namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || namespace === 'public' || namespace.startsWith('pg_') || namespace === 'information_schema') fail('ALARM_NAMESPACE_INVALID');
  return '"' + namespace + '".tenant_alarm_suppression';
}
function storedInstant (value) {
  if (!['string', 'number'].includes(typeof value) || (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value))) fail('ALARM_STORED_STATE_INVALID');
  return instant(Number(value));
}
function row (value, expectedTenant) {
  if (!value || value.tenant_id !== expectedTenant) fail('ALARM_STORED_STATE_INVALID');
  const result = { tenant: expectedTenant, group: group(value.alarm_group), level: level(value.alarm_level),
    ackedAt: storedInstant(value.acked_at), expiresAt: storedInstant(value.expires_at) };
  if (result.expiresAt <= result.ackedAt) fail('ALARM_STORED_STATE_INVALID');
  return Object.freeze(result);
}
module.exports = { tenant, instant, group, level, args, table, row, fail, LIMIT, DEFAULT_DURATION, storedInstant };
