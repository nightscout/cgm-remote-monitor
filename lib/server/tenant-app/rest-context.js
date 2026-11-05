'use strict';

const express = require('express');
const shiro = require('shiro-trie');
const authentication = require('../../api3/tenant-authentication');
const security = require('../../api3/security');
const api = require('../../api/const.json');
const api3 = require('../../api3/const.json');
const environment = require('./environment');

module.exports = function restContext ({
  env, authorization, collections, versionInfo, admitted, statusAuthorization = async () => null
} = {}) {
  if (!environment.isSafe(env) || typeof authorization?.isPermitted !== 'function' ||
      !collections || !versionInfo || !admitted || typeof statusAuthorization !== 'function' ||
      !['name', 'version'].every(key => typeof versionInfo[key] === 'string') ||
      !['storage', 'version'].every(key => typeof versionInfo.storage?.[key] === 'string')) {
    throw new TypeError('REST context requires explicit tenant environment, authorization and admitted capabilities');
  }
  const app = express();
  app.set('name', versionInfo.name);
  app.set('version', versionInfo.version);
  app.enable('api');
  app.extendedClientSettings = env.extendedSettings;
  const auth = {
    isPermitted: authorization.isPermitted,
    resolveWithRequest (req, callback) {
      const bound = authentication.get(req);
      callback(bound ? null : new Error('Unbound tenant request'), bound || {});
    },
    checkMultiple (permission, shiros) {
      return security.checkPermission({ shiros }, permission);
    }
  };
  const ctx = { authorization: auth };
  const wares = require('../../middleware')(env);
  const legacy = express.Router();
  legacy.use(wares.sendJSONStatus);
  const parsers = express.Router();
  parsers.use(wares.rawParser, wares.jsonParser, wares.urlencodedParser);
  legacy.use((req, res, next) => {
    const name = req.path.split('/')[1].split('.')[0].toLowerCase();
    return ['status', 'verifyauth'].includes(name) ? parsers(req, res, next) : next();
  });
  legacy.use(wares.extensions(['json', 'svg', 'csv', 'txt', 'png', 'html', 'tsv']));
  legacy.use(require('../../api/status')(app, wares, env, ctx, { authorizeStatus: statusAuthorization }));
  // Unlike status, the shipping probe returns HTTP200 for a denied permission.
  // Authentication still runs first, so an invalid credential cannot be a
  // successful anonymous tenant probe.
  legacy.get('/verifyauth', authorization.isPermitted(), require('../../api/verifyauth')(ctx));

  const catalogue = Object.keys(collections).flatMap(name =>
    ['create', 'read', 'update', 'delete', 'admin'].map(action => 'api:' + name + ':' + action));
  catalogue.push('api:status:read', 'admin:api:permissions:read');
  const v2 = express.Router();
  v2.get('/authorization/permissions', authorization.isPermitted('admin:api:permissions:read'),
    (req, res) => res.json(catalogue));
  v2.get('/authorization/permissions/trie', authorization.isPermitted('admin:api:permissions:read'),
    (req, res) => {
      const trie = shiro.new();
      trie.add(catalogue);
      res.json(trie);
    });

  const v3 = express.Router();
  const v3App = express();
  v3App.set('collections', collections);
  function info () {
    return {
      version: versionInfo.version, apiVersion: api3.API3_VERSION, srvDate: Date.now(),
      storage: { storage: versionInfo.storage.storage, version: versionInfo.storage.version }
    };
  }
  v3.use(require('../../api3/shared/renderer').extension2accept);
  v3.use(require('../../api3/specific/version')(v3App, { versionInfo: info }));
  v3.use(require('../../api3/specific/status')(v3App, ctx, env, { versionInfo: info }));
  v3.use(require('../../api3/specific/lastModified')(v3App, ctx, env));
  v3.use('/swagger-ui-dist', (req, res) => res.redirect(307, '../../../api3-docs'));

  const root = express.Router();
  root.get('/versions', (req, res) => {
    const bound = authentication.get(req);
    const versions = { 1: api.API1_VERSION, 2: api.API2_VERSION, 3: api3.API3_VERSION };
    res.json(Object.entries(admitted).map(([version, names]) => ({
      version: versions[version], url: '/api/v' + version,
      collections: names.filter(name => security.checkPermission(bound, 'api:' + name + ':read'))
    })));
  });
  return { legacy, v2, v3, root };
};
