'use strict';

const express = require('express');
const { EventEmitter } = require('node:events');
const scope = require('../../storage/tenant-scope');
const catalogue = require('../tenant-app/domain-catalogue');
const postgresDomains = require('./postgres-domains');
const Collection = require('../../api3/generic/collection');
const purifier = require('../purifier');
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
const { parseCount } = require('../count');
const { ENTRIES_DEFAULT_COUNT } = require('../../constants');
const { legacyQuery } = require('../../middleware/configure-request');
// Noncacheable raw handlers still read these empty fields before selecting
// storage. This sentinel contains no mutable/request/tenant state.
const EMPTY_RAW = Object.freeze([]);
const EMPTY_RAW_CACHE = Object.freeze({ entries: EMPTY_RAW, treatments: EMPTY_RAW, devicestatus: EMPTY_RAW,
  getDataRef: () => [] });

function followerPage (model, query) {
  let type = model || null;
  if (!model && query.find) {
    if (typeof query.find !== 'object' || Array.isArray(query.find)) return;
    if (Object.hasOwn(query.find, 'type')) {
      const filter = query.find.type;
      type = filter && typeof filter === 'object' && Object.keys(filter).length === 1 ? filter.$eq : filter;
      if (typeof type !== 'string') return;
    }
  }
  if (type !== null && !['sgv', 'mbg', 'cal'].includes(type)) return;
  const count = parseCount(query.count || ENTRIES_DEFAULT_COUNT);
  if (count) return { type, count, includeHeader: !model };
}

function snapshotFailure (error) {
  const failure = new Error('Tenant snapshot failed', { cause: error });
  failure.code = 'TENANT_SNAPSHOT_INTERNAL';
  if (isUnavailable(error)) failure.code = 'TENANT_SNAPSHOT_UNAVAILABLE';
  return failure;
}

