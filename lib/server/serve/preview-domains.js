'use strict';

const express = require('express');
const { EventEmitter } = require('node:events');
const scope = require('../../storage/tenant-scope');
const catalogue = require('../tenant-app/domain-catalogue');
const postgresDomains = require('./postgres-domains');
const Collection = require('../../api3/generic/collection');
const purifier = require('../purifier');
const dates = require('../srv-dates');
const createData = require('../../data/ddata');
const createCache = require('../cache');
const createLegacy = require('../tenant-app/legacy-domains');
const statusAuthorization = require('../tenant-app/status-authorization');
const snapshot = require('../tenant-app/snapshot');
const sharedRestContext = require('../tenant-app/shared-rest-context');
const language = require('../../language')();
const sharedLegacyRoutes = require('../tenant-app/shared-legacy-routes');
const application = require('../../../package.json');
const { isUnavailable } = require('../../storage/failures');
const sharedV3Routes = require('../tenant-app/shared-v3-routes');
// Noncacheable raw handlers still read these empty fields before selecting
// storage. This sentinel contains no mutable/request/tenant state.
const EMPTY_RAW = Object.freeze([]);
const EMPTY_RAW_CACHE = Object.freeze({ entries: EMPTY_RAW, treatments: EMPTY_RAW, devicestatus: EMPTY_RAW,
  getDataRef: () => [] });

function snapshotFailure (error) {
  const failure = new Error('Tenant snapshot failed', { cause: error });
  failure.code = 'TENANT_SNAPSHOT_INTERNAL';
  if (isUnavailable(error)) failure.code = 'TENANT_SNAPSHOT_UNAVAILABLE';
  return failure;
}

