'use strict';

const express = require('express');
const { EventEmitter } = require('node:events');
const scope = require('../../storage/tenant-scope');
const catalogue = require('../tenant-app/domain-catalogue');
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
const application = require('../../../package.json');
const UNAVAILABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', '57P01', '57P02', '57P03', '53300', '42501']);

function snapshotFailure (error) {
  const failure = new Error('Tenant snapshot failed', { cause: error });
  failure.code = 'TENANT_SNAPSHOT_INTERNAL';
  const seen = new Set();
  for (let cause = error; cause && !seen.has(cause); cause = cause.cause) {
    seen.add(cause);
    if (UNAVAILABLE.has(cause.code) || (typeof cause.code === 'string' && /^08[0-9A-Z]{3}$/.test(cause.code))) {
      failure.code = 'TENANT_SNAPSHOT_UNAVAILABLE';
      break;
    }
  }
  return failure;
}

module.exports = async function previewDomains ({ config, connection, exchange }) {
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
      if (domain.v3) ports.set(logical + ':v3', domain.factory({
        connection, table: config.namespaces[logical] + '.' + logical, bus, env, source: 'v3'
      }));
      if (config.legacyEnabled && domain.legacy) ports.set(logical + ':v1/internal', domain.factory({
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
    let frameService;
    if (config.legacyEnabled) {
      const ctx = { bus, storagePorts, purifier: purifier({}, {}), ddata: createData() };
      ctx.cache = createCache(env, ctx);
      const graph = createLegacy({ env, ctx, domains: legacyNames });
      const snapshotPorts = Object.fromEntries(legacyNames.map(logical => [logical,
        { tenant, store: graph.context[logical] }]));
      snapshotPorts.stats = { tenant, async read () {
        let dataSize = 0;
        for (const logical of config.domains) {
          const result = await connection.query('SELECT COALESCE(sum(pg_column_size(doc)), 0)::float8 AS bytes FROM "' +
            config.namespaces[logical] + '"."' + logical + '"');
          dataSize += result.rows[0].bytes;
        }
        // Shared physical BTree pages cannot be attributed to one tenant.
        return { dataSize, indexSize: undefined };
      } };
      frameService = snapshot({ tenant, ports: snapshotPorts, env, language });
    }
    const context = config.contextEnabled ? restContext({
      env, authorization: authorization(), collections,
      versionInfo: { name: application.name, version: application.version,
        storage: { storage: 'PostgreSQL', version: storageVersion } },
      admitted: { 1: legacyNames, 2: legacyNames, 3: v3Names },
      statusAuthorization: statusAuthorization({ tenant, exchange })
    }) : null;
    if (context) routes.use(context.v3);
    services.set(tenant, { env, storagePorts, frameService, context });
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
      const metadata = (safeRoutes[req.baseUrl === '/api/v2' ? 2 : 1] || [])
        .includes(req.path.replace(/\.[a-z]+$/i, '').replace(/\/$/, ''));
      function contextRoutes (error) {
        if (error) return next(error);
        if (!service.context) return next();
        return service.context.legacy(req, res, error => {
          if (error) return next(error);
          return req.baseUrl === '/api/v2' ? service.context.v2(req, res, next) : next();
        });
      }
      if (!config.legacyEnabled) {
        const common = require('../../api')(service.env, {
          wares: require('../../middleware')(service.env)
        }, { domains: [], apiEnabled: true });
        return common(req, res, contextRoutes);
      }
      const bus = new EventEmitter();
      const ctx = { bus, storagePorts: service.storagePorts, purifier: purifier({}, {}), ddata: createData() };
      ctx.cache = createCache(service.env, ctx);
      const graph = createLegacy({ env: service.env, ctx, domains: legacyNames });
      if (!metadata) Object.defineProperty(req, 'prepareTenantFrame', { value: async () => {
        try {
          const frame = await service.frameService.load();
          graph.context.ddata = frame.ddata;
          graph.context.cache = frame.cache;
          graph.context.bus = frame.bus;
        } catch (error) { throw snapshotFailure(error); }
      } });
      return graph(req, res, contextRoutes);
    } catch (error) { next(error); }
  } : undefined;
  const rootRouter = config.contextEnabled ? (req, res, next) =>
    services.get(req.tenantContext.tenant).context.root(req, res, next) : undefined;
  return { data, legacyRouter, rootRouter, safeRoutes, v3Names, legacyNames };
};
