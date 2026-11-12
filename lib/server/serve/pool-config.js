'use strict';

// PostgreSQL pool sizes, connect timeouts and tenant startup concurrency per
// multitenant role, from the role process's environment (decision
// cost-proportional-to-activity). Unset keeps the built-in default; a set value
// that is not a positive integer within bounds refuses the boot. A process that
// serves several roles reads each role's own names.
//
//   NS_POOL_<ROLE>_MAX                  pool size            (ROLE: API, REALTIME, EVALUATOR, OPERATION)
//   NS_POOL_<ROLE>_CONNECT_TIMEOUT_MS   wait for a free client before refusing
//   NS_TENANT_STARTUP_CONCURRENCY       tenants initialized at once during startup warm
//   NS_TENANT_READINESS                 serve (default for roles that adopt it) or all: ready only
//                                       once every tenant is initialized (decision readiness-serve-then-warm)
//   NS_TENANT_COLD_ALERT_MS             alert while a tenant stays cold longer than this (default 120000)
//   NS_TENANT_WARM_RETRY_MS             deadline for retrying a peer that is not ready during a tenant's
//                                       warm (realtime against a restarting api; default 60000, 0 = no retry)
const { PreviewConfigError } = require('./preview-config');

const DEFAULTS = Object.freeze({
  api: Object.freeze({ max: 4, connectionTimeoutMillis: 5000 }),
  // realtime's default connect timeout is its configured operationTimeoutMs.
  realtime: Object.freeze({ max: 4, connectionTimeoutMillis: null }),
  evaluator: Object.freeze({ max: 4, connectionTimeoutMillis: 5000 }),
  operation: Object.freeze({ max: 8, connectionTimeoutMillis: 5000 })
});
const STARTUP_CONCURRENCY = 4;
const WARM_RETRY_MS = 60000;
const LIMITS = Object.freeze({ max: 1000, connectionTimeoutMillis: 600000, concurrency: 1000 });

function integer (source, name, fallback, upper) {
  const raw = source?.[name];
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,8}$/.test(raw) || Number(raw) > upper) {
    throw new PreviewConfigError('invalid ' + name + ': a whole number from 1 to ' + upper + ' is required');
  }
  return Number(raw);
}

function pool (role, source = process.env, { connectionTimeoutMillis: timeoutDefault } = {}) {
  const defaults = DEFAULTS[role];
  if (!defaults) throw new TypeError('Unknown pool role');
  const prefix = 'NS_POOL_' + role.toUpperCase() + '_';
  const fallback = defaults.connectionTimeoutMillis === null ? timeoutDefault : defaults.connectionTimeoutMillis;
  if (!Number.isSafeInteger(fallback) || fallback < 1) throw new TypeError('Pool connect timeout default required');
  return Object.freeze({
    max: integer(source, prefix + 'MAX', defaults.max, LIMITS.max),
    connectionTimeoutMillis: integer(source, prefix + 'CONNECT_TIMEOUT_MS', fallback, LIMITS.connectionTimeoutMillis)
  });
}

function startupConcurrency (source = process.env) {
  return integer(source, 'NS_TENANT_STARTUP_CONCURRENCY', STARTUP_CONCURRENCY, LIMITS.concurrency);
}

function tenantReadiness (source = process.env) {
  const raw = source?.NS_TENANT_READINESS;
  if (raw === undefined || raw === '') return 'serve';
  if (raw !== 'serve' && raw !== 'all') throw new PreviewConfigError('invalid NS_TENANT_READINESS: serve or all is required');
  return raw;
}

function coldAlertMs (source = process.env) {
  return integer(source, 'NS_TENANT_COLD_ALERT_MS', 120000, 86400000);
}

// 0 is allowed (no retry: the first not-ready answer fails the tenant, as before).
function warmRetryMs (source = process.env) {
  const raw = source?.NS_TENANT_WARM_RETRY_MS;
  if (raw === '0') return 0;
  return integer(source, 'NS_TENANT_WARM_RETRY_MS', WARM_RETRY_MS, 600000);
}

module.exports = { pool, startupConcurrency, tenantReadiness, coldAlertMs, warmRetryMs, DEFAULTS, STARTUP_CONCURRENCY, WARM_RETRY_MS };
