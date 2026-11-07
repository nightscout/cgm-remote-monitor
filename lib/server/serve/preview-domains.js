'use strict';

const express = require('express');
const { EventEmitter } = require('node:events');
const scope = require('../../storage/tenant-scope');
const catalogue = require('../tenant-app/domain-catalogue');
const postgresDomains = require('./postgres-domains');
const Collection = require('../../api3/generic/collection');
const apiConst = require('../../api3/const.json');
const purifier = require('../purifier');
const dates = require('../srv-dates');
const createData = require('../../data/ddata');
const createCache = require('../cache');
const createLegacy = require('../tenant-app/legacy-domains');
const authorization = require('../tenant-app/legacy-authorization');
const statusAuthorization = require('../tenant-app/status-authorization');
const snapshot = require('../tenant-app/snapshot');
const restContext = require('../tenant-app/rest-context');
const language = require('../../language')();
const derivedReads = require('../tenant-app/derived-reads');
const application = require('../../../package.json');
const { isUnavailable } = require('../../storage/failures');

function snapshotFailure (error) {
  const failure = new Error('Tenant snapshot failed', { cause: error });
  failure.code = 'TENANT_SNAPSHOT_INTERNAL';
  if (isUnavailable(error)) failure.code = 'TENANT_SNAPSHOT_UNAVAILABLE';
  return failure;
}

