'use strict';

const platform = require('./platform-verification');

const express = require('express');
const scope = require('../../storage/tenant-scope');
const c = require('../realtime/contract');
const clients = require('../internal-api/clients');
const protocolFactory = require('../realtime/protocol');
const { PreviewConfigError } = require('./preview-config');
// The realtime data pool has four clients: at most two tenants refresh at once
// (startup and change ticks), leaving room for socket priming and detection.
const REFRESH_CONCURRENCY = 2;
// Registry discovery follows committed revisions. New tenants remain hidden
// until settings, checkpoints and runtime resources are prepared.
async function registryMode (config, trustedSettings) {
  if(typeof trustedSettings?.read!=='function'||typeof trustedSettings?.close!=='function')throw new TypeError('Explicit committed realtime presentation reader required');
  const settingsOf = require('./evaluator-config');
  const registrySet = await require('./registry-tenant-set').open({ settings: config.registry, connectionString: config.connectionString,
    maxTenants: config.maxTenants, build: settingsOf.registryEntry,
    ...(config.ownership ? { accept: tenant => config.ownership.owns(tenant), selectionKey: () => config.ownership.identity } : {}), applicationName: 'nightscout-realtime-registry' });
  let lookup;
  const display=trustedSettings;
  const entries = new Map();
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
      const base = (!config.ownership || config.ownership.owns(tenant)) && registrySet.isActive(tenant) ? registrySet.tenants.get(tenant) || null : null;
      if (!base) { entries.delete(tenant); return null; }
      const settings = await display.read(tenant), hit = entries.get(tenant);
      if (hit?.base === base && hit.settings === settings) return hit.entry;
      const selected = settingsOf.applySettings(base, settings);
      entries.set(tenant, { base, settings, entry: selected });
      return selected;
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
// Disconnect and handshake-refusal counts, at most one line for each category
// per interval. Handshake causes use a fixed vocabulary: no tenant, credential,
// request field or arbitrary error code reaches the new summary.
const DISCONNECT_LOG_MS = 60000;
function logDisconnects (protocol, intervalMs = DISCONNECT_LOG_MS, write = line => console.warn(line)) {
  let last = {}, lastHandshakes = {};
  const flush = () => {
    const stats = protocol.stats(), current = { ...stats.disconnects, ...stats.disconnectReasons }, delta = {};
    for (const [key, count] of Object.entries(current)) if (count !== (last[key] || 0)) delta[key] = count - (last[key] || 0);
    last = current;
    if (Object.keys(delta).length) write('realtime server disconnects in the last ' + Math.round(intervalMs / 1000) + ' s: ' + JSON.stringify(delta));
    const handshakes = require('../../diagnostics/realtime-handshake').counts(stats.handshakeRefusals), refusals = {};
    for (const [key, count] of Object.entries(handshakes)) if (count !== (lastHandshakes[key] || 0)) refusals[key] = count - (lastHandshakes[key] || 0);
    lastHandshakes = handshakes;
    if (Object.keys(refusals).length) write('realtime handshake refusals: ' + JSON.stringify({ version: 1, at: new Date().toISOString(), refusals, totals: handshakes }));
  };
  const timer = setInterval(flush, intervalMs);
  timer.flush = flush;
  timer.unref?.();
  return timer;
}
async function boot (config, { operationWindow } = {}) {
  if(!config.registry||!config.completedOutput||!config.trustedWorker||config.changeFeed!==undefined)c.fail('REALTIME_COMPLETED_OUTPUT_REQUIRED');
  if (!config.ownership) c.fail('REALTIME_STATIC_OWNERSHIP_REQUIRED');
  if (Object.hasOwn(config, 'intakeProfile') || Object.hasOwn(config, 'predecessorProfile')) c.fail('REALTIME_CONFIG_REFUSED');
  const outputJobs=require('./evaluator-job-context').create('delivery');
  const coldAdmission = require('../../storage/connection-admission').coldAdmission();
  const processIncarnation = require('node:crypto').randomUUID();
  let failRole;
  const failure = new Promise(resolve => { failRole = resolve; });
  const loseOwner = () => { failRole(Object.assign(new Error('REALTIME_OWNER_UNAVAILABLE'), {code:'REALTIME_OWNER_UNAVAILABLE'})); return quiesce(); };
  let trusted, operational, outputReceipts, outputDrain, connection, runtime, protocol, sockets, startup, closing, quiescing, registry, disconnectLog, ownerResource, ownerTimer, ownerConnection, ownerCheck;
  const staged = new Map();
  function quiesce () {
    if (quiescing) return quiescing;
    quiescing = (async () => {
    await registry?.registrySet.close();
    await outputDrain?.close();
    outputJobs?.close();
    await operational?.close();
    if (ownerTimer) { clearInterval(ownerTimer); ownerTimer = null; }
    if (disconnectLog) { disconnectLog.flush(); clearInterval(disconnectLog); disconnectLog = null; }
    protocol?.close(); await startup?.close();
    if (sockets) await sockets.close(); // transports close; clients reconnect to the next process (BF-233)
    if (runtime) await runtime.close();
    })();
    return quiescing;
  }
  function close () {
    if (closing) return closing;
    closing = (async () => { try { await quiesce(); } finally {
      try {
        if (registry) await registry.close().catch(() => {});
        if (ownerResource) await ownerResource.close();
        if (ownerConnection) await ownerConnection.end();
        await trusted?.close();
        if (connection) await connection.end();
      } finally { /* immutable ownership has no reader to close */ }
    } })();
    return closing;
  }
  try {
    // The one platform check (decision platform-application-boundary): the
    // pre-start step's proof must be present and match. Nothing re-verifies
    // while serving; a refusal keeps its typed code.
    await platform.admit(config, 'realtime', platform.operationProfileDigest(operationWindow));
    registry=await registryMode(config,{read:tenant=>trusted.read(tenant),close:async()=>{}});config=registry.config;
    scope.setTenancyMode('multi');
    connection = await require('../../storage/postgres-connection')({ connectionString: config.connectionString,
      ...require('./pool-config').pool('realtime', process.env, { connectionTimeoutMillis: config.operationTimeoutMs }), statement_timeout: config.operationTimeoutMs,
      application_name: 'nightscout-realtime-preview' });
    if (config.trustedWorker) {
      trusted = require('../../trusted-worker/postgres').create({ connection, namespaces: config.trustedWorker });
      operational = await require('../../trusted-worker/lifecycle')(trusted);
      await trusted.scan([...config.tenants.keys()]);
    }
    if (config.ownership) {
      ownerConnection = await require('../../storage/postgres-connection')({ connectionString: config.connectionString, max: 1, connectionTimeoutMillis: config.operationTimeoutMs, statement_timeout: config.operationTimeoutMs, query_timeout: config.operationTimeoutMs, application_name: 'nightscout-realtime-owner' });
      ownerResource = await require('../../realtime-ownership/owner').acquire({ connection: ownerConnection, observer: connection, consumer: config.consumer, shape: {count: config.ownership.count, ordinal: config.ownership.ordinal}, onLoss: loseOwner });
      await ownerResource.check();
      ownerTimer = setInterval(() => {
        if (ownerCheck || quiescing) return;
        ownerCheck = ownerResource.check().catch(() => loseOwner()).finally(() => { ownerCheck = null; });
      }, 1000); ownerTimer.unref?.();
    }
    const owner = tenant => {
      if (config.ownership) { if (!ownerResource?.available || quiescing) c.fail('REALTIME_OWNER_UNAVAILABLE'); config.ownership.assert(tenant); }
    };
    const ownedCurrent = async tenant => { owner(tenant); return config.readCurrent(tenant); };
    const admission = config.ownership ? Object.freeze({ ...config.admission, resolve: async request => { const tenant = await config.admission.resolve(request); owner(tenant); if (!runtime?.requestWarm(tenant)) c.fail('TENANT_WARMING'); return tenant; } }) : config.admission;
    // authorizeSocket retries a not-ready answer once on a new connection (an api
    // replica draining behind the service address); mutations never retry.
    const api = require('../realtime/api-client').create(clients.socketAuthority(config.api));
    // Activity is the trusted presentation metadata already refreshed by the
    // addressed output/control check. Realtime owns no second activity pool.
    const activity={read:async tenant=>{
      if(!trusted.current(tenant)&&trusted.state().available)await trusted.scan([tenant]);
      return trusted.current(tenant)?.activity||null;
    }};
    const readCurrent=require('../../tenant-activity/serving').gateReadCurrent({
      check:require('../../tenant-activity/eligibility').create({read:activity.read}).check,
      readCurrent:ownedCurrent,invalidate:tenant=>protocol?.invalidateTenant(tenant,'activity')});
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
    }, { readiness, warmOnStart: false, ...(coldAdmission ? {coldAdmission} : {}), ...(activity ? { eligible: async tenant => require('../../tenant-activity/policy').eligible('read',(await activity.read(tenant))?.state) } : {}), dynamic: !!config.registry || !!config.ownership, maxTenants: config.maxTenants });
    await startup.warm();
    const storageEvents=require('../../pgstream/storage-events').create({config,connection,operationWindow,workerState:trusted.state,assertOwner:owner});
    protocol = protocolFactory.create({ operationWindow, admission, api, readCurrent, storageEvents,
      ...(config.authorizationRecheckMs !== undefined ? { authorizationRecheckMs: config.authorizationRecheckMs } : {}),
      ...(config.unauthorizedDeadlineMs !== undefined ? { unauthorizedDeadlineMs: config.unauthorizedDeadlineMs } : {}),
      humanSessionsEnabled: (process.env.ENABLE || '').split(/\s+/).includes('oidc'),
      humanAccepts: require('../../human-session/access-config').humanRouting(),
      runtime: () => runtime, domains: require('../../data/tenant-projection-evaluator').domains });
    disconnectLog = logDisconnects(protocol);
    // Only addressed durable output/control work reaches this bounded check.
    const detector=require('../../pgstream/realtime-output').detector({config,connection,trusted:{...trusted,
      // Receipt work retries outside tenant windows. Re-admit an unavailable
      // reader on that real work boundary, never on an idle timer.
      scan:async tenants=>{if(!trusted.state().available)await operational.verify();return trusted.scan(tenants);}},readAll:config.readAll,owner,
      onIneligible:tenant=>protocol.invalidateTenant(tenant,'completed-output')});
    const createProjection=current=>require('../../pgstream/realtime-output').projection({config,connection,current,operationWindow});
    runtime=await require('../realtime/runtime')({durableOutput:true,dynamic:!!config.registry||!!config.ownership,maxTenants:config.maxTenants,
      tenants:[...config.tenants.keys()],readCurrent,detect:detector,workerState:()=>trusted.state(),readiness,
      onReady:tenant=>protocol.tenantReady(tenant),watchedTenants:protocol.watchedTenants,
      eligible:async tenant=>require('../../tenant-activity/policy').eligible('read',(await activity.read(tenant))?.state),
      concurrency:REFRESH_CONCURRENCY,operationWindow,prepareTenant:startup.ensure,
      create:createProjection,fanout:protocol.fanout});
    outputReceipts=require('../../pgstream/realtime-receipt').create({config,connection,worker:processIncarnation,
      assertOwner:tenant=>{owner(tenant);if(!trusted.state().available)c.fail('TRUSTED_WORKER_UNAVAILABLE');}});
    await outputReceipts.verify();await outputReceipts.recover(config.tenants.keys());
    // Realtime owns completed-output delivery progress and retry. A wake only
    // addresses tenants; startup and every recovery interval reconcile the
    // owned roster against the evaluator's committed delivery revision.
    const deliverable=tenant=>{if(!config.tenants.has(tenant)||!runtime.has(tenant))return false;try{owner(tenant);return true;}catch{return false;}};
    outputDrain=require('../../pgstream/realtime-receipt').start({store:outputReceipts,jobContext:outputJobs,maxTenants:config.maxTenants,
      roster:()=>config.tenants.keys(),admits:deliverable,
      check:tenants=>storageEvents.check(tenants,{runtime,protocol,concurrency:REFRESH_CONCURRENCY})});
    if (registry) await registry.registrySet.follow({
      prepare: async (tenant, entry) => {
        const worker = trusted?.state();
        if (worker && !worker.available) c.fail('TRUSTED_WORKER_UNAVAILABLE');
        owner(tenant);
        const attempt = Symbol();
        if (config.ownership) staged.set(tenant, attempt);
        const cleanup = async () => { staged.delete(tenant);await runtime.removeTenant(tenant);await startup.removeTenant(tenant); };
        try {
          await trusted.scan([tenant],{recovery:true});
          if(activity && !await require('../../tenant-activity/policy').eligible('read',(await activity.read(tenant))?.state))throw Object.assign(new Error('TENANT_ACTIVITY_DEFERRED'),{code:'TENANT_ACTIVITY_DEFERRED'});
          const current = await registry.prepareTenant(tenant, entry);
          startup.addTenant(tenant);
          if(!await require('./tenant-startup').attempt(operationWindow,tenant,()=>startup.ensure(tenant)))throw new Error('Tenant operation deferred');
          if(config.ownership){
            // Warm outside the active scheduler/roster. A slow or failed target
            // cannot stall another tenant or acquire a consumer route. Follow's
            // final registry membership check precedes synchronous activation.
            const component=createProjection(current);let next;
            if(!await require('./tenant-startup').attempt(operationWindow,tenant,async()=>{owner(tenant);next=await component.acquire({at:Date.now()});}))throw new Error('Tenant operation deferred');
            owner(tenant);
            // The target is not active yet, so addressed output hints cannot
            // refresh metadata changed while its staged acquisition was held.
            await trusted.scan([tenant],{recovery:true});
            owner(tenant);
            if(!require('../../tenant-activity/policy').eligible('read',(await activity.read(tenant))?.state))throw Object.assign(new Error('TENANT_ACTIVITY_DEFERRED'),{code:'TENANT_ACTIVITY_DEFERRED'});
            const fresh=await registry.prepareTenant(tenant,entry);
            if(fresh.identity!==current.identity)c.fail('REALTIME_STAGED_CONFIG_CHANGED');
            if (worker && (!trusted.state().available || trusted.state().generation !== worker.generation)) c.fail('TRUSTED_WORKER_UNAVAILABLE');
            if (staged.get(tenant) !== attempt) c.fail('REALTIME_CYCLE_CHANGED');
            staged.set(tenant,{current,component,next,...(worker ? {workerGeneration:worker.generation} : {})});
          }else{runtime.addTenant(tenant);}
          // Adopt this tenant's delivery row; an earlier owner's retry is now ours.
          await outputReceipts.recover([tenant]);
          return cleanup;
        }catch(error){await cleanup();throw error;}
      },
      activate: tenant => {
        if(config.ownership){const prepared=staged.get(tenant);if(!prepared)c.fail('REALTIME_STAGED_TENANT_MISSING');runtime.addTenant(tenant,prepared);staged.delete(tenant);}
        runtime.wake(tenant);
        outputDrain.wake({tenants:[tenant]});
      },
      remove: async tenant => { trusted?.remove(tenant); protocol.invalidateTenant(tenant,'registry');await runtime.removeTenant(tenant);await startup.removeTenant(tenant); }
    });
    // serve/internal-listener binds alarm delivery on the process's serve.internal.
    const internal = Object.freeze({ 'completed-output':Object.freeze({create:()=>({hintCompletedOutput:async(context,body)=>{
      // A disposable wake: no durable write. Owned, configured tenants are
      // addressed; any other tenant is refused after its neighbours are woken.
      let refused;const accepted=[];
      for(const tenant of body.tenants){try{owner(tenant);if(!config.tenants.has(tenant))c.fail('REALTIME_OUTPUT_TENANT_UNAVAILABLE');accepted.push(tenant);}catch(error){refused=refused||error;}}
      outputDrain.wake({tenants:accepted});if(refused)throw refused;return {accepted:true};}})}), 'realtime-inspection': Object.freeze({create: require('./realtime-inspection')({processIncarnation, ownership: config.ownership, startup, modelWarm: tenant => runtime?.warm?.(tenant), owner: () => (!config.ownership||!!ownerResource?.available) && !quiescing, quiescing: () => !!quiescing,runtimeStats:()=>runtime.stats(),detectorStats:detector.stats,watchedCount:()=>protocol.watchedCount(),deliveryStats:()=>outputReceipts && {...outputReceipts.stats(), reconciliationPages:outputDrain.stats().reconciliationPages}})}), 'alarm-delivery': Object.freeze({
      create: token => require('../realtime/alarm-transport').operations({ token, deliver: protocol.alarm, ownership: config.ownership, admit: tenant => { owner(tenant); if (config.ownership && !runtime?.requestWarm(tenant)) c.fail('TENANT_WARMING'); } }),
      ...(operationWindow ? { resolveTenant: body => body.tenant } : {}) }) });
    const health = () => ({ ...runtime.health(), ...(config.ownership ? { ownership: { ...config.ownership.inspect(), resource: !!ownerResource?.available && !quiescing, ownerConnections: 1 } } : {}), ...(registry ? { registry: registry.registrySet.stats() } : {}) });
    const app = publicApp(health);
    return Object.freeze({ app, quiesce, close, internal, failure,
      async invalidateTenant (tenant) {
        trusted?.remove(tenant);
        protocol.invalidateTenant(tenant, 'role');
        if (config.ownership && !config.tenants.has(tenant)) {
          // Fence this unpublished projection across both acquisition and the
          // registry's final membership read before synchronous activation.
          staged.delete(tenant);
          return;
        }
        startup.invalidateTenant(tenant); await runtime.invalidateTenant(tenant, { restoring: true });
      },
      // Decision datastore-loss-recover-in-place: after the datastore's postmaster
      // changed, every tenant this process holds is invalidated as a restore
      // would (its sockets are disconnected with TENANT_INVALIDATED and reconnect).
      async invalidateAll () {
        trusted?.invalidate('restore');
        const results = await Promise.allSettled(runtime.health().tenants.map(async row => {
          protocol.invalidateTenant(row.tenant, 'datastore');
          if (startup.tenants().includes(row.tenant)) startup.invalidateTenant(row.tenant, { warm: false });
          await runtime.invalidateTenant(row.tenant);
        }));
        if (results.some(result => result.status === 'rejected')) throw new Error('Realtime tenant invalidation refused');
      },
      // The datastore is re-admitted: warm as at boot.
      resume () { Promise.resolve().then(() => operational?.verify()).then(() => startup.warm()).then(()=>outputReceipts?.recover(config.tenants.keys())).then(()=>outputDrain?.reconcile()).catch(() => {}); }, health, refresh: runtime.refresh,
      stats: () => Object.freeze({ protocol: protocol.stats(), runtime: runtime.stats(), detector:detector.stats(), delivery:outputReceipts?.stats()||null, drain:outputDrain?.stats()||null }),
      async attach (server) {
        if (sockets) c.fail('REALTIME_ALREADY_ATTACHED');
        sockets = require('../realtime/socket-server').attach(server, { protocol, admission, maxMessageBytes: config.maxMessageBytes });
      }
    });
  } catch (error) {
    await close();
    if (platform.TERMINAL.includes(error?.code)) throw error;
    throw new PreviewConfigError('realtime preview readiness or initialization refused');
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
