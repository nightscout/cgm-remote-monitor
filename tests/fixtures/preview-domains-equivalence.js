'use strict';
// Clinical-equivalence fixture for per-tenant domain construction (decision
// readiness-serve-then-warm): five synthetic tenants with different display
// settings, thresholds, feature lists and plugin extended settings, built by the
// actual environment builder (lib/server/tenant-app/environment.js) and the
// actual previewDomains over a recording SQL protocol (no database). The
// fingerprint is each tenant's constructed environment, its v1/v2/v3 app
// settings (feature enablement), its collections and its storage ports.
const path = require('node:path');
const scope = require('../../lib/storage/tenant-scope');
const environment = require('../../lib/server/tenant-app/environment');

const DOMAINS = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'];
const TENANTS = Object.freeze([
  ['11111111-1111-4111-8111-111111111111', { settings: {}, extendedSettings: {} }],
  ['22222222-2222-4222-8222-222222222222', { settings: { units: 'mmol', theme: 'colors', alarmHigh: false, language: 'de',
    thresholds: { bgHigh: 250, bgTargetTop: 180, bgTargetBottom: 72, bgLow: 54 } }, extendedSettings: {} }],
  ['33333333-3333-4333-8333-333333333333', { settings: { enable: ['careportal', 'boluscalc', 'iob', 'cob', 'bwp', 'cage', 'sage', 'iage', 'pump', 'openaps'] },
    extendedSettings: { pump: { fields: 'reservoir battery', warnRes: 20, enableAlerts: true }, cage: { info: 44, warn: 48, urgent: 72, enableAlerts: true },
      openaps: { fields: 'status-symbol status-label iob meal-assist', colorPredictionLines: true } } }],
  ['44444444-4444-4444-8444-444444444444', { settings: { enable: ['loop', 'ar2', 'rawbg', 'upbat'], timeFormat: 24, nightMode: true, showForecast: 'ar2 loop' },
    extendedSettings: { loop: { warn: 30, urgent: 60, enableAlerts: true }, ar2: { coneFactor: 0 }, rawbg: { display: 'noise' } } }],
  ['55555555-5555-4555-8555-555555555555', { settings: { enable: [], units: 'mg/dl', alarmTimeagoUrgentMins: 20 },
    extendedSettings: { treatmentnotify: { includeBolusesOver: 2, snoozeMins: 15 }, devicestatus: { days: 2 } } }]
]);

function connection () {
  return {
    withTenant: (tenant, fn) => scope.withTenant(tenant, fn),
    transaction: fn => fn(), withSavepoint: fn => fn(),
    async query (sql) {
      if (sql.includes("current_setting('server_version')")) return { rows: [{ version: 'source-protocol' }] };
      if (sql.startsWith('SELECT')) return { rows: [] };
      throw new Error('Unexpected source protocol SQL');
    }
  };
}

// previewDomains: the module under test. Returns {tenant: fingerprint}.
async function fingerprints (previewDomains) {
  const previous = scope.getTenancyMode(); scope.setTenancyMode('multi');
  try {
    const config = {
      domains: DOMAINS, bindings: new Map(TENANTS.map(([tenant]) => [tenant, {}])),
      environments: new Map(TENANTS.map(([tenant, input]) => [tenant, environment(input)])),
      namespaces: Object.fromEntries(DOMAINS.map(name => [name, 'source_' + name])),
      socketForwarding: false, legacyEnabled: true, contextEnabled: true
    };
    const graph = await previewDomains({ config, connection: connection(), exchange: async () => null, deferInitialization: true });
    const result = {};
    for (const [tenant] of TENANTS) {
      await graph.initializeTenant(tenant); const row = graph.describeTenant(tenant);
      // Express's `env` app setting is the process NODE_ENV, not a tenant value;
      // its `views` setting is an absolute path under the process directory, so
      // the fingerprint keeps it relative to that directory (checkout-independent).
      for (const key of ['v3Settings', 'v1Settings', 'v2Settings']) if (row[key]) {
        delete row[key].env;
        if (typeof row[key].views === 'string') row[key].views = path.relative(process.cwd(), row[key].views) || '.';
      }
      result[tenant] = row;
    }
    return result;
  } finally { scope.setTenancyMode(previous); }
}
module.exports = { fingerprints, TENANTS };
