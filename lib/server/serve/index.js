'use strict';

// `nightscout multitenant <role>[,<role>...]` (D21): boot the roles asked for
// and open listeners only for roles that declare one. The explicit preview api uses PG/Vault;
// the single-tenant api role still runs through
// scripts/headless-test-server.js. The role table is lib/server/serve/roles.js
// and the listener rules lib/server/serve/listeners.js.

const listeners = require('./listeners');
const internalListeners = require('./internal-listener');
const listenerConfig = require('../internal-api/listener-config');
const { ROLES } = require('./roles');
const diagnostics = require('../../diagnostics/m7');
const metrics = require('../../metrics');

class RoleError extends Error {}

// NS_EVAL_FEWER_ROUNDTRIPS=1 (default off): an evaluator-only process sends its
// fixed fence statements as fewer round trips (generation-scope openClient).
function fewerRoundTrips (names, source) {
  const raw = source?.NS_EVAL_FEWER_ROUNDTRIPS;
  if (raw === undefined || raw === '' || raw === '0') return false;
  if (raw !== '1') throw new TypeError('invalid NS_EVAL_FEWER_ROUNDTRIPS: 0 or 1 is required');
  return names.length === 1 && names[0] === 'evaluator';
}

function refuseRetiredRoles (names) {
  if (names.includes('feed-reader')) throw Object.assign(new RoleError('feed-reader is retired; evaluator uses pgstream capture'), { code: 'ROLE_RETIRED' });
}

// A comma-separated role list, checked against the role table. Throws
// RoleError for an empty, unknown, repeated or not-yet-available role: a role
// is available to `nightscout multitenant` once it is multitenant.
function parseRoles (args, roles) {
  roles = roles || ROLES;
  if (args.length !== 1 || !args[0]) {
    throw new RoleError('nightscout multitenant takes one argument, a comma-separated role list: ' + Object.keys(roles).join(', '));
  }
  const names = args[0].split(',').map(name => name.trim());
  refuseRetiredRoles(names);
  const seen = new Set();
  for (const name of names) {
    if (!name || !Object.prototype.hasOwnProperty.call(roles, name)) {
      throw new RoleError('unknown role: ' + (name || '(empty)') + '; the roles are ' + Object.keys(roles).join(', '));
    }
    if (seen.has(name)) throw new RoleError('role named twice: ' + name);
    seen.add(name);
  }
  const unavailable = names.filter(name => !(roles[name].start && roles[name].multitenant));
  if (unavailable.length) {
    throw new RoleError('not yet available: ' + unavailable.join(', ') + '. `nightscout multitenant` is for a multitenant'
      + ' role that is not implemented. Only api, tenant-admin, admin, evaluator, realtime and vcpool have explicit preview runtimes.');
  }
  return names;
}

// The rules `start` applies to the loaded role configurations as a set, before
// it opens a pool or a listener: listener settings, the roles one process may
// combine, and the namespaces the loaded roles protect. Returns { specs, namespaces }.
function preflight (names, source, options = {}, fallback = {}) {
  refuseRetiredRoles(names);
  const specs = listeners.resolve(names, source, fallback);
  if (names.includes('api') && options.preview && options.preview.writeClock !== true) {
    const { PreviewConfigError } = require('./preview-config');
    throw Object.assign(new PreviewConfigError('API_WRITE_CLOCK_REQUIRED: multitenant API serving requires writeClock: true'),
      { code: 'API_WRITE_CLOCK_REQUIRED' });
  }
  if (options.evaluatorPreview && options.realtimePreview &&
      options.evaluatorPreview.namespaces.checkpoint === options.realtimePreview.namespaces.checkpoint) {
    throw new RoleError('evaluator and realtime require distinct owned checkpoint namespaces');
  }
  if (options.operationConfig && names.includes('admin')) {
    throw new RoleError('admin is not a lifecycle operation cohort participant; run it without NS_LIFETIME_PG');
  }
  let namespaces;
  if (options.operationConfig) {
    const chosen = options.operationConfig;
    if (names.some(role => !['api','evaluator','realtime','tenant-admin'].includes(role)))
      throw new RoleError('Generation scope requires a tenant-serving role');
    namespaces = new Set([options.preview,options.ownerPreview,options.evaluatorPreview,options.realtimePreview]
      .flatMap(require('./role-topology').protectedNamespaces).filter(name => name !== chosen.namespace));
  }
  return { specs, namespaces };
}

