'use strict';

const express = require('express');
const apiConst = require('../../api3/const.json');
const operations = Object.freeze({
  search: require('../../api3/generic/search/operation'),
  create: require('../../api3/generic/create/operation'),
  history: require('../../api3/generic/history/operation'),
  read: require('../../api3/generic/read/operation'),
  update: require('../../api3/generic/update/operation'),
  patch: require('../../api3/generic/patch/operation'),
  delete: require('../../api3/generic/delete/operation')
});

// Routes belong to the configured API, while storage and pruning state belong
// to the selected tenant. A concrete binding is captured before the first await;
// no shared mutable environment or ambient tenant switch is needed by handlers.
module.exports = function sharedV3Routes ({ names, resolve }) {
  const router = express.Router();
  const defaults = express();
  defaults.disable('x-powered-by');
  defaults.disable('etag');
  defaults.set('trust proxy', false);
  for (const [name, value] of Object.entries(apiConst)) if (name.startsWith('API3_')) defaults.set(name, value);
  function settings () {
    const values = { ...defaults.settings };
    return {
      settings: values,
      get: name => values[name],
      set (name, value) { values[name] = value; return this; },
      setENVTruthy (name, value) { values[name] = value; return value; }
    };
  }
  for (const logical of names) {
    const binding = (req, res) => {
      const selected = resolve(req, logical);
      if (!selected || !selected.col) throw new TypeError('Shared v3 route requires a selected collection');
      return { ...selected, req, res };
    };
    const handler = name => {
      const execute = operations[name](undefined, undefined, undefined, undefined, binding);
      return (req, res, next) => execute(req, res).catch(next);
    };
    const prefix = '/' + logical;
    router.get(prefix, handler('search'));
    router.post(prefix, handler('create'));
    router.get(prefix + '/history', handler('history'));
    router.get(prefix + '/history/:lastModified', handler('history'));
    router.get(prefix + '/:identifier', handler('read'));
    router.put(prefix + '/:identifier', handler('update'));
    router.patch(prefix + '/:identifier', handler('patch'));
    router.delete(prefix + '/:identifier', handler('delete'));
  }
  return { router, settings };
};
