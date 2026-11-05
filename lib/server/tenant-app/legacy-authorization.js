'use strict';

const authentication = require('../../api3/tenant-authentication');
const pending = new WeakMap();

module.exports = function legacyAuthorization () {
  async function resolve (req) {
    if (!pending.has(req)) {
      if (typeof req.tenantAuthenticate !== 'function') throw new TypeError('Trusted tenant authentication is required');
      pending.set(req, Promise.resolve().then(() => req.tenantAuthenticate()));
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
        if (callback) callback(value);
        return value;
      });
    },
    isPermitted (permission) {
      return async (req, res, next) => {
        try {
          const bound = await resolve(req);
          if (permission === undefined || checkMultiple(permission, bound.shiros)) return next();
          res.status(401).json({ status: 401, message: 'Unauthorized', description: 'Invalid/Missing' });
        } catch (error) { next(error); }
      };
    }
  };
};