module.exports = async function previewDomains ({ config, connection, exchange, displaySettings, servingState, tenantCache, storageHint }) {
  const data = express.Router();
  const storageCatalogues = postgresDomains.cataloguesFor(config);
  const cache = tenantCache || require('./api-tenant-cache').create(require('./pool-config').apiTenantCache());
  const requestServices = new WeakMap();
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
    resolve: (req, logical) => requestServices.get(req).v3Binding(logical) });
  // Route graphs belong to the process; tenant ports are disposable and built
  // on demand. A request holds its selected service even after LRU eviction.
  async function build (tenant) {
    const env = config.environments.get(tenant);
    const bus = new EventEmitter(), ports = new Map(), factories = new Map(), collections = {};
    // Spike S2: the APIv3 handlers' post-write `storage-socket-*` events on
    // this bus (single tenant's own /storage source) become realtime hints.
    if (storageHint) storageHint.attach(bus, tenant);
    const portFor = key => { if (!ports.has(key) && factories.has(key)) ports.set(key, factories.get(key)()); return ports.get(key); };
    for (const logical of config.domains) {
      env[logical + '_collection'] = logical;
      const domain = catalogue.get(logical);
      const { factory } = postgresDomains.get(logical);
      if (domain.v3) {
        const create = () => {
          const port = factory({ connection, catalogue: storageCatalogues[logical], table: config.namespaces[logical] + '.' + logical, bus, env, source: 'v3' });
          if (!port?.storage || typeof port.intentFactory !== 'function') throw new TypeError('Injected storage requires an intent factory');
          return port;
        };
        factories.set(logical + ':v3', create);
      }
      if (config.legacyEnabled && domain.legacy) {
        // With socket forwarding the treatments table is the socket-order
        // catalogue's (insertion_ordinal, postgres-domains.js): the v1 port
        // reads and replaces in insertion order, as official/dev (INC-P).
        const natural = logical === 'treatments' && !!config.socketForwarding ? { naturalOrder: true } : {};
        const create = () => factory({ connection, catalogue: storageCatalogues[logical], table: config.namespaces[logical] + '.' + logical, bus, env, source: 'v1/internal', ...natural });
        factories.set(logical + ':v1/internal', create);
      }
    }

    const socketFactories = new Map(), socketBuilding = new Map();
    async function prepareSocket (logical) {
      const key = logical + ':socket';
      if (ports.has(key) || !socketFactories.has(logical)) return;
      if (!socketBuilding.has(logical)) {
        const pending = socketFactories.get(logical)().then(port => { ports.set(key, port); });
        socketBuilding.set(logical, pending);
        pending.finally(() => { if (socketBuilding.get(logical) === pending) socketBuilding.delete(logical); }).catch(() => {});
      }
      return socketBuilding.get(logical);
    }
    if (config.socketForwarding) for (const logical of config.domains) {
      if (!['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'].includes(logical)) continue;
      socketFactories.set(logical, async () => {
        const selected = ['treatments', 'devicestatus', 'profile'].includes(logical)
          ? await require('../tenant-socket-order-port')({
            namespace: config.namespaces[logical], connection, logical, env, bus })
          : logical === 'activity' ? require('../../storage/postgres-collection-intent')({ connection, table: config.namespaces[logical] + '.' + logical, logical, bus, env, source: 'socket' })
            : postgresDomains.get(logical).factory({ connection, table: config.namespaces[logical] + '.' + logical, bus, env, source: 'socket' });
        // The selected T/D order constructors and activity return committed
        // intent steps; adapt only those known steps to the trusted port shape.
        return ['treatments', 'devicestatus', 'activity'].includes(logical)
          ? { storage: selected.storage, intentFactory: () => selected } : selected;
      });
    }
    const storagePorts = { resolve: ({ logical, source }) => portFor(logical + ':' + source) };
    // Collection storage remains private and demand-created. The database
    // allocator owns history dates; no document scan initializes a service.
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
    let retainedLegacy;
    function legacy () {
      if (!config.legacyEnabled) return {};
      if (retainedLegacy) return retainedLegacy;
      let graph, snapshotPorts, frameService;
      // A legacy acquisition owns its cache listeners. Attaching them to the
      // retained service bus would keep every discarded request frame alive.
      const ctx = { bus: new EventEmitter(), storagePorts, purifier: purifier({}, {}), ddata: createData() };
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
      if (snapshotPorts.entries) {
        snapshotPorts.entries.readFollowerEntries = options => portFor('entries:v1/internal').storage.readFollowerEntries(options);
      }
      const statistics = require('../../storage/postgres-tenant-stats')({ connection,
        sealedDeviceStatus: require('../../storage/devicestatus-sealing').selected(storageCatalogues.devicestatus),
        ...(config.namespaces.clock ? { clock: config.namespaces.clock + '.tenant_write_clock' } : {}),
        tables: Object.fromEntries(config.domains.map(logical => [logical, config.namespaces[logical] + '.' + logical])) });
      snapshotPorts.stats = { tenant, read: () => statistics.read(tenant) };
      frameService = snapshot({ tenant, ports: snapshotPorts, env, language });
      return (retainedLegacy = {graph, snapshotPorts, frameService});
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
    return { env, storagePorts, legacy, prepareSocket, socketFactories, context, contextFor, get routes () { return routesFor(); }, collections, ports, factories, presentationState: {}, dispatch, v3Binding };
  }
  function ensure (tenant) {
    if (!config.bindings.has(tenant)) return Promise.reject(new Error('Unknown preview tenant'));
    let record = config.tenantRecord ? config.tenantRecord(tenant) : cache.get(tenant);
    if (!record) { record = {}; cache.set(tenant, record); }
    return cache.load(record, () => build(tenant));
  }
  async function prepareTenant (tenant, request) {
    const service = await ensure(tenant);
    if (request) requestServices.set(request, service);
    return service;
  }
  function forRequest (req) {
    return requestServices.has(req) ? Promise.resolve(requestServices.get(req)) : prepareTenant(req.tenantContext?.tenant || scope.requireTenant('API service selection'), req);
  }
  // One dispatcher replaces one middleware per tenant (O(1) per request).
  data.use(async (req, res, next) => {
    if (!config.bindings.has(req.tenantContext.tenant)) return next();
    let service;
    try { service = await forRequest(req); } catch (error) { return next(error); }
    return service.dispatch(req, res, next);
  });
  const safeRoutes = config.contextEnabled ? {
    1: ['/status', '/verifyauth'],
    2: ['/status', '/verifyauth', '/authorization/permissions', '/authorization/permissions/trie'],
    3: ['/status', '/version', '/lastModified', '/versions']
  } : {};
  const legacyRouter = config.legacyEnabled || config.contextEnabled ? async (req, res, next) => {
    try {
      const tenant = scope.requireTenant('legacy preview route');
      const service = await forRequest(req);
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
      let operationLegacy;
      const legacy = () => operationLegacy || (operationLegacy = service.legacy());
      const frames = () => operationEnv === service.env ? legacy().frameService
        : legacy().snapshotPorts ? snapshot({ tenant, ports: legacy().snapshotPorts, env: operationEnv, language }) : undefined;
      const operationFrames = metadata ? undefined : {loadRaw: (...args) => frames().loadRaw(...args), load: (...args) => frames().load(...args)};
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
      const query = legacyQuery(req);
      const otherEntryFilter = query.find && typeof query.find === 'object' &&
        !Array.isArray(query.find) && Object.keys(query.find).some(key => key !== 'type');
      const countOnly = Object.keys(query).every(key => key === 'count');
      const rawCache = read && rawDomains && logical && (
        rawEntries ? !match[2] || (match[2] !== 'current' && !require('../object-id-forms').isHexId(match[2]) && !otherEntryFilter)
          : ['treatments', 'devicestatus'].includes(logical) && !match[2] && countOnly) ? logical : null;
      const follower = rawCache === 'entries' && !otherEntryFilter ? followerPage(match[2], query) : undefined;
      // The untyped entries route still needs its Last-Modified header when
      // an explicit filter sends the response body directly to storage.
      const entriesHeaderOnly = rawCache === 'entries' && !match[2] && otherEntryFilter;
      const loadRaw = () => operationFrames.loadRaw(rawCache, { follower, entriesHeaderOnly });
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
      const requestGraph = rawDomains ? legacy().graph : createLegacy({ env: operationEnv, ctx: local, domains: legacyNames });
      const requestContext = Object.create(requestGraph.context);
      for (const field of ['bus', 'purifier', 'ddata', 'cache']) {
        Object.defineProperty(requestContext, field, {
          get: () => ctx[field], set: value => { ctx[field] = value; }
        });
      }
      let committedRawFrame;
      if (rawCache) require('../tenant-app/data-access').registerRawRead(req, {
        tenant, connection, logical: rawCache,
        // Joined authorization loads the clinical frame before prepareTenantFrame.
        // Keep its storage failure provenance without relabeling authority or COMMIT.
        load: async () => {
          try { return await loadRaw(); } catch (error) { throw snapshotFailure(error); }
        },
        publish: frame => { committedRawFrame = frame; }
      });
      if (!metadata && (!rawDomains || rawCache)) Object.defineProperty(req, 'prepareTenantFrame', { value: async () => {
        try {
          const frame = committedRawFrame || await (rawDomains ? loadRaw() : operationFrames.load());
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
  const rootRouter = config.contextEnabled ? async (req, res, next) =>
    { let service; try { service = await forRequest(req); } catch (error) { return next(error); } return service.context.root(req, res, next); } : undefined;
  async function socketContextFor (operation) {
    if (!config.socketForwarding || operation.actor.tenant !== operation.tenant) throw new Error('Socket context refused');
    const service = await ensure(operation.tenant);
    const context = () => {
      const ctx = { bus: new EventEmitter(), storagePorts: service.storagePorts, purifier: purifier({}, {}), ddata: createData() };
      ctx.cache = createCache(service.env, ctx);
      return { env: service.env, ctx, authorizationFor: () => operation.actor.permissions,
        credentialsFor: () => operation.actor.redactions || [], clientId: 'tenant-forwarded' };
    };
    // The canonical executor already awaits this trusted context before calling
    // a handler. A failed constructor has no mutation to retry or acknowledge.
    await service.prepareSocket(operation.args?.[0]?.collection);
    return context();
  }
  // describeTenant: the constructed environment and plugin enablement, for the
  // clinical-equivalence control (tests/preview-domains-equivalence.test.js).
  function describeTenant (tenant) {
    const service = cache.peek(tenant)?.service, seen = new WeakSet();
    if (!service) throw new Error('Tenant service is not selected');
    const legacy = service.legacy();
    // The equivalence diagnostic describes the complete v3 construction.
    Object.values(service.collections);
    const plain = value => value === undefined ? null : JSON.parse(JSON.stringify(value, (key, x) => {
      if (typeof x === 'function') return '[function ' + (x.name || 'anonymous') + ']';
      if (x && typeof x === 'object') { if (seen.has(x)) return '[circular]'; seen.add(x); }
      return x;
    }));
    const settings = app => app ? Object.fromEntries(Object.entries(app.settings).filter(([, v]) => typeof v !== 'function').map(([k, v]) => [k, plain(v)])) : null;
    return { env: plain(service.env), v3Settings: settings(service.routes), collections: Object.keys(service.collections).sort(), ports: [...new Set([...service.factories.keys(), ...service.ports.keys(), ...[...service.socketFactories.keys()].map(logical => logical + ':socket')])].sort(),
      v1Settings: settings(legacy.graph?.v1), v2Settings: settings(legacy.graph?.v2), context: !!service.context, frames: !!legacy.frameService };
  }
  return { data, legacyRouter, rootRouter, safeRoutes, v3Names, legacyNames, socketContextFor, describeTenant,
    prepareTenant, invalidateTenant: tenant => cache.delete(tenant), invalidateAll: () => cache.clear(),
    cacheStats: cache.stats, close: cache.close };
};
