'use strict';

const express = require('express');
const scope = require('../../storage/tenant-scope');
const c = require('../realtime/contract');
const clients = require('../internal-api/clients');
const protocolFactory = require('../realtime/protocol');
const { PreviewConfigError } = require('./preview-config');
// The realtime data pool has four clients: at most two tenants refresh at once
// (startup and change ticks), leaving room for socket priming and detection.
const REFRESH_CONCURRENCY = 2;
// Activity read once per detection interval for every tenant; a single read
// in between only when the cached reading is older than maxAgeMs.
function cachedActivity (store, maxAgeMs) {
  const seen = new Map();
  return Object.freeze({
    async read (tenant) {
      const hit = seen.get(tenant);
      if (hit && Date.now() - hit.at <= maxAgeMs) return hit.row;
      const row = await store.read(tenant); seen.set(tenant, { at: Date.now(), row }); return row;
    },
    async readMany (tenants) {
      const rows = await store.readMany(tenants), at = Date.now();
      for (const [tenant, row] of rows) seen.set(tenant, { at, row });
      return rows;
    }
  });
}
async function boot (config, { operationWindow } = {}) {
  let connection, runtime, protocol, sockets, activityStore, startup, closing, quiescing;
  function quiesce () {
    if (quiescing) return quiescing;
    quiescing = (async () => {
    protocol?.close(); startup?.close();
    if (sockets) await sockets.close(); // transports close; clients reconnect to the next process (BF-233)
    if (runtime) await runtime.close();
    })();
    return quiescing;
  }
  function close () {
    if (closing) return closing;
    closing = (async () => { try { await quiesce(); } finally {
      if (activityStore) await activityStore.close().catch(() => {});
      if (connection) await connection.end();
    } })();
    return closing;
  }
  try {
    await require('./evaluator-readiness')(config, { operationWindow }); // same read-only clinical/owned-checkpoint contract
    scope.setTenancyMode('multi');
    connection = await require('../../storage/postgres-connection')({ connectionString: config.connectionString,
      ...require('./pool-config').pool('realtime', process.env, { connectionTimeoutMillis: config.operationTimeoutMs }), statement_timeout: config.operationTimeoutMs,
      application_name: 'nightscout-realtime-preview' });
    const api = clients.socketAuthority(config.api);
    // Activity: a paused or suspended tenant's sockets are refused and disconnected.
    let readCurrent = config.readCurrent, activity;
    if (config.activity) {
      await require('../../migrations/postgres').run('check', { direct: true, connectionString: config.activity.connectionString,
        namespace: config.activity.namespace, catalogue: require('../../tenant-lifecycle/postgres-candidate.json'), statementTimeoutMs: 5000 });
      activityStore = await require('../../tenant-activity/postgres').create({ connectionString: config.activity.connectionString,
        namespace: config.activity.namespace, capability: 'reader', applicationName: 'nightscout-realtime-activity' });
      // The change detector reads every tenant's state once per interval;
      // socket and fanout checks use that reading while it is fresh.
      activity = cachedActivity(activityStore, 2 * config.recoveryIntervalMs);
      readCurrent = require('../../tenant-activity/serving').gateReadCurrent({
        check: require('../../tenant-activity/eligibility').create({ read: activity.read }).check,
        readCurrent: config.readCurrent, invalidate: tenant => protocol?.invalidateTenant(tenant) });
    }
    // Decision readiness-serve-then-warm: NS_TENANT_READINESS (default serve).
    const readiness = require('./pool-config').tenantReadiness();
    // The api may be restarting with realtime: its not-ready answers are retried
    // within NS_TENANT_WARM_RETRY_MS, inside the warm's bounded concurrency.
    const apiRetry = require('./tenant-startup').notReadyRetry({ deadlineMs: require('./pool-config').warmRetryMs() });
    startup = require('./tenant-startup').create(config.tenants.keys(), operationWindow, async tenant => {
      await require('./evaluator-readiness').provisionTenant(connection, config, tenant);
      await connection.withTenant(tenant, async () => {
        const other = await connection.query('SELECT 1 FROM "' + config.namespaces.checkpoint + '".tenant_consumer_checkpoint WHERE consumer<>$1 LIMIT 1', [config.consumer]);
        if (other.rows.length) c.fail('REALTIME_CHECKPOINT_SCOPE_REFUSED');
      });
      if (await config.readCurrent(tenant)) {
        const host = config.admission.aliases.find(alias => alias.tenant === tenant)?.host;
        await apiRetry.run(() => api.authorizeSocket({ host, tenant, namespace: '/', credential: {} }));
      }
    }, { readiness });
    await startup.warm();
    protocol = protocolFactory.create({ operationWindow, admission: config.admission, api, readCurrent,
      ...(config.authorizationRecheckMs !== undefined ? { authorizationRecheckMs: config.authorizationRecheckMs } : {}),
      humanSessionsEnabled: (process.env.ENABLE || '').split(/\s+/).includes('oidc'),
      humanAccepts: require('../../human-session/access-config').humanRouting(),
      runtime: () => runtime, maxSockets: config.maxSockets, domains: require('../../data/tenant-projection-evaluator').domains });
    // Pause, suspend, or removal from admission disconnects the tenant's
    // sockets within one detection interval; a write is published within one.
    const detector = require('../realtime/change-detector').create({
      readStamps: require('../realtime/change-detector').stampReader({ connection, clockNamespace: config.namespaces.clock, changeStampsNamespace: config.namespaces.changeStamps }),
      ...(activity ? { readActivity: activity.readMany } : {}), readIdentities: config.readAll,
      onPoll: seen => require('../realtime/change-detector').invalidateIneligible(seen, { activity: !!activity, invalidate: tenant => protocol?.invalidateTenant(tenant) }) });
    runtime = await require('../realtime/runtime')({ tenants: [...config.tenants.keys()], readCurrent, detect: detector.poll, readiness,
      onReady: tenant => protocol?.tenantReady(tenant),
      concurrency: REFRESH_CONCURRENCY, recoveryIntervalMs: config.recoveryIntervalMs, operationWindow, prepareTenant: startup.ensure,
      create: current => require('../realtime/projection')({ config, connection, current }), fanout: protocol.fanout });
    // serve/internal-listener binds alarm delivery on the process's serve.internal.
    const internal = Object.freeze({ 'alarm-delivery': Object.freeze({
      create: token => require('../realtime/alarm-transport').operations({ token, deliver: protocol.alarm }),
      ...(operationWindow ? { resolveTenant: body => body.tenant } : {}) }) });
    const app = publicApp(() => runtime.health());
    return Object.freeze({ app, quiesce, close, internal,
      async invalidateTenant (tenant) { startup.invalidateTenant(tenant); protocol.invalidateTenant(tenant); await runtime.invalidateTenant(tenant); }, health: runtime.health, refresh: runtime.refresh,
      stats: () => Object.freeze({ protocol: protocol.stats(), runtime: runtime.stats(), detector: detector.stats() }),
      async attach (server) {
        if (sockets) c.fail('REALTIME_ALREADY_ATTACHED');
        sockets = require('../realtime/socket-server').attach(server, { protocol, admission: config.admission, maxMessageBytes: config.maxMessageBytes });
      }
    });
  } catch {
    await close(); throw new PreviewConfigError('realtime preview readiness or initialization refused');
  }
}
// The realtime role's public HTTP routes besides sockets: its health, and
// not found for everything else (operator resources live on the admin listener).
function publicApp (health) {
  const app = express(); app.disable('x-powered-by');
  app.get('/health', (req, res) => { const current = health(); res.status(current.ready ? 200 : 503).json(current); });
  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  return app;
}
module.exports = { boot, publicApp };
