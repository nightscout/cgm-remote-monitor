'use strict';

const roleReadiness = require('./role-readiness');

const express = require('express');
const scope = require('../../storage/tenant-scope');
const c = require('../realtime/contract');
const clients = require('../internal-api/clients');
const protocolFactory = require('../realtime/protocol');
const { PreviewConfigError } = require('./preview-config');
// The realtime data pool has four clients: at most two tenants refresh at once
// (startup and change ticks), leaving room for socket priming and detection.
const REFRESH_CONCURRENCY = 2;
// A single revision reader serves both socket host resolution and addressed
// delivery admission. No provisioned tenant needs a runtime at boot.
async function registryMode (config, trustedSettings) {
  if(typeof trustedSettings?.read!=='function'||typeof trustedSettings?.close!=='function')throw new TypeError('Explicit committed realtime presentation reader required');
  const settingsOf = require('./evaluator-config');
  const registrySet = await require('./registry-tenant-set').openDemand({
    settings: config.registry, connectionString: config.connectionString, maxTenants: config.maxTenants,
    build: settingsOf.registryEntry, accept: tenant => !config.ownership || config.ownership.owns(tenant),
    applicationName: 'nightscout-realtime-registry'
  }).catch(async error => { await trustedSettings.close(); throw error; });
  const admission = require('../realtime/registry-admission').create({ resolver: registrySet.resolver,
    active: async tenant => !!await registrySet.lookup(tenant), enabled: registrySet.activeIds });
  const entries = new Map();
  registrySet.onRemove(tenant => entries.delete(tenant));
  async function entry (tenant) {
    const base = await registrySet.lookup(tenant);
    if (!base) return null;
    const settings = await trustedSettings.read(tenant);
    if (registrySet.tenants.get(tenant) !== base) return null;
    // Membership can go stale while settings are being read. Withhold this
    // answer until a fresh admission check establishes the tenant's identity.
    if (!registrySet.isActive(tenant)) c.fail('TENANT_REGISTRY_ADMISSION_STALE');
    const hit = entries.get(tenant);
    if (hit?.base === base && hit.settings === settings) return hit.entry;
    const selected = settingsOf.applySettings(base, settings);
    entries.set(tenant, { base, settings, entry: selected });
    return selected;
  }
  return Object.freeze({ registrySet, resolver: registrySet.resolver,
    config: { ...config, tenants: registrySet.tenants, admission, readCurrent: entry },
    async close () { await Promise.allSettled([registrySet.close(), trustedSettings.close()]); }
  });
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
  const processIncarnation = require('node:crypto').randomUUID();
  let failRole;
  const failure = new Promise(resolve => { failRole = resolve; });
  let trusted, operational, connection, runtime, protocol, sockets, startup, closing, quiescing, registry, disconnectLog, ownership;

  function quiesce () {
    if (quiescing) return quiescing;
    quiescing = (async () => {
    await registry?.registrySet.close();
    await operational?.close();
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
        if (ownership) await ownership.close();
        await trusted?.close();
        if (connection) await connection.end();
      } finally { /* immutable ownership has no reader to close */ }
    } })();
    return closing;
  }
  try {
    // The role's own start check (decision platform-verification-removal).
    await roleReadiness.admit(config, 'realtime');
    registry=await registryMode(config,{read:tenant=>trusted.read(tenant),close:async()=>{}});config=registry.config;
    scope.setTenancyMode('multi');
    connection = await require('../../storage/postgres-connection')({ connectionString: config.connectionString,
      ...require('./pool-config').pool('realtime', process.env, { connectionTimeoutMillis: config.operationTimeoutMs }), statement_timeout: config.operationTimeoutMs,
      application_name: 'nightscout-realtime-preview' });
    if (config.trustedWorker) {
      trusted = require('../../trusted-worker/postgres').create({ connection, namespaces: config.trustedWorker });
      operational = await require('../../trusted-worker/lifecycle')(trusted);
    }
    if (config.ownership) {
      // One dedicated session holds the slice. Its loss withholds delivery and
      // closes the transports (clients reconnect with their own backoff and
      // are refused at the handshake until the slice is held again); the
      // process ends only when the slice cannot be held again.
      ownership = require('../../realtime-ownership/owner').hold({
        connect: () => require('../../storage/postgres-connection')({ connectionString: config.connectionString, max: 1, connectionTimeoutMillis: config.operationTimeoutMs, statement_timeout: config.operationTimeoutMs, query_timeout: config.operationTimeoutMs, application_name: 'nightscout-realtime-owner' }),
        observer: () => connection, consumer: config.consumer, shape: {count: config.ownership.count, ordinal: config.ownership.ordinal},
        onLost: () => { console.warn('realtime slice owner session lost: delivery withheld, transports closed'); sockets?.drop(); },
        onHeld: () => { console.warn('realtime slice owner session held again'); },
        onExhausted: error => failRole(Object.assign(new Error('REALTIME_OWNER_UNAVAILABLE'), {code:'REALTIME_OWNER_UNAVAILABLE', reason: error?.code})) });
      await ownership.start();
    }
    const owner = tenant => {
      if (config.ownership) { if (!ownership?.available || quiescing) c.fail('REALTIME_OWNER_UNAVAILABLE'); config.ownership.assert(tenant); }
    };
    const ownedCurrent = async tenant => { owner(tenant); return config.readCurrent(tenant); };
    async function contact (tenant) {
      owner(tenant);
      if (!await registry.registrySet.lookup(tenant)) c.fail('REALTIME_OUTPUT_TENANT_UNAVAILABLE');
      owner(tenant);
      startup.addTenant(tenant);
    }
    // A handshake reads nothing about the tenant's output and is accepted
    // whether or not this process holds its frame: the socket's first frame
    // is sent once it is authorized and the output has been read.
    const admission = Object.freeze({ ...config.admission, async resolve (request) {
      const tenant = await config.admission.resolve(request);
      await contact(tenant);
      return tenant;
    } });
    // authorizeSocket retries a not-ready answer once on a new connection (an api
    // replica draining behind the service address); mutations never retry.
    const api = require('../realtime/api-client').create(clients.socketAuthority(config.api));
    // Activity is the trusted presentation metadata the level read refreshes
    // for watched tenants. Realtime owns no second activity pool.
    const activity={read:async tenant=>{
      if (!trusted.current(tenant) && trusted.state().available) await trusted.scan([tenant]);
      if (!trusted.state().available) c.fail('TRUSTED_WORKER_UNAVAILABLE');
      return trusted.current(tenant)?.activity || null;
    }};
    const readCurrent=require('../../tenant-activity/serving').gateReadCurrent({
      check:require('../../tenant-activity/eligibility').create({read:activity.read}).check,
      readCurrent:ownedCurrent,invalidate:tenant=>protocol?.invalidateTenant(tenant,'activity')});
    const readiness = 'serve';
    // The api may be restarting with realtime: its not-ready answers are retried
    // within NS_TENANT_WARM_RETRY_MS, inside the warm's bounded concurrency.
    const apiRetry = require('./tenant-startup').notReadyRetry({ deadlineMs: require('./pool-config').warmRetryMs() });
    startup = require('./tenant-startup').create([], operationWindow, async tenant => {
      owner(tenant);
      await require('./evaluator-readiness').provisionTenant(connection, config, tenant);
      await connection.withTenant(tenant, async () => {
        const other = await connection.query('SELECT 1 FROM "' + config.namespaces.checkpoint + '".tenant_consumer_checkpoint WHERE consumer<>$1 LIMIT 1', [config.consumer]);
        if (other.rows.length) c.fail('REALTIME_CHECKPOINT_SCOPE_REFUSED');
      });
      // The API independently admits this tenant from its own registry view.
      await apiRetry.run(() => api.authorizeSocket({ tenant, namespace: '/', credential: {} }));
    }, { readiness, warmOnStart: false, coldAlertMs: null, dynamic: true, maxTenants: config.maxTenants,
      eligible: async tenant => require('../../tenant-activity/policy').eligible('read', (await activity.read(tenant))?.state) });
    // The API forwards committed APIv3 changes to the private storage-events binding.
    protocol = protocolFactory.create({ operationWindow, admission, api, readCurrent,
      ...(config.authorizationRecheckMs !== undefined ? { authorizationRecheckMs: config.authorizationRecheckMs } : {}),
      ...(config.unauthorizedDeadlineMs !== undefined ? { unauthorizedDeadlineMs: config.unauthorizedDeadlineMs } : {}),
      humanSessionsEnabled: (process.env.ENABLE || '').split(/\s+/).includes('oidc'),
      humanAccepts: require('../../human-session/access-config').humanRouting(),
      runtime: () => runtime, domains: require('../../data/tenant-projection-evaluator').domains });
    disconnectLog = logDisconnects(protocol);
    // The level read covers watched tenants only. A reader withdrawn by a
    // failed query is re-admitted on the next read, never on an idle timer.
    const detector=require('../../pgstream/realtime-output').revisions({config,connection,trusted:{...trusted,
      scan:async tenants=>{if(!trusted.state().available)await operational.verify();return trusted.scan(tenants);}},owner});
    const createProjection=current=>require('../../pgstream/realtime-output').projection({config,connection,current,operationWindow});
    runtime=await require('../realtime/runtime')({maxTenants:config.maxTenants,readCurrent,readRevisions:detector,
      watched:protocol.watchedTenants,isWatched:protocol.watched,lagging:protocol.lagging,
      onIneligible:tenant=>protocol.invalidateTenant(tenant,'completed-output'),
      concurrency:REFRESH_CONCURRENCY,operationWindow,prepareTenant:startup.ensure,
      create:createProjection,fanout:protocol.fanout});
    registry.registrySet.onRemove(tenant => {
      trusted.remove(tenant);
      protocol.invalidateTenant(tenant, 'registry');
      // Invalidate synchronously. A pending projection can itself be inside
      // the membership lookup that noticed removal.
      return Promise.all([runtime.removeTenant(tenant), startup.removeTenant(tenant)]);
    });
    // serve/internal-listener binds alarm delivery on the process's serve.internal.
    const storage = {
      owns: tenant => !config.ownership || config.ownership.owns(tenant),
      receive: (tenant, fields) => {
        owner(tenant);
        return require('../realtime/storage-hint').receive(tenant, fields, protocol.storageHint);
      }
    };
    const internal = Object.freeze({ ...(operationWindow ? {'storage-events': storage} : {}), 'completed-output':Object.freeze({create:()=>({hintCompletedOutput:async(context,body)=>{
      // A disposable wake: no durable write and, for a tenant nobody
      // watches, no read. Owned tenants are addressed; any other tenant is
      // refused after its neighbours are woken. A lost wake is covered by
      // the level pass.
      let refused;const accepted=[];
      for(const tenant of body.tenants){try{owner(tenant);accepted.push(tenant);}catch(error){refused=refused||error;}}
      runtime.wake(accepted);if(refused)throw refused;return {accepted:true};}})}), 'realtime-inspection': Object.freeze({create: require('./realtime-inspection')({processIncarnation, ownership: config.ownership, startup, modelWarm: tenant => runtime?.warm?.(tenant), owner: () => (!config.ownership||!!ownership?.available) && !quiescing, quiescing: () => !!quiescing,runtimeStats:()=>runtime.stats(),detectorStats:detector.stats,watchedCount:()=>protocol.watchedCount(),progress:()=>runtime.progress(),stageOf:tenant=>runtime.stageOf(tenant)})}), 'alarm-delivery': Object.freeze({
      create: token => require('../realtime/alarm-transport').operations({ token, deliver: protocol.alarm, ownership: config.ownership, admit: contact }),
      ...(operationWindow ? { resolveTenant: body => body.tenant } : {}) }) });
    const health = () => {
      const view = runtime.probe(), membership = registry.registrySet.stats(), resource = !!ownership?.available && !quiescing;
      return { ...view, ready: view.ready && resource && !membership.failure,
        registry: membership, ownership: { ...config.ownership.inspect(), resource, ownerConnections: 1 } };
    };
    const app = publicApp(health);
    return Object.freeze({ app, quiesce, close, internal, failure,
      async invalidateTenant (tenant) {
        trusted?.remove(tenant);
        protocol.invalidateTenant(tenant, 'role');
        if (startup.tenants().includes(tenant)) startup.invalidateTenant(tenant);
        await runtime.invalidateTenant(tenant);
      },
      // Decision datastore-loss-recover-in-place: after the datastore's postmaster
      // changed, every tenant this process holds is invalidated as a restore
      // would (its sockets are disconnected with TENANT_INVALIDATED and reconnect).
      async invalidateAll () {
        trusted?.invalidate('restore');
        const results = await Promise.allSettled(startup.tenants().map(async tenant => {
          protocol.invalidateTenant(tenant, 'datastore');
          startup.invalidateTenant(tenant, { warm: false });
          await runtime.invalidateTenant(tenant);
        }));
        if (results.some(result => result.status === 'rejected')) throw new Error('Realtime tenant invalidation refused');
      },
      // The datastore is re-admitted: warm as at boot.
      resume () { Promise.resolve().then(() => operational?.verify()).then(() => runtime.wake(protocol.watchedTenants())).catch(() => {}); }, health, refresh: runtime.refresh,
      stats: () => Object.freeze({ protocol: protocol.stats(), runtime: runtime.stats(), detector:detector.stats(), progress: runtime.progress() }),
      async attach (server) {
        if (sockets) c.fail('REALTIME_ALREADY_ATTACHED');
        sockets = require('../realtime/socket-server').attach(server, { protocol, admission, maxMessageBytes: config.maxMessageBytes });
        require('../../metrics').current.realtime(sockets.io);
        require('../../metrics').current.realtimePending(() => runtime.pendingSummary());
      }
    });
  } catch (error) {
    await close();
    if (roleReadiness.keeps(error)) throw error;
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