module.exports = async function previewDomains ({ config, connection, exchange, displaySettings }) {
  const data = express.Router();
  const services = new Map();
  const storageVersion = await connection.withTenant('00000000-0000-0000-0000-000000000000', async () =>
    (await connection.query("SELECT current_setting('server_version') AS version")).rows[0].version);
  data.use((req, res, next) => scope.withTenant(req.tenantContext.tenant, next));
  const v3Names = config.domains.filter(name => catalogue.get(name).v3);
  const legacyNames = config.legacyEnabled ? config.domains.filter(name => catalogue.get(name).legacy) : [];
  for (const tenant of config.bindings.keys()) {
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
    const storagePorts = { resolve: ({ logical, source }) => ports.get(logical + ':' + source) };
    const routes = express();
    routes.disable('x-powered-by');
    routes.disable('etag');
    routes.set('trust proxy', false);
    for (const [name, value] of Object.entries(apiConst)) if (name.startsWith('API3_')) routes.set(name, value);
    routes.setENVTruthy = (name, value) => { routes.set(name, value); return value; };
    for (const logical of v3Names) {
      const domain = catalogue.get(logical);
      collections[logical] = new Collection({
        ctx: { bus, purifier: purifier({}, {}) }, env, app: routes, colName: logical, storageColName: logical,
        ...domain, ...storagePorts.resolve({ logical, source: 'v3' })
      });
      collections[logical].mapRoutes();
    }
    await scope.withTenant(tenant, () => dates.restoreResolved(Object.values(collections).map(col => col.storage)));
    let frameService, snapshotPorts;
    if (config.legacyEnabled) {
      const ctx = { bus, storagePorts, purifier: purifier({}, {}), ddata: createData() };
      ctx.cache = createCache(env, ctx);
      const graph = createLegacy({ env, ctx, domains: legacyNames });
      snapshotPorts = Object.fromEntries(legacyNames.map(logical => [logical,
        { tenant, store: graph.context[logical] }]));
      const statistics = require('../../storage/postgres-tenant-stats')({ connection,
        tables: Object.fromEntries(config.domains.map(logical => [logical, config.namespaces[logical] + '.' + logical])) });
      snapshotPorts.stats = { tenant, read: () => statistics.read(tenant) };
      frameService = snapshot({ tenant, ports: snapshotPorts, env, language });
    }
    const contextFor = localEnv => config.contextEnabled ? restContext({
      env: localEnv, authorization: authorization(), collections,
      versionInfo: { name: application.name, version: application.version,
        storage: { storage: 'PostgreSQL', version: storageVersion } },
      admitted: { 1: legacyNames, 2: legacyNames, 3: v3Names },
      statusAuthorization: statusAuthorization({ tenant, exchange })
    }) : null;
    const context = contextFor(env);
    if (context) routes.use(context.v3);
    services.set(tenant, { env, storagePorts, frameService, snapshotPorts, context, contextFor });
    data.use((req, res, next) => req.tenantContext.tenant === tenant ? routes(req, res, next) : next());
  }
  const safeRoutes = config.contextEnabled ? {
    1: ['/status', '/verifyauth'],
    2: ['/status', '/verifyauth', '/authorization/permissions', '/authorization/permissions/trie'],
    3: ['/status', '/version', '/lastModified', '/versions']
  } : {};
  const legacyRouter = config.legacyEnabled || config.contextEnabled ? async (req, res, next) => {
    try {
      const tenant = scope.requireTenant('legacy preview route');
      const service = services.get(tenant);
      // Only display/derived READs select current tenant configuration. In
      // particular raw POST/PUT/DELETE and credential exchange retain their
      // storage environment and cannot depend on this reader's availability.
      const presentation = require('../tenant-app/presentation-environment');
      if (displaySettings && presentation.consumesDisplay(req)) await req.tenantAuthenticate();
      const operationEnv = await presentation.forRequest({ reader: displaySettings, tenant,
        env: service.env, request: req, domains: config.domains });
      const operationContext = operationEnv === service.env ? service.context : service.contextFor(operationEnv);
      const operationFrames = operationEnv === service.env ? service.frameService
        : service.snapshotPorts ? snapshot({ tenant, ports: service.snapshotPorts, env: operationEnv, language }) : undefined;
      const metadata = (safeRoutes[req.baseUrl === '/api/v2' ? 2 : 1] || [])
        .includes(req.path.replace(/\.[a-z]+$/i, '').replace(/\/$/, ''));
      function contextRoutes (error) {
        if (error) return next(error);
        if (!operationContext) return next();
        return operationContext.legacy(req, res, error => {
          if (error) return next(error);
          return req.baseUrl === '/api/v2' ? operationContext.v2(req, res, next) : next();
        });
      }
      if (!config.legacyEnabled) {
        const common = require('../../api')(operationEnv, {
          wares: require('../../middleware')(operationEnv)
        }, { domains: [], apiEnabled: true });
        return common(req, res, contextRoutes);
      }
      const bus = new EventEmitter();
      const ctx = { bus, storagePorts: service.storagePorts, purifier: purifier({}, {}), ddata: createData() };
      ctx.cache = createCache(operationEnv, ctx);
      const graph = createLegacy({ env: operationEnv, ctx, domains: legacyNames });
      const derived = derivedReads({ env: operationEnv, ctx: graph.context,
        loadFrame: async options => {
          try { return await operationFrames.load(options); } catch (error) { throw snapshotFailure(error); }
        } });
      graph.v2.use(derived);
      if (!metadata) Object.defineProperty(req, 'prepareTenantFrame', { value: async () => {
        try {
          const frame = await operationFrames.load();
          graph.context.ddata = frame.ddata;
          graph.context.cache = frame.cache;
          graph.context.bus = frame.bus;
          if (req.baseUrl === '/api/v2' && /^\/(properties|ddata|summary)(?:[/.]|$)/i.test(req.path)) {
            graph.context.sbx = derived.prepare(frame);
          }
        } catch (error) { throw snapshotFailure(error); }
      } });
      return graph(req, res, contextRoutes);
    } catch (error) { next(error); }
  } : undefined;
  const rootRouter = config.contextEnabled ? (req, res, next) =>
    services.get(req.tenantContext.tenant).context.root(req, res, next) : undefined;
  return { data, legacyRouter, rootRouter, safeRoutes, v3Names, legacyNames };
};
