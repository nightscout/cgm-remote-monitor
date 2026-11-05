'use strict';

const { EventEmitter } = require('node:events');
const createData = require('../../data/ddata');
const createLoader = require('../../data/dataloader');
const createCache = require('../cache');
const scope = require('../../storage/tenant-scope');
const environment = require('./environment');

const METHODS = {
  entries: 'list', treatments: 'list', devicestatus: 'list', activity: 'list',
  profile: 'last', food: 'list'
};

module.exports = function snapshot ({ tenant, ports, env, language } = {}) {
  if (typeof tenant !== 'string' || !environment.isSafe(env) || !language) {
    throw new TypeError('Snapshot requires an explicit tenant environment and language');
  }
  for (const [logical, method] of Object.entries(METHODS)) {
    if (!ports || !ports[logical] || ports[logical].tenant !== tenant ||
        typeof ports[logical].store?.[method] !== 'function') {
      throw new TypeError('Snapshot requires a tenant-bound ' + logical + ' port');
    }
  }
  if (!ports.stats || ports.stats.tenant !== tenant || typeof ports.stats.read !== 'function') {
    throw new TypeError('Snapshot requires tenant-local statistics');
  }
  return Object.freeze({
    tenant,
    async load ({ at = Date.now() } = {}) {
      const current = scope.currentTenant();
      if (current && current !== tenant) throw new Error('Snapshot tenant scope mismatch');
      return scope.withTenant(tenant, () => new Promise((resolve, reject) => {
        const errors = [];
        const ctx = { settings: env.settings, language, bus: new EventEmitter(), ddata: createData() };
        for (const [logical, method] of Object.entries(METHODS)) {
          ctx[logical] = {
            [method] (...args) {
              const callback = args.pop();
              try {
                ports[logical].store[method](...args, (error, docs) => {
                  if (error) errors.push(error);
                  if (!error && ['entries', 'treatments', 'devicestatus'].includes(logical) &&
                      Object.keys(args[0]?.find || {}).length === 1) {
                    ctx.cache.insertDataRef(logical, ctx.ddata.processRawDataForRuntime(docs));
                  }
                  callback(error, docs);
                });
              } catch (error) {
                errors.push(error);
                callback(error);
              }
            }
          };
        }
        ctx.store = { db: { async stats () {
          try {
            const result = await ports.stats.read();
            return { dataSize: result.dataSize, indexSize: result.indexSize };
          } catch (error) {
            errors.push(error);
            throw error;
          }
        } } };
        ctx.cache = createCache(env, ctx);
        const ddata = createData();
        createLoader(env, ctx).update(ddata, { lastUpdated: at, frame: true }, error => {
          // The shipping loader logs and continues after individual failures.
          // A tenant endpoint must not label a partial snapshot a success.
          if (error || errors.length) return reject(error || errors[0]);
          resolve(Object.freeze({ tenant, ddata, cache: ctx.cache, bus: ctx.bus }));
        });
      }));
    }
  });
};
