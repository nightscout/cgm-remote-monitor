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
const connectionAdmission = require('../../storage/connection-admission');

class RoleError extends Error {}

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
// combine, and the participant manifest against the namespaces the loaded
// roles protect. Pure: reads `source` and `options`, opens nothing. Returns
// { specs, participant, namespaces }. The deployment plan contract check
// (lib/server/serve/plan-contract) applies the same function to a plan's documents.
function preflight (names, source, options = {}, fallback = {}) {
  refuseRetiredRoles(names);
  const specs = listeners.resolve(names, source, fallback);
  const replicatedApi = names.includes('api') && options.operationConfig?.participants?.filter(row => row.roles.includes('api')).length > 1;
  if (replicatedApi && options.preview?.writeClock !== true) {
    const { PreviewConfigError } = require('./preview-config');
    throw Object.assign(new PreviewConfigError('API_REPLICAS_REQUIRE_WRITE_CLOCK: fixed-roster API replicas require the shared write clock'),
      { code: 'API_REPLICAS_REQUIRE_WRITE_CLOCK' });
  }
  if (options.evaluatorPreview && options.realtimePreview &&
      options.evaluatorPreview.namespaces.checkpoint === options.realtimePreview.namespaces.checkpoint) {
    throw new RoleError('evaluator and realtime require distinct owned checkpoint namespaces');
  }
  if (options.operationConfig && names.includes('admin')) {
    throw new RoleError('admin is not a lifecycle operation cohort participant; run it without MULTITENANT_OPERATION_CONFIG');
  }
  let participant, namespaces;
  if (options.operationConfig) {
    const chosen = options.operationConfig;
    namespaces = new Set([options.preview,options.ownerPreview,options.evaluatorPreview,options.realtimePreview]
      .flatMap(require('./operation-cohort').protectedNamespaces).filter(name => name !== chosen.namespace));
    participant = chosen.participants?.find(row => row.id === chosen.participantId);
    if (participant && (JSON.stringify([...participant.roles].sort())!==JSON.stringify([...names].sort()) ||
        JSON.stringify([...participant.namespaces].sort())!==JSON.stringify([...namespaces].sort()))) throw new RoleError('Participant manifest does not match actual role resources');
  }
  return { specs, participant, namespaces };
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
  let operationCohort, operationPool, internalListener, specs, datastoreRecovery;
  // Each role owns its explicitly configured context and shutdown resources.
  let stopping;
  function stop () {
    if (stopping) return stopping;
    let freezeError;
    try { connectionAdmission.beginQuiesce(); } catch (error) { freezeError = error; }
    operationCohort?.quiesce?.();
    stopping = (async () => {
      const recovery = await Promise.allSettled([datastoreRecovery?.close()]);
      // serve.internal first: stop accepting, let in-flight calls answer up to
      // its deadline while role contexts are still alive, then force-close.
      const internal = await Promise.allSettled([internalListener?.close()]);
      const quiesced = await Promise.allSettled(Object.values(contexts).map(ctx => typeof ctx.quiesce === 'function' ? ctx.quiesce() : undefined));
      const sockets = await Promise.allSettled(servers.map(listeners.close));
      const coldDrain = await Promise.allSettled([connectionAdmission.closeColdAdmission()]);
      const resources = await Promise.allSettled(Object.values(contexts).map(async ctx => {
        if (typeof ctx.close === 'function') await ctx.close();
        else if (ctx.store && ctx.store.client) await ctx.store.client.close();
      }));
      const control = await Promise.allSettled([operationCohort?.close()]);
      let placements;
      try { if (operationPool) await operationPool.end(); } finally {
        // Includes configurations whose role failed before creating a context.
        try { placements = await Promise.allSettled([options.operationConfig?.placement,
          options.realtimePreview?.placement, options.evaluatorPreview?.consumers?.realtime?.placement]
          .map(async placement => placement?.close())); } finally { diagnostics.close(); }
      }
      const failures = [...recovery, ...internal, ...quiesced, ...sockets, ...coldDrain, ...resources, ...control, ...placements].filter(result => result.status === 'rejected');
      if (freezeError) failures.push({ reason: freezeError });
      if (failures.length) throw new globalThis.AggregateError(failures.map(result => result.reason), 'Role shutdown failed');
      await connectionAdmission.finalizeQuiescence(true);
    })().catch(async error => {
      try { await connectionAdmission.finalizeQuiescence(false); } catch { /* uncertainty never publishes a graceful acknowledgement */ }
      throw error;
    });
    return stopping;
  }

  try {
    refuseRetiredRoles(names);
    // Listener settings, role combinations and the participant manifest (preflight, above).
    const checked = preflight(names, source, options, { host: env.HOSTNAME, port: env.PORT });
    specs = checked.specs;
    diagnostics.configureRoles(names);
    if (options.operationConfig) {
      const chosen = options.operationConfig;
      operationPool = new (connectionAdmission.wrapPool(require('pg').Pool, require('pg').Client, chosen.poolOptions.application_name))(
        connectionAdmission.poolOptions(chosen.poolOptions.application_name, chosen.poolOptions));
      // An idle client that loses its backend emits on the pool; without a
      // listener that is an uncaught exception and the role exits (decision
      // datastore-loss-recover-in-place). The loss wakes the recovery probe.
      operationPool.on('error', error => {
        console.error('PostgreSQL operation pool idle connection error:', error.code || error.name);
        datastoreRecovery?.signal();
      });
      diagnostics.observePool(operationPool, 'operation');
      const window = require('../../tenant-lifecycle/operation-window').create({namespace:chosen.namespace,
        ...(chosen.intakeProfile ? {intakeProfile:chosen.intakeProfile} : {}),
        ...(trustedOperationWorker(names, options) ? { trustedWorker: true } : {}),
        ...(chosen.lockRule ? {lockRule:chosen.lockRule} : {locks:chosen.locks}),pool:operationPool,
        ...(chosen.leaseSessions === undefined ? {} : {leaseSessionCount:chosen.leaseSessions})});
      const { participant, namespaces } = checked;
      operationCohort = await require('./operation-cohort').create({window,names,tenants:chosen.tenantIds ? [...chosen.tenantIds] : chosen.locks.map(row => row.tenant),namespaces:[...namespaces],participant,placement:chosen.placement});
    }
    // One private listener per process; its contracts come from the roles' code.
    const participant = options.operationConfig?.participants?.find(row => row.id === options.operationConfig.participantId);
    const rows = internalListeners.plan(names, { preview: options.preview, realtimePreview: options.realtimePreview,
      vcpoolPreview: options.vcpoolPreview, evaluatorPreview: options.evaluatorPreview, participant });
    if (rows.length) {
      const internal = options.internal || listenerConfig.resolve(names.filter(name => listenerConfig.ROLES.includes(name)), source);
      // A fixed-roster row names this instance by its own address (http://api-1:7001)
      // while it binds a wildcard and dials loopback: same port, or same socket.
      if (participant && listenerConfig.key(participant.endpoint) !== listenerConfig.key(internal.dial) &&
          !listenerConfig.canName(participant.endpoint, internal.listen)) {
        throw new RoleError('Participant manifest does not name this process\'s serve.internal');
      }
      internalListener = await internalListeners.open(internal, rows, { operationWindow: operationCohort?.window });
      console.log('Internal listener for', names.join(','), 'on', internal.listen.socketPath || internal.listen.url, 'routes', internalListener.routes.join(', '));
    }
    const order = names.includes('api') && names.includes('realtime') ? [...names].sort((a, b) => a === 'api' ? -1 : b === 'api' ? 1 : 0) : names;
    for (const name of order) {
      const spec = specs.find(listener => listener.role === name);
      const preview = name === 'realtime' ? options.realtimePreview : name === 'evaluator' ? options.evaluatorPreview
        : name === 'tenant-admin' ? options.ownerPreview : name === 'admin' ? options.adminPreview
          : name === 'vcpool' ? options.vcpoolPreview : options.preview;
      if (name === 'realtime' && !preview) throw new RoleError('realtime requires explicit preview configuration');
      if (name === 'evaluator' && !preview) throw new RoleError('evaluator requires explicit preview configuration');
      if (name === 'tenant-admin' && !preview) throw new RoleError('tenant-admin requires explicit headless preview configuration');
      if (name === 'admin' && !preview) throw new RoleError('admin requires explicit operator configuration');
      if (name === 'vcpool' && !preview) throw new RoleError('vcpool requires explicit connector configuration');
      if ((options.preview || options.ownerPreview || options.evaluatorPreview || options.realtimePreview || options.adminPreview || options.vcpoolPreview) && !preview) throw new RoleError('explicit preview configuration required for each role');
      const role = preview ? (name === 'realtime' ? require('./preview-realtime') : name === 'evaluator' ? require('./evaluator-preview')
        : name === 'tenant-admin' ? require('./owner-preview') : name === 'admin' ? require('./admin-preview')
          : name === 'vcpool' ? require('./vcpool-preview') : require('./preview-api')) : ROLES[name].start();
      const ctx = await (operationCohort ? operationCohort.boot(name, preview) : preview ? role.boot(preview) : role.boot(env, language));
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
    if (operationCohort) {
      operationCohort.complete();
      if (participant) internalListener.bind(participant.roles[0], { 'lifecycle-participant': { create: () => require('./operation-cohort').controlOperations(operationCohort) } });
    }
    internalListener?.assertBound();
    for(const context of Object.values(contexts))if(context.failure)context.failure.then(error=>{
      console.error('Role terminal refusal:',error.code||'ROLE_TERMINAL_REFUSAL');
      const leave=options.roleExhausted||(()=>process.exit(1));
      const watchdog=setTimeout(leave,10000);watchdog.unref();stop().then(leave,leave);
    });
    if (operationCohort) {
      const recovery = require('./datastore-recovery');
      datastoreRecovery = recovery.create({ cohort: operationCohort, ...(options.datastoreRecovery || recovery.settings(source)),
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

  return { servers, contexts, operationCohort, internalListener, datastoreRecovery, stop };
}

module.exports = { refuseRetiredRoles, parseRoles, preflight, trustedOperationWorker, start, RoleError };
