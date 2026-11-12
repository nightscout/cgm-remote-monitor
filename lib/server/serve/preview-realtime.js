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
// Registry discovery follows committed revisions. New tenants remain hidden
// until settings, checkpoints and runtime resources are prepared.
async function registryMode (config) {
  const settingsOf = require('./evaluator-config');
  const registrySet = await require('./registry-tenant-set').open({ settings: config.registry, connectionString: config.connectionString,
    maxTenants: config.maxTenants, build: settingsOf.registryEntry,
    ...(config.placement ? { accept: tenant => config.placement.owns(tenant), selectionKey: () => config.placement.current().digest } : {}), applicationName: 'nightscout-realtime-registry' });
  let lookup;
  const display = require('../../tenant-settings/presentation-reader')(config.tenantSettings);
  try {
    // Empty registry is safe: requests cannot resolve until a tenant is admitted.
    lookup = await require('../../storage/postgres-connection')({ connectionString: config.connectionString, max: 2, connectionTimeoutMillis: 5000,
      statement_timeout: 5000, application_name: 'nightscout-realtime-registry-lookup' });
    const resolver = require('../../tenant-registry/resolver').createRegistryResolver({
      store: require('../../tenant-registry/postgres').create({ connection: lookup, namespace: config.registry.namespace }),
      maxTenants: config.registry.maxTenants, refreshMs: config.registry.refreshMs,
      onError: () => console.warn('Tenant registry revision poll failed') });
    await resolver.start();
    const admission = require('../realtime/registry-admission').create({ resolver,
      active: tenant => registrySet.isActive(tenant), enabled: () => registrySet.activeIds() });
    const entry = async tenant => {
      const base = (!config.placement || config.placement.owns(tenant)) && registrySet.isActive(tenant) ? registrySet.tenants.get(tenant) || null : null;
      return base ? settingsOf.applySettings(base, await display.read(tenant)) : null;
    };
    return Object.freeze({ registrySet, resolver,
      async prepareTenant (tenant, base) { return settingsOf.applySettings(base, await display.read(tenant)); },
      config: { ...config, tenants: registrySet.tenants, admission,
        async readCurrent (tenant) { return entry(tenant); },
        async readAll (tenants) {
          const result = new Map();
          for (const tenant of tenants) result.set(tenant, await entry(tenant));
          return result;
        } },
      async close () { resolver.close(); await Promise.allSettled([lookup.end(), registrySet.close(), display.close()]); } });
  } catch (error) {
    await display.close().catch(() => {});
    if (lookup) await lookup.end().catch(() => {});
    await registrySet.close().catch(() => {});
    throw error;
  }
}
// Server-side disconnects by cause (decision realtime-no-socket-cap): one log
// line per interval in which any occurred, with the counts since the last
// line. Causes and refusal codes only: no tenant, credential or socket id.
const DISCONNECT_LOG_MS = 60000;
function logDisconnects (protocol, intervalMs = DISCONNECT_LOG_MS, write = line => console.warn(line)) {
  let last = {};
  const timer = setInterval(() => {
    const stats = protocol.stats(), current = { ...stats.disconnects, ...stats.disconnectReasons }, delta = {};
    for (const [key, count] of Object.entries(current)) if (count !== (last[key] || 0)) delta[key] = count - (last[key] || 0);
    last = current;
    if (Object.keys(delta).length) write('realtime server disconnects in the last ' + Math.round(intervalMs / 1000) + ' s: ' + JSON.stringify(delta));
  }, intervalMs);
  timer.unref?.();
  return timer;
}
async function boot (config, { operationWindow } = {}) {
  let feed, connection, runtime, protocol, sockets, activityStore, startup, closing, quiescing, registry, disconnectLog, ownerResource, ownerTimer, ownerConnection, ownerCheck;
  const staged = new Map();
  function quiesce () {
    if (quiescing) return quiescing;
    quiescing = (async () => {
    await registry?.registrySet.close();
    await feed?.close();
    if (ownerTimer) { clearInterval(ownerTimer); ownerTimer = null; }
    if (disconnectLog) { clearInterval(disconnectLog); disconnectLog = null; }
    protocol?.close(); startup?.close();
    if (sockets) await sockets.close(); // transports close; clients reconnect to the next process (BF-233)
    if (runtime) await runtime.close();
    })();
    return quiescing;
  }
  function close () {
    if (closing) return closing;
    closing = (async () => { try { await quiesce(); } finally {
      try {
        if (activityStore) await activityStore.close().catch(() => {});
        if (registry) await registry.close().catch(() => {});
        if (ownerResource) await ownerResource.close();
        if (ownerConnection) await ownerConnection.end();
        if (connection) await connection.end();
      } finally { config.placement?.close(); }
    } })();
    return closing;
  }
  try {
    if (config.registry) { registry = await registryMode(config); config = registry.config; }
    else if (config.placement) config = { ...config, tenants: new Map([...config.tenants].filter(([tenant]) => config.placement.owns(tenant))) };
    await require('./evaluator-readiness')(config, { operationWindow }); // same read-only clinical/owned-checkpoint contract
    scope.setTenancyMode('multi');
    connection = await require('../../storage/postgres-connection')({ connectionString: config.connectionString,
      ...require('./pool-config').pool('realtime', process.env, { connectionTimeoutMillis: config.operationTimeoutMs }), statement_timeout: config.operationTimeoutMs,
      application_name: 'nightscout-realtime-preview' });
    if (config.placement) {
      ownerConnection = await require('../../storage/postgres-connection')({ connectionString: config.connectionString, max: 1, connectionTimeoutMillis: config.operationTimeoutMs, statement_timeout: config.operationTimeoutMs, query_timeout: config.operationTimeoutMs, application_name: 'nightscout-realtime-owner' });
      ownerResource = await require('../../realtime-placement/owner').acquire({ connection: ownerConnection, worker: config.placement.self.worker, consumer: config.consumer, onLoss: quiesce });
      await ownerResource.check();
      ownerTimer = setInterval(() => {
        if (ownerCheck || quiescing) return;
        try { config.placement.current(); } catch { quiesce(); return; }
        ownerCheck = ownerResource.check().catch(() => quiesce()).finally(() => { ownerCheck = null; });
      }, Math.min(1000, config.recoveryIntervalMs)); ownerTimer.unref?.();
    }
    const owner = tenant => {
      if (config.placement) { if (!ownerResource?.available || quiescing) c.fail('REALTIME_OWNER_UNAVAILABLE'); config.placement.assert(tenant); }
    };
    const ownedCurrent = async tenant => { owner(tenant); return config.readCurrent(tenant); };
    const admission = config.placement ? Object.freeze({ ...config.admission, resolve: async request => { const tenant = await config.admission.resolve(request); owner(tenant); if (!runtime?.warm(tenant)) c.fail('TENANT_WARMING'); return tenant; } }) : config.admission;
    // authorizeSocket retries a not-ready answer once on a new connection (an api
    // replica draining behind the service address); mutations never retry.
    const api = require('../realtime/api-client').create(clients.socketAuthority(config.api));
    // Activity: a paused or suspended tenant's sockets are refused and disconnected.
    let readCurrent = ownedCurrent, activity;
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
        readCurrent: ownedCurrent, invalidate: tenant => protocol?.invalidateTenant(tenant, 'activity') });
    }
    // Decision readiness-serve-then-warm: NS_TENANT_READINESS (default serve).
    const readiness = require('./pool-config').tenantReadiness();
    // The api may be restarting with realtime: its not-ready answers are retried
    // within NS_TENANT_WARM_RETRY_MS, inside the warm's bounded concurrency.
    const apiRetry = require('./tenant-startup').notReadyRetry({ deadlineMs: require('./pool-config').warmRetryMs() });
    startup = require('./tenant-startup').create(config.tenants.keys(), operationWindow, async tenant => {
      owner(tenant);
      await require('./evaluator-readiness').provisionTenant(connection, config, tenant);
      await connection.withTenant(tenant, async () => {
        const other = await connection.query('SELECT 1 FROM "' + config.namespaces.checkpoint + '".tenant_consumer_checkpoint WHERE consumer<>$1 LIMIT 1', [config.consumer]);
        if (other.rows.length) c.fail('REALTIME_CHECKPOINT_SCOPE_REFUSED');
      });
      if (config.registry || await config.readCurrent(tenant)) {
        // Registry mode has no tenant-to-host reverse lookup: the warm names the
        // tenant only, and the api prepares it from its own registry view.
        const host = config.registry ? undefined : config.admission.aliases.find(alias => alias.tenant === tenant)?.host;
        await apiRetry.run(() => api.authorizeSocket({ ...(host === undefined ? {} : { host }), tenant, namespace: '/', credential: {} }));
      }
    }, { readiness, ...(activity ? { eligible: async tenant => require('../../tenant-activity/policy').eligible('read',(await activity.read(tenant))?.state) } : {}), dynamic: !!config.registry || !!config.placement, maxTenants: config.maxTenants });
    await startup.warm();
    protocol = protocolFactory.create({ operationWindow, admission, api, readCurrent,
      ...(config.authorizationRecheckMs !== undefined ? { authorizationRecheckMs: config.authorizationRecheckMs } : {}),
      ...(config.unauthorizedDeadlineMs !== undefined ? { unauthorizedDeadlineMs: config.unauthorizedDeadlineMs } : {}),
      humanSessionsEnabled: (process.env.ENABLE || '').split(/\s+/).includes('oidc'),
      humanAccepts: require('../../human-session/access-config').humanRouting(),
      runtime: () => runtime, domains: require('../../data/tenant-projection-evaluator').domains });
    disconnectLog = logDisconnects(protocol);
    // Pause, suspend, or removal from admission disconnects the tenant's
    // sockets within one detection interval; a write is published within one.
    const detector = require('../realtime/change-detector').create({
      readStamps: require('../realtime/change-detector').stampReader({ connection, clockNamespace: config.namespaces.clock, changeStampsNamespace: config.namespaces.changeStamps }),
      ...(activity ? { readActivity: activity.readMany } : {}), readIdentities: async tenants => { for (const tenant of tenants) owner(tenant); return config.readAll(tenants); },
      onPoll: seen => require('../realtime/change-detector').invalidateIneligible(seen, { activity: !!activity, invalidate: tenant => protocol?.invalidateTenant(tenant, 'detector') }) });
    const createProjection = current => require('../realtime/projection')({ config, connection, current });
    runtime = await require('../realtime/runtime')({ dynamic: !!config.registry || !!config.placement, maxTenants: config.maxTenants, eventDriven: !!config.changeFeed, tenants: [...config.tenants.keys()], readCurrent, detect: detector.poll, readiness,
      onReady: tenant => protocol?.tenantReady(tenant),
      ...(activity ? { eligible: async tenant => require('../../tenant-activity/policy').eligible('read',(await activity.read(tenant))?.state) } : {}),
      concurrency: REFRESH_CONCURRENCY, recoveryIntervalMs: config.recoveryIntervalMs, operationWindow, prepareTenant: startup.ensure,
      create: createProjection, fanout: protocol.fanout });
    if (config.changeFeed) feed = await require('../../change-feed/consumer').start({ config: config.changeFeed, tenants: config.tenants.keys(), dynamic: !!config.registry || !!config.placement, maxTenants: config.maxTenants, check: selected => runtime.check(selected) });
    if (registry) await registry.registrySet.follow({
      prepare: async (tenant, entry) => {
        owner(tenant);
        const cleanup = async () => { staged.delete(tenant);feed?.removeTenant(tenant);await runtime.removeTenant(tenant);await startup.removeTenant(tenant); };
        try {
          if(activity && !await require('../../tenant-activity/policy').eligible('read',(await activity.read(tenant))?.state))throw Object.assign(new Error('TENANT_ACTIVITY_DEFERRED'),{code:'TENANT_ACTIVITY_DEFERRED'});
          const current = await registry.prepareTenant(tenant, entry);
          startup.addTenant(tenant);
          if(!await require('./tenant-startup').attempt(operationWindow,tenant,()=>startup.ensure(tenant)))throw new Error('Tenant operation deferred');
          if(config.placement){
            // Warm outside the active scheduler/roster. A slow or failed target
            // cannot stall another tenant or acquire a consumer route. Follow's
            // final registry membership check precedes synchronous activation.
            const component=createProjection(current);let next;
            if(!await require('./tenant-startup').attempt(operationWindow,tenant,async()=>{owner(tenant);next=await component.acquire({at:Date.now()});}))throw new Error('Tenant operation deferred');
            owner(tenant);
            if(activityStore && !require('../../tenant-activity/policy').eligible('read',(await activityStore.read(tenant))?.state))throw Object.assign(new Error('TENANT_ACTIVITY_DEFERRED'),{code:'TENANT_ACTIVITY_DEFERRED'});
            const fresh=await registry.prepareTenant(tenant,entry);
            if(fresh.identity!==current.identity)c.fail('REALTIME_STAGED_CONFIG_CHANGED');
            staged.set(tenant,{current,component,next});
          }else{runtime.addTenant(tenant);feed?.addTenant(tenant);}
          return cleanup;
        }catch(error){await cleanup();throw error;}
      },
      activate: tenant => {
        if(config.placement){const prepared=staged.get(tenant);if(!prepared)c.fail('REALTIME_STAGED_TENANT_MISSING');runtime.addTenant(tenant,prepared);staged.delete(tenant);feed?.addTenant(tenant);}
        runtime.wake(tenant);
      },
      remove: async tenant => { protocol.invalidateTenant(tenant,'registry');feed?.removeTenant(tenant);await runtime.removeTenant(tenant);await startup.removeTenant(tenant); }
    });
    // serve/internal-listener binds alarm delivery on the process's serve.internal.
    const internal = Object.freeze({ 'alarm-delivery': Object.freeze({
      create: token => require('../realtime/alarm-transport').operations({ token, deliver: protocol.alarm, placement: config.placement, admit: tenant => { owner(tenant); if (config.placement && !runtime?.warm(tenant)) c.fail('TENANT_WARMING'); } }),
      ...(operationWindow ? { resolveTenant: body => body.tenant } : {}) }) });
    const health = () => ({ ...runtime.health(), ...(config.placement ? { placement: { ...config.placement.inspect(), resource: !!ownerResource?.available && !quiescing, ownerConnections: 1 } } : {}), ...(registry ? { registry: registry.registrySet.stats() } : {}), ...(feed ? { changeFeed: feed.health() } : {}) });
    const app = publicApp(health);
    return Object.freeze({ app, quiesce, close, internal,
      async invalidateTenant (tenant) {
        protocol.invalidateTenant(tenant, 'role');
        if (config.placement && !config.tenants.has(tenant)) { await registry?.registrySet.drained(); return; }
        startup.invalidateTenant(tenant); await runtime.invalidateTenant(tenant);
      }, health, refresh: runtime.refresh,
      stats: () => Object.freeze({ ...(feed ? { changeFeed: feed.health() } : {}), protocol: protocol.stats(), runtime: runtime.stats(), detector: detector.stats() }),
      async attach (server) {
        if (sockets) c.fail('REALTIME_ALREADY_ATTACHED');
        sockets = require('../realtime/socket-server').attach(server, { protocol, admission, maxMessageBytes: config.maxMessageBytes });
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
module.exports = { boot, registryMode, publicApp, logDisconnects };
