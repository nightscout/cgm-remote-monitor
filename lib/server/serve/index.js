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

class RoleError extends Error {}

// A comma-separated role list, checked against the role table. Throws
// RoleError for an empty, unknown, repeated or not-yet-available role: a role
// is available to `nightscout multitenant` once it is multitenant.
function parseRoles (args, roles) {
  roles = roles || ROLES;
  if (args.length !== 1 || !args[0]) {
    throw new RoleError('nightscout multitenant takes one argument, a comma-separated role list: ' + Object.keys(roles).join(', '));
  }
  const names = args[0].split(',').map(name => name.trim());
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

// Boot every selected role and open its listener when it has one. Resolves with { servers, contexts,
// stop }, where stop() closes the listeners and then each role's MongoDB
// client. Listener settings are checked before anything is booted.
async function start (names, env, language, source, options = {}) {
  const servers = [];
  const contexts = {};
  let operationCohort, operationPool, internalListener, specs;
  // Each role owns its explicitly configured context and shutdown resources.
  let stopping;
  function stop () {
    if (stopping) return stopping;
    operationCohort?.quiesce?.();
    stopping = (async () => {
      // serve.internal first: stop accepting, let in-flight calls answer up to
      // its deadline while role contexts are still alive, then force-close.
      const internal = await Promise.allSettled([internalListener?.close()]);
      const quiesced = await Promise.allSettled(Object.values(contexts).map(ctx => typeof ctx.quiesce === 'function' ? ctx.quiesce() : undefined));
      const sockets = await Promise.allSettled(servers.map(listeners.close));
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
      const failures = [...internal, ...quiesced, ...sockets, ...resources, ...control, ...placements].filter(result => result.status === 'rejected');
      if (failures.length) throw new globalThis.AggregateError(failures.map(result => result.reason), 'Role shutdown failed');
    })();
    return stopping;
  }

  try {
    if (names.includes('feed-reader') && (names.length !== 1 || options.operationConfig)) throw new RoleError('feed-reader is a dedicated process, outside tenant operation cohorts');
    specs = listeners.resolve(names, source, { host: env.HOSTNAME, port: env.PORT });
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
    diagnostics.configureRoles(names);
    if (options.operationConfig && names.includes('admin')) {
      throw new RoleError('admin is not a lifecycle operation cohort participant; run it without MULTITENANT_OPERATION_CONFIG');
    }
    if (options.operationConfig) {
      const chosen = options.operationConfig;
      operationPool = new (require('pg').Pool)(chosen.poolOptions);
      diagnostics.observePool(operationPool, 'operation');
      const window = require('../../tenant-lifecycle/operation-window').create({namespace:chosen.namespace,
        ...(chosen.lockRule ? {lockRule:chosen.lockRule} : {locks:chosen.locks}),pool:operationPool,
        ...(chosen.leaseSessions === undefined ? {} : {leaseSessionCount:chosen.leaseSessions})});
      const cohortModule = require('./operation-cohort');
      const namespaces = new Set([options.preview,options.ownerPreview,options.evaluatorPreview,options.realtimePreview]
        .flatMap(cohortModule.protectedNamespaces).filter(name => name !== chosen.namespace));
      const participant=chosen.participants?.find(row => row.id===chosen.participantId);
      if (participant && (JSON.stringify([...participant.roles].sort())!==JSON.stringify([...names].sort()) ||
          JSON.stringify([...participant.namespaces].sort())!==JSON.stringify([...namespaces].sort()))) throw new RoleError('Participant manifest does not match actual role resources');
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
      const preview = name === 'feed-reader' ? options.feedReader : name === 'realtime' ? options.realtimePreview : name === 'evaluator' ? options.evaluatorPreview
        : name === 'tenant-admin' ? options.ownerPreview : name === 'admin' ? options.adminPreview
          : name === 'vcpool' ? options.vcpoolPreview : options.preview;
      if (name === 'feed-reader' && !preview) throw new RoleError('feed-reader requires explicit feed configuration');
      if (name === 'realtime' && !preview) throw new RoleError('realtime requires explicit preview configuration');
      if (name === 'evaluator' && !preview) throw new RoleError('evaluator requires explicit preview configuration');
      if (name === 'tenant-admin' && !preview) throw new RoleError('tenant-admin requires explicit headless preview configuration');
      if (name === 'admin' && !preview) throw new RoleError('admin requires explicit operator configuration');
      if (name === 'vcpool' && !preview) throw new RoleError('vcpool requires explicit connector configuration');
      if ((options.preview || options.ownerPreview || options.evaluatorPreview || options.realtimePreview || options.adminPreview || options.vcpoolPreview) && !preview) throw new RoleError('explicit preview configuration required for each role');
      const role = preview ? (name === 'feed-reader' ? require('../../change-feed/reader') : name === 'realtime' ? require('./preview-realtime') : name === 'evaluator' ? require('./evaluator-preview')
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
  } catch (err) {
    await stop();
    throw err;
  }

  return { servers, contexts, operationCohort, internalListener, stop };
}

module.exports = { parseRoles, start, RoleError };