// Dedicated CDC evaluator and completed-output realtime roles use the adopted
// worker admission boundary. Public/routed and mixed processes keep their scoped admission.
function trustedOperationWorker (names, options) {
  if (names.length !== 1) return false;
  return names[0] === 'evaluator' && !!(options.evaluatorPreview?.pgstream && options.evaluatorPreview?.trustedWorker) ||
    names[0] === 'realtime' && !!(options.realtimePreview?.completedOutput && options.realtimePreview?.trustedWorker);
}

// Boot every selected role and open its listener when it has one. Resolves with { servers, contexts,
// stop }, where stop() closes the listeners and then each role's MongoDB
// client. Listener settings are checked before anything is booted.
async function start (names, env, language, source, options = {}) {
  const servers = [];
  const contexts = {};
  const recovery = require('./datastore-recovery');
  let probe;
  const datastore = recovery.availability(() => (probe?.roles || names).map(role => contexts[role]), () => probe?.admitted);
  let generationScope, releaseScope, operationPool, internalListener, specs, datastoreRecovery, stopClock, booted = false;
  // Every role booted, not stopping, the datastore admitted, and each role's own state.
  function roleReady () {
    if (!booted || stopping || !datastore.available) return false;
    const api = contexts.api?.health?.();
    const realtime = contexts.realtime?.health?.();
    return (!api || (api.storageReady ?? api.ready) === true) && (contexts.evaluator?.ready?.() ?? true) &&
      (!realtime?.registry?.failure && (!realtime?.ownership || realtime.ownership.resource === true));
  }
  // Each role owns its explicitly configured context and shutdown resources.
  let stopping;
  function stop () {
    if (stopping) return stopping;
    stopping = (async () => {
      stopClock?.();
      const recovery = await Promise.allSettled([datastoreRecovery?.close()]);
      // serve.internal first: stop accepting, let in-flight calls answer up to
      // its deadline while role contexts are still alive, then force-close.
      const internal = await Promise.allSettled([internalListener?.close()]);
      const quiesced = await Promise.allSettled(Object.values(contexts).map(ctx => typeof ctx.quiesce === 'function' ? ctx.quiesce() : undefined));
      const sockets = await Promise.allSettled(servers.map(listeners.close));
      const resources = await Promise.allSettled(Object.values(contexts).map(async ctx => {
        if (typeof ctx.close === 'function') await ctx.close();
        else if (ctx.store && ctx.store.client) await ctx.store.client.close();
      }));
      const control = await Promise.allSettled([generationScope?.close(), Promise.resolve().then(() => releaseScope?.())]);
      let placements;
      try { if (operationPool) await operationPool.end(); } finally {
        // Includes configurations whose role failed before creating a context.
        try { placements = await Promise.allSettled([options.realtimePreview?.ownership, options.evaluatorPreview?.consumers?.realtime?.slicePeers]
          .map(async placement => placement?.close?.())); } finally { diagnostics.close(); metrics.reset(); }
      }
      const failures = [...recovery, ...internal, ...quiesced, ...sockets, ...resources, ...control, ...placements].filter(result => result.status === 'rejected');
      if (failures.length) throw new globalThis.AggregateError(failures.map(result => result.reason), 'Role shutdown failed');
    })();
    return stopping;
  }

  try {
    refuseRetiredRoles(names);
    // Listener settings and role combinations (preflight, above).
    const checked = preflight(names, source, options, { host: env.HOSTNAME, port: env.PORT });
    specs = checked.specs;
    diagnostics.configureRoles(names);
    // NS_METRICS (lib/metrics): off unless true; on, GET /metrics rides serve.internal.
    const metricsOn = metrics.configure(names, source || process.env).enabled;
    probe = options.datastoreProbe || require('./datastore-probe').forRoles(options);
    await probe?.probe();
    if (options.operationConfig) {
      const chosen = options.operationConfig;
      operationPool = new (require('pg').Pool)(chosen.poolOptions);
      // An idle client that loses its backend emits on the pool; without a
      // listener that is an uncaught exception and the role exits (decision
      // datastore-loss-recover-in-place). The loss wakes the recovery probe.
      operationPool.on('error', error => {
        console.error('PostgreSQL operation pool idle connection error:', error.code || error.name);
        datastoreRecovery?.signal();
      });
      diagnostics.observePool(operationPool, 'operation');
      metrics.observePool(operationPool, chosen.poolOptions?.application_name);
      generationScope = require('../../tenant-lifecycle/generation-scope').create({
        namespace: chosen.namespace, pool: operationPool, intakeProfile: chosen.intakeProfile, nativeSelection: chosen.nativeSelection,
        trustedWorker: trustedOperationWorker(names, options),
        fewerRoundTrips: fewerRoundTrips(names, source || process.env),
        ...(chosen.lockRule ? {lockRule: chosen.lockRule} : {locks: chosen.locks}),
        available: () => datastore.available && !stopping, availabilityEpoch: () => datastore.epoch, datastore: () => datastore.current,
        async invalidate(tenant) {
          for (const role of names) {
            if (!contexts[role]) throw new RoleError('Tenant generation changed during role boot');
            await contexts[role].invalidateTenant(tenant);
          }
        }
      });
      await generationScope.ready();
      releaseScope = require('../../storage/postgres-connection').installOperationWindow(generationScope);
    }
    // One private listener per process; its contracts come from the roles' code.
    const rows = internalListeners.plan(names, { preview: options.preview, realtimePreview: options.realtimePreview,
      vcpoolPreview: options.vcpoolPreview, evaluatorPreview: options.evaluatorPreview });
    // Health endpoints ride the same listener (lib/server/serve/role-health.js).
    // A process with no internal contract opens it only when serve.internal is
    // configured explicitly, so an unconfigured process creates no socket.
    const listening = names.filter(name => listenerConfig.ROLES.includes(name));
    const explicitInternal = !!options.internal || ['NS_SERVE_INTERNAL_SOCKET', 'NS_SERVE_INTERNAL_PORT'].some(key => source && String(source[key] ?? '').trim());
    // The listener opens before role boot completes. Its datastore checks use
    // each selected role's parsed settings as soon as it can answer requests.
    const configs = { api: options.preview, evaluator: options.evaluatorPreview, realtime: options.realtimePreview,
      vcpool: options.vcpoolPreview, 'tenant-admin': options.ownerPreview, admin: options.adminPreview };
    const selected = Object.fromEntries(names.map(name => [name, configs[name]]));
    const roleHealth = listening.length ? require('./role-health').create({
      configs: () => selected, ready: roleReady }) : null;
    const health = roleHealth && metricsOn ? (req, res) => new URL(req.url, 'http://internal.invalid').pathname === '/metrics'
      ? metrics.current.handle(req, res) : roleHealth(req, res) : roleHealth;
    if (metricsOn && !roleHealth) console.warn('NS_METRICS: no serve.internal listener for', names.join(','), '- /metrics is not served');
    if (rows.length || (health && (explicitInternal || metricsOn))) {
      const internal = options.internal || listenerConfig.resolve(names.filter(name => listenerConfig.ROLES.includes(name)), source);
      internalListener = await internalListeners.open(internal, rows, { operationWindow: generationScope, ...(health ? { health } : {}),
        changed: names.includes('evaluator') && !!options.evaluatorPreview?.writerDriven });
      console.log('Internal listener for', names.join(','), 'on', internal.listen.socketPath || internal.listen.url, 'routes', internalListener.routes.join(', '));
    }
    const order = names.includes('api') && names.includes('realtime') ? [...names].sort((a, b) => a === 'api' ? -1 : b === 'api' ? 1 : 0) : names;
    for (const name of order) {
      const spec = specs.find(listener => listener.role === name);
      const preview = selected[name];
      if (name === 'realtime' && !preview) throw new RoleError('realtime requires explicit preview configuration');
      if (name === 'evaluator' && !preview) throw new RoleError('evaluator requires explicit preview configuration');
      if (name === 'tenant-admin' && !preview) throw new RoleError('tenant-admin requires explicit headless preview configuration');
      if (name === 'admin' && !preview) throw new RoleError('admin requires explicit operator configuration');
      if (name === 'vcpool' && !preview) throw new RoleError('vcpool requires explicit connector configuration');
      if ((options.preview || options.ownerPreview || options.evaluatorPreview || options.realtimePreview || options.adminPreview || options.vcpoolPreview) && !preview) throw new RoleError('explicit preview configuration required for each role');
      const role = preview ? (name === 'realtime' ? require('./preview-realtime') : name === 'evaluator' ? require('./evaluator-preview')
        : name === 'tenant-admin' ? require('./owner-preview') : name === 'admin' ? require('./admin-preview')
          : name === 'vcpool' ? require('./vcpool-preview') : require('./preview-api')) : ROLES[name].start();
      if (generationScope) require('./role-topology').assertRole(name, preview, options.operationConfig);
      const localStorage = name === 'api' && names.includes('realtime') ? {
        ordinal: options.realtimePreview?.ownership?.ordinal,
        local: (tenant, fields) => contexts.realtime.internal['storage-events'].receive(tenant, fields)
      } : undefined;
      // Writer-driven: an api serving beside the evaluator hints it by a call.
      const localChanged = name === 'api' && names.includes('evaluator') && options.evaluatorPreview?.writerDriven ? {
        ordinal: options.evaluatorPreview?.processAssignment?.ordinal,
        local: (tenant, fields) => { const target = contexts.evaluator?.internal?.changed; if (!target) throw new Error('EVALUATOR_NOT_READY'); return target.receive(tenant, fields); }
      } : undefined;
      const ctx = preview ? await role.boot(preview, {operationWindow: generationScope, lifecycleSelection: options.operationConfig,
        ...(name === 'api' ? {hintEnvironment: source || process.env, localStorage, localChanged} : {})}) :
        await role.boot(env, language);
      contexts[name] = ctx;
      if (ctx && ctx.internal) {
        if (!internalListener) throw new RoleError(name + ' offers internal contracts this process does not serve');
        internalListener.bind(name, ctx.internal);
      }
      if (spec) {
        const { app } = preview ? ctx : role.createApp(env, ctx);
        const server = await listeners.open(spec, app, env.ssl);
        servers.push(server);
        if (typeof ctx.attach === 'function') await ctx.attach(server);
        const address = server.address();
        console.log('Listening for role', name, 'on', address.address + ':' + address.port);
      }
    }
    booted = true;
    // NS_METRICS: database clock against this process's, once a minute (no tenant label).
    if (metricsOn) stopClock = metrics.current.clockOffset(() => require('./role-health').databaseClock(() => selected));
    internalListener?.assertBound();
    for(const context of Object.values(contexts))if(context.failure)context.failure.then(error=>{
      console.error('Role terminal refusal:',error.code||'ROLE_TERMINAL_REFUSAL');
      const leave=options.roleExhausted||(()=>process.exit(1));
      const watchdog=setTimeout(leave,10000);watchdog.unref();stop().then(leave,leave);
    });
    if (probe) {
      datastoreRecovery = recovery.create({ target: datastore, probe, ...(options.datastoreRecovery || recovery.settings(source)),
        // Not recovered within the bound: stop the roles and exit non-zero, so the
        // platform's restart policy starts a new process.
        exhausted: options.datastoreExhausted || (() => {
          const leave = () => process.exit(1);
          const watchdog = setTimeout(leave, 10000); watchdog.unref();
          stop().then(leave, leave);
        }) });
      datastoreRecovery.start();
    }
  } catch (err) {
    await stop();
    throw err;
  }

  return { servers, contexts, generationScope, internalListener, datastoreRecovery, datastore, stop };
}

module.exports = { refuseRetiredRoles, parseRoles, preflight, trustedOperationWorker, start, RoleError };
