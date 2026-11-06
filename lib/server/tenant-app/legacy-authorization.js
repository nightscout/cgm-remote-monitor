'use strict';

const authentication = require('../../api3/tenant-authentication');
const unauthorized = require('./legacy-refusal');
const pending = new WeakMap();

module.exports = function legacyAuthorization () {
  async function resolve (req) {
    if (!pending.has(req)) {
      if (typeof req.tenantAuthenticate !== 'function') throw new TypeError('Trusted tenant authentication is required');
      pending.set(req, Promise.resolve().then(async () => {
        await req.tenantAuthenticate();
        if (typeof req.prepareTenantFrame === 'function') await req.prepareTenantFrame();
      }));
    }
    await pending.get(req);
    const bound = authentication.get(req);
    if (!bound) throw new Error('Tenant authorization was not bound');
    return bound;
  }
  const checkMultiple = (permission, shiros) => shiros.some(shiro => shiro.check(permission));
  return {
    checkMultiple,
    resolveWithRequest (req, callback) {
      return resolve(req).then(value => {
        if (callback) callback(null, value);
        return value;
      }, error => {
        if (callback) return callback(error);
        throw error;
      });
    },
    isPermitted (permission) {
      return async (req, res, next) => {
        try {
          const bound = await resolve(req);
          if (permission === undefined || checkMultiple(permission, bound.shiros)) return next();
          unauthorized(res);
        } catch (error) { next(error); }
      };
    }
  };
};
