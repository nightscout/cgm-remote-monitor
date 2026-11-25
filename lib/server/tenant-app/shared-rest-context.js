'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const express = require('express');
const shiro = require('shiro-trie');
const authentication = require('../../api3/tenant-authentication');
const security = require('../../api3/security');
const api = require('../../api/const.json');
const api3 = require('../../api3/const.json');
const environment = require('./environment');
const tenantScope = require('../../storage/tenant-scope');
const authorization = require('./legacy-authorization');

// One metadata route graph per API composition. Shipping handlers retain their
// closure interfaces; only the selected environment and collection catalogue
// vary by request. No actor, response, frame or authorization result is retained.
module.exports = function sharedRestContext ({ versionInfo, admitted, servingState } = {}) {
  if (!versionInfo || !admitted ||
      !['name', 'version'].every(key => typeof versionInfo[key] === 'string') ||
      !['storage', 'version'].every(key => typeof versionInfo.storage?.[key] === 'string') ||
      (servingState !== undefined && typeof servingState?.read !== 'function')) {
    throw new TypeError('Shared REST context requires explicit version and admitted capabilities');
  }
  const selected = new AsyncLocalStorage();
  function current () {
    const value = selected.getStore();
    if (!value) throw new Error('REST metadata context is not bound');
    return value;
  }
  const env = new Proxy({}, { get: (_, name) => current().env[name] });
  const permission = authorization();
  const ctx = { authorization: {
    isPermitted: permission.isPermitted,
    resolveWithRequest (req, callback) {
      const bound = authentication.get(req);
      callback(bound ? null : new Error('Unbound tenant request'), bound || {});
    },
    checkMultiple: (value, shiros) => security.checkPermission({ shiros }, value)
  } };
  if (servingState !== undefined) Object.defineProperty(ctx, 'runtimeState', { get: () => servingState.read() });
  const wares = require('../../middleware')(env);
  const app = {
    get: name => name === 'collections' ? current().collections : versionInfo[name],
    enabled: name => name === 'api',
    get extendedClientSettings () { return current().env.extendedSettings; }
  };
  const legacy = express.Router(), parsers = express.Router();
  const parser = middleware => (req, res, next) => {
    const value = current();
    return middleware(req, res, (...args) => selected.run(value, () => next(...args)));
  };
  // Incoming stream events can originate outside this ALS run. Rebind the
  // parser continuation before Express advances to tenant-aware handlers.
  parsers.use(parser(wares.rawParser), parser(wares.jsonParser), parser(wares.urlencodedParser));
  legacy.use(wares.sendJSONStatus);
  legacy.use((req, res, next) => {
    const name = req.path.split('/')[1].split('.')[0].toLowerCase();
    return ['status', 'verifyauth'].includes(name) ? parsers(req, res, next) : next();
  });
  legacy.use(wares.extensions(['json', 'svg', 'csv', 'txt', 'png', 'html', 'tsv']));
  // clientIPFor is compiled while constructing status. This branch always
  // supplies authorizeStatus, so the compiled fallback is never consulted.
  selected.run({ env: environment() }, () => legacy.use(require('../../api/status')(app, wares, env, ctx, {
    authorizeStatus: req => current().statusAuthorization(req)
  })));
  legacy.get('/verifyauth', permission.isPermitted(), require('../../api/verifyauth')(ctx));

  function catalogue () {
    return Object.keys(current().collections).flatMap(name =>
      ['create', 'read', 'update', 'delete', 'admin'].map(action => 'api:' + name + ':' + action))
      .concat(['api:status:read', 'admin:api:permissions:read']);
  }
  const v2 = express.Router();
  v2.get('/authorization/permissions', permission.isPermitted('admin:api:permissions:read'),
    (req, res) => res.json(catalogue()));
  v2.get('/authorization/permissions/trie', permission.isPermitted('admin:api:permissions:read'), (req, res) => {
    const trie = shiro.new(); trie.add(catalogue()); res.json(trie);
  });
  const info = () => ({ version: versionInfo.version, apiVersion: api3.API3_VERSION, srvDate: Date.now(),
    storage: { storage: versionInfo.storage.storage, version: versionInfo.storage.version } });
  const v3 = express.Router();
  v3.use(require('../../api3/shared/renderer').extension2accept);
  v3.use(require('../../api3/specific/version')(app, { versionInfo: info }));
  v3.use(require('../../api3/specific/status')(app, ctx, env, { versionInfo: info }));
  v3.use(require('../../api3/specific/lastModified')(app, ctx, env));
  v3.use('/swagger-ui-dist', (req, res) => res.redirect(307, '../../../api3-docs'));
  const root = express.Router();
  root.get('/versions', (req, res) => {
    const bound = authentication.get(req), versions = { 1: api.API1_VERSION, 2: api.API2_VERSION, 3: api3.API3_VERSION };
    res.json(Object.entries(admitted).map(([version, names]) => ({ version: versions[version], url: '/api/v' + version,
      collections: names.filter(name => security.checkPermission(bound, 'api:' + name + ':read')) })));
  });
  // This compatibility app owns only common extension/count middleware. Domain
  // and status routes remain in their shared graphs above. Construction reads
  // fixed display defaults; all request-time count policy reads select env.
  const common = selected.run({ env: environment() }, () =>
    require('../../api')(env, { wares }, { domains: [], apiEnabled: true }));
  const routes = { legacy, v2, v3, root, common };
  return {
    forContext ({ tenant, env: localEnv, collections, statusAuthorization = async () => null } = {}) {
      if (typeof tenant !== 'string' || !tenant || !environment.isSafe(localEnv) ||
          !collections || typeof statusAuthorization !== 'function') {
        throw new TypeError('REST metadata requires explicit safe tenant context');
      }
      const value = { env: localEnv, collections, statusAuthorization };
      return Object.fromEntries(Object.entries(routes).map(([name, router]) => [name, (req, res, next) => {
        if ((req.tenantContext?.tenant || tenantScope.currentTenant()) !== tenant) {
          return next(new Error('REST metadata tenant binding mismatch'));
        }
        return selected.run(value, () => router(req, res, next));
      }]));
    }
  };
};
