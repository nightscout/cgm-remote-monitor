'use strict';

const acquisition = require('../../data/private-acquisition');
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
    async loadRaw (logical, { at = Date.now() } = {}) {
      if (!['entries', 'treatments', 'devicestatus'].includes(logical) ||
          typeof at !== 'number' || !Number.isFinite(at) ||
          !Number.isFinite(new Date(at).getTime()) || !Number.isFinite(new Date(at - 3 * 86400000).getTime())) {
        throw new TypeError('Raw acquisition requires a supported domain and loadable instant');
      }
      const current = scope.currentTenant();
      if (current && current !== tenant) throw new Error('Snapshot tenant scope mismatch');
      return scope.withTenant(tenant, () => new Promise((resolve, reject) => {
        const ctx = acquisition.createContext({ settings: env.settings, language });
        let failure;
        ctx[logical] = { list (query, callback) {
          try {
            ports[logical].store.list(query, (error, docs) => {
              if (!error && !Array.isArray(docs)) error = new TypeError('Raw port did not return documents');
              if (error) failure = error;
              try {
                if (!error) ctx.cache.insertDataRef(logical, ctx.ddata.processRawDataForRuntime(docs));
                callback(error, docs);
              } catch (error) { reject(error); }
            });
          } catch (error) { failure = error; callback(error); }
        } };
        acquisition.loadRaw(env, ctx, logical, at, (error, ddata) => {
          if (error || failure) return reject(error || failure);
          resolve(Object.freeze({ tenant, ddata, cache: ctx.cache, bus: ctx.bus }));
        });
      }));
    },
    async load ({ at = Date.now() } = {}) {
      if (typeof at !== 'number' || !Number.isFinite(at)) throw new TypeError('Snapshot requires an instant in milliseconds');
      const current = scope.currentTenant();
      if (current && current !== tenant) throw new Error('Snapshot tenant scope mismatch');
      return scope.withTenant(tenant, () => new Promise((resolve, reject) => {
        const errors = [];
        const ctx = acquisition.createContext({ settings: env.settings, language });
        for (const [logical, method] of Object.entries(METHODS)) {
          ctx[logical] = {
            [method] (...args) {
              const callback = args.pop();
              try {
                ports[logical].store[method](...args, (error, docs) => {
                  if (!error && !Array.isArray(docs)) error = new TypeError('Snapshot port did not return documents: ' + logical);
                  if (error) errors.push(error);
                  if (!error && ['entries', 'treatments', 'devicestatus'].includes(logical) &&
                      Object.keys(args[0]?.find || {}).length === 1) {
                    ctx.cache.insertDataRef(logical, ctx.ddata.processRawDataForRuntime(docs));
                  }
                  try { callback(error, docs); } catch (failure) { reject(failure); }
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
        acquisition.load(env, ctx, { lastUpdated: at, frame: true }, (error, ddata) => {
          // The shipping loader logs and continues after individual failures.
          // A tenant endpoint must not label a partial snapshot a success.
          if (error || errors.length) return reject(error || errors[0]);
          resolve(Object.freeze({ tenant, ddata, cache: ctx.cache, bus: ctx.bus }));
        });
      }));
    }
  });
};