module.exports = async function previewDomains ({ config, connection, exchange, displaySettings, servingState, deferInitialization = false }) {
  const data = express.Router();
  const services = new Map();
  const storageVersion = await connection.withTenant('00000000-0000-0000-0000-000000000000', async () =>
    (await connection.query("SELECT current_setting('server_version') AS version")).rows[0].version);
  data.use((req, res, next) => scope.withTenant(req.tenantContext.tenant, next));
  const v3Names = config.domains.filter(name => catalogue.get(name).v3);
  const legacyNames = config.legacyEnabled ? config.domains.filter(name => catalogue.get(name).legacy) : [];
  const legacyRoutes = config.legacyEnabled ? sharedLegacyRoutes({ domains: legacyNames }) : null;
  const metadataRoutes = config.contextEnabled ? sharedRestContext({
    versionInfo: { name: application.name, version: application.version,
      storage: { storage: 'PostgreSQL', version: storageVersion } },
    admitted: { 1: legacyNames, 2: legacyNames, 3: v3Names }, servingState
  }) : null;
  const sharedV3 = sharedV3Routes({ names: v3Names,
    resolve: (req, logical) => serviceOf(req.tenantContext.tenant).v3Binding(logical) });
  // Warm only tenant-owned storage/runtime state. Route graphs belong to the
  // API composition; their size is independent of the admitted tenant roster.
  const building = new Map();
  async function build (tenant) {
    const env = config.environments.get(tenant);
    const bus = new EventEmitter(), ports = new Map(), collections = {};
    for (const logical of config.domains) {
      env[logical + '_collection'] = logical;
      const domain = catalogue.get(logical);
      const { factory } = postgresDomains.get(logical);
      if (domain.v3) ports.set(logical + ':v3', factory({
        connection, table: config.namespaces[logical] + '.' + logical, bus, env, source: 'v3'
      }));
      if (config.legacyEnabled && domain.legacy) ports.set(logical + ':v1/internal', factory({
        connection, table: config.namespaces[logical] + '.' + logical, bus, env, source: 'v1/internal'
      }));
    }
    if (config.socketForwarding) for (const logical of config.domains) {
      if (!['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'].includes(logical)) continue;
      const selected = ['treatments', 'devicestatus', 'profile'].includes(logical)
        ? await require('../tenant-socket-order-port')({ readinessConnectionString: config.readinessConnectionString,
          namespace: config.namespaces[logical], connection, logical, env, bus })
        : logical === 'activity' ? require('../../storage/postgres-collection-intent')({ connection, table: config.namespaces[logical] + '.' + logical, logical, bus, env, source: 'socket' })
          : postgresDomains.get(logical).factory({ connection, table: config.namespaces[logical] + '.' + logical, bus, env, source: 'socket' });
      // The selected T/D order constructors and activity constructor return
      // committed intent steps; the other domain factories return trusted
      // ports. Adapt only those known steps at this API composition boundary.
      // Keep their exact storage, source, ordering and owned write boundary.
      const port = ['treatments', 'devicestatus', 'activity'].includes(logical)
        ? { storage: selected.storage, intentFactory: () => selected } : selected;
      ports.set(logical + ':socket', port);
    }
    const storagePorts = { resolve: ({ logical, source }) => ports.get(logical + ':' + source) };
    // Warmup restores storage clocks without constructing tenant HTTP apps.
    // Collection storage and pruning state remain private and demand-created.
    let routes;
    function routesFor () {
      if (routes) return routes;
      routes = sharedV3.settings();
      return routes;
    }
    const v3Contexts = {};
    for (const logical of v3Names) {
      let collection;
      Object.defineProperty(collections, logical, { enumerable: true, get: () => {
        if (!collection) {
          v3Contexts[logical] = { bus, purifier: purifier({}, {}) };
          collection = new Collection({
            ctx: v3Contexts[logical], env, app: routesFor(), colName: logical, storageColName: logical,
            ...catalogue.get(logical), ...storagePorts.resolve({ logical, source: 'v3' })
          });
        }
        return collection;
      } });
    }
    function v3Binding (logical) {
      const col = collections[logical];
      return { ctx: v3Contexts[logical], env, app: routesFor(), col };
    }
    const initialize = () => scope.withTenant(tenant, () => dates.restoreResolved(
      v3Names.map(logical => storagePorts.resolve({ logical, source: 'v3' }).storage)));
    let frameService, snapshotPorts, graph;
    if (config.legacyEnabled) {
      const ctx = { bus, storagePorts, purifier: purifier({}, {}), ddata: createData() };
      ctx.cache = createCache(env, ctx);
      // Warm wrappers serve snapshots and sockets; HTTP trees are shared.
      const facade = { storagePorts };
      for (const field of ['bus', 'purifier', 'ddata', 'cache']) Object.defineProperty(facade, field, {
        enumerable: true, get: () => (legacyRoutes.currentContext(tenant) || ctx)[field],
        set: value => { (legacyRoutes.currentContext(tenant) || ctx)[field] = value; }
      });
      graph = createLegacy({ env, ctx: facade, domains: legacyNames });
      snapshotPorts = Object.fromEntries(legacyNames.map(logical => [logical,
        { tenant, store: graph.context[logical] }]));
      const statistics = require('../../storage/postgres-tenant-stats')({ connection,
        tables: Object.fromEntries(config.domains.map(logical => [logical, config.namespaces[logical] + '.' + logical])) });
      snapshotPorts.stats = { tenant, read: () => statistics.read(tenant) };
      frameService = snapshot({ tenant, ports: snapshotPorts, env, language });
    }
    const contextFor = localEnv => metadataRoutes ? metadataRoutes.forContext({
      tenant, env: localEnv, collections, statusAuthorization: statusAuthorization({ tenant, exchange })
    }) : null;
    const context = contextFor(env);
    function dispatch (req, res, next) {
      return sharedV3.router(req, res, error => {
        if (error || !context) return next(error);
        return context.v3(req, res, next);
      });
    }
    const service = { initialize, env, storagePorts, frameService, snapshotPorts, context, contextFor, get routes () { return routesFor(); }, graph, collections, ports, presentationState: {}, dispatch, v3Binding };
    services.set(tenant, service);
    return service;
  }
  function ensure (tenant) {
    if (!config.bindings.has(tenant)) return Promise.reject(new Error('Unknown preview tenant'));
    if (!building.has(tenant)) {
      const pending = build(tenant);
      building.set(tenant, pending);
      pending.catch(() => { if (building.get(tenant) === pending) building.delete(tenant); });
    }
    return building.get(tenant);
  }
  // A tenant reaches these routes only after its warm (startup.admit/ensure);
  // a request that arrives before construction is refused like a cold tenant.
  function serviceOf (tenant) {
    const service = services.get(tenant);
    if (!service) throw Object.assign(new Error('TENANT_WARMING'), { code: 'TENANT_WARMING', retryAfter: 5 });
    return service;
  }
  // One dispatcher replaces one middleware per tenant (O(1) per request).
  data.use((req, res, next) => {
    if (!config.bindings.has(req.tenantContext.tenant)) return next();
    let service;
    try { service = serviceOf(req.tenantContext.tenant); } catch (error) { return next(error); }
    return service.dispatch(req, res, next);
  });
  if (!deferInitialization) for (const tenant of config.bindings.keys()) await (await ensure(tenant)).initialize();
  const safeRoutes = config.contextEnabled ? {
    1: ['/status', '/verifyauth'],
    2: ['/status', '/verifyauth', '/authorization/permissions', '/authorization/permissions/trie'],
    3: ['/status', '/version', '/lastModified', '/versions']
  } : {};
  const legacyRouter = config.legacyEnabled || config.contextEnabled ? async (req, res, next) => {
    try {
      const tenant = scope.requireTenant('legacy preview route');
      const service = serviceOf(tenant);
      // Only display/derived READs select current tenant configuration. In
      // particular raw POST/PUT/DELETE and credential exchange retain their
      // storage environment and cannot depend on this reader's availability.
      const metadata = (safeRoutes[req.baseUrl === '/api/v2' ? 2 : 1] || [])
        .includes(req.path.replace(/\.[a-z]+$/i, '').replace(/\/$/, ''));
      const presentation = require('../tenant-app/presentation-environment');
      if (displaySettings && presentation.consumesDisplay(req)) await req.tenantAuthenticate();
      const operationEnv = await presentation.forRequest({ reader: displaySettings, tenant,
        env: service.env, request: req, domains: config.domains, metadataState: metadata ? service.presentationState : undefined });
      // Most raw/derived handlers finish without using metadata fallback.
      // Construct its tenant-local route trees only if that fallback is reached.
      let operationContext;
      function contextForRequest () {
        if (operationContext !== undefined) return operationContext;
        if (operationEnv === service.env) return (operationContext = service.context);
        if (metadata && service.presentationState.contextEnv === operationEnv) return (operationContext = service.presentationState.context);
        operationContext = service.contextFor(operationEnv);
        if (metadata) Object.assign(service.presentationState, { contextEnv: operationEnv, context: operationContext });
        return operationContext;
      }
      const operationFrames = metadata ? undefined : operationEnv === service.env ? service.frameService
        : service.snapshotPorts ? snapshot({ tenant, ports: service.snapshotPorts, env: operationEnv, language }) : undefined;
      function contextRoutes (error) {
        if (error) return next(error);
        // Some shipping raw handlers call next after sending their result.
        // They must not enter metadata authorization or try a second reply.
        if (res.headersSent) return;
        const operationContext = contextForRequest();
        if (!operationContext) return next();
        return operationContext.legacy(req, res, error => {
          if (error) return next(error);
          return req.baseUrl === '/api/v2' ? operationContext.v2(req, res, next) : next();
        });
      }
      if (!config.legacyEnabled || metadata) {
        const common = contextForRequest().common;
        return common(req, res, contextRoutes);
      }
      // The raw handlers own their storage queries. Only the three handlers
      // with shipping cache behavior need an acquisition, for their own domain.
      // Keep private mutable context per request, but construct only its routes.
      const rawPath = req.path.replace(/\.(json|svg|csv|txt|png|html|tsv)$/i, '').replace(/\/$/, '');
      const match = /^\/(entries|treatments|devicestatus|profile|profiles|food|activity)(?:\/([^/]+))?$/.exec(rawPath);
      const logical = match && (match[1] === 'profiles' ? 'profile' : match[1]);
      const alias = /^\/(echo|count|slice|times)(?:\/([^/]+))?/.exec(rawPath);
      const rawDomains = logical && legacyNames.includes(logical) ? [logical]
        : alias ? [...new Set(['entries', ...(legacyNames.includes(alias[2]) ? [alias[2]] : [])])] : null;
      const rawEntries = logical === 'entries';
      const read = ['GET', 'HEAD'].includes(req.method);
      const otherEntryFilter = req.query.find && typeof req.query.find === 'object' &&
        !Array.isArray(req.query.find) && Object.keys(req.query.find).some(key => key !== 'type');
      const countOnly = Object.keys(req.query).every(key => key === 'count');
      const rawCache = read && rawDomains && logical && (
        rawEntries ? !match[2] || (match[2] !== 'current' && !require('../object-id-forms').isHexId(match[2]) && !otherEntryFilter)
          : ['treatments', 'devicestatus'].includes(logical) && !match[2] && countOnly) ? logical : null;
      const ctx = { storagePorts: service.storagePorts, purifier: purifier({}, {}) };
      if (!rawDomains) {
        ctx.bus = new EventEmitter(); ctx.ddata = createData();
        ctx.cache = createCache(operationEnv, ctx);
      } else if (!rawCache) {
        ctx.bus = new EventEmitter(); ctx.cache = EMPTY_RAW_CACHE;
        // Writes normalize their emitted changes without loading a frame.
        let data;
        Object.defineProperty(ctx, 'ddata', { enumerable: true, get: () => data || (data = createData()) });
      }
      // A raw cache acquisition supplies its one private data/cache/bus set
      // before its handler runs. Other raw handlers never consume a frame.
      // Every request owns its frame. The immutable HTTP graph
      // reads it through the composition's request-local closure adapter.
      // Warm wrappers retain their own private frame for snapshots/sockets.
      const local = { storagePorts: service.storagePorts };
      for (const field of ['bus', 'purifier', 'ddata', 'cache']) Object.defineProperty(local, field, {
        enumerable: true, get: () => ctx[field], set: value => { ctx[field] = value; }
      });
      const requestGraph = rawDomains ? service.graph : createLegacy({ env: operationEnv, ctx: local, domains: legacyNames });
      const requestContext = Object.create(requestGraph.context);
      for (const field of ['bus', 'purifier', 'ddata', 'cache']) {
        Object.defineProperty(requestContext, field, {
          get: () => ctx[field], set: value => { ctx[field] = value; }
        });
      }
      let committedEntriesFrame;
      if (rawCache === 'entries') require('../tenant-app/data-access').registerEntriesRead(req, {
        tenant, connection,
        // Joined authorization loads the clinical frame before prepareTenantFrame.
        // Keep its storage failure provenance without relabeling authority or COMMIT.
        load: async () => {
          try { return await operationFrames.loadRaw('entries'); } catch (error) { throw snapshotFailure(error); }
        },
        publish: frame => { committedEntriesFrame = frame; }
      });
      if (!metadata && (!rawDomains || rawCache)) Object.defineProperty(req, 'prepareTenantFrame', { value: async () => {
        try {
          const frame = committedEntriesFrame || await (rawDomains ? operationFrames.loadRaw(rawCache) : operationFrames.load());
          requestContext.ddata = frame.ddata;
          requestContext.cache = frame.cache;
          requestContext.bus = frame.bus;
          if (req.baseUrl === '/api/v2' && /^\/(properties|ddata|summary)(?:[/.]|$)/i.test(req.path)) {
            requestContext.sbx = legacyRoutes.prepare(operationEnv, frame);
          }
        } catch (error) { throw snapshotFailure(error); }
      } });
      return legacyRoutes.dispatch({ tenant, env: operationEnv, ctx: requestContext,
        loadFrame: async options => {
          try { return await operationFrames.load(options); } catch (error) { throw snapshotFailure(error); }
        } }, req, res, contextRoutes);
    } catch (error) { next(error); }
  } : undefined;
  const rootRouter = config.contextEnabled ? (req, res, next) =>
    { let service; try { service = serviceOf(req.tenantContext.tenant); } catch (error) { return next(error); } return service.context.root(req, res, next); } : undefined;
  function socketContextFor (operation) {
    const service = services.get(operation.tenant);
    if (!config.socketForwarding || !service || operation.actor.tenant !== operation.tenant) throw new Error('Socket context refused');
    const ctx = { bus: new EventEmitter(), storagePorts: service.storagePorts, purifier: purifier({}, {}), ddata: createData() };
    ctx.cache = createCache(service.env, ctx);
    return { env: service.env, ctx, authorizationFor: () => operation.actor.permissions,
      credentialsFor: () => operation.actor.redactions || [], clientId: 'tenant-forwarded' };
  }
  // describeTenant: the constructed environment and plugin enablement, for the
  // clinical-equivalence control (tests/preview-domains-equivalence.test.js).
  function describeTenant (tenant) {
    const service = serviceOf(tenant), seen = new WeakSet();
    // The equivalence diagnostic describes the complete v3 construction.
    Object.values(service.collections);
    const plain = value => value === undefined ? null : JSON.parse(JSON.stringify(value, (key, x) => {
      if (typeof x === 'function') return '[function ' + (x.name || 'anonymous') + ']';
      if (x && typeof x === 'object') { if (seen.has(x)) return '[circular]'; seen.add(x); }
      return x;
    }));
    const settings = app => app ? Object.fromEntries(Object.entries(app.settings).filter(([, v]) => typeof v !== 'function').map(([k, v]) => [k, plain(v)])) : null;
    return { env: plain(service.env), v3Settings: settings(service.routes), collections: Object.keys(service.collections).sort(), ports: [...service.ports.keys()].sort(),
      v1Settings: settings(service.graph?.v1), v2Settings: settings(service.graph?.v2), context: !!service.context, frames: !!service.frameService };
  }
  return { data, legacyRouter, rootRouter, safeRoutes, v3Names, legacyNames, socketContextFor, describeTenant,
    initializeTenant: async tenant => (await ensure(tenant)).initialize() };
};
