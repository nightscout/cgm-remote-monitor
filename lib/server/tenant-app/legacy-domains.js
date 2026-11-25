'use strict';

const authorization = require('./legacy-authorization');
const createV1 = require('../../api');
const createV2 = require('../../api2');
const wrappers = Object.freeze({
  entries: require('../entries'),
  treatments: require('../treatments'),
  devicestatus: require('../devicestatus'),
  activity: require('../activity'),
  profile: require('../profile'),
  food: require('../food')
});

module.exports = function legacyDomains ({ env, ctx, domains }) {
  if (!Array.isArray(domains) || !domains.length || domains.some(name => !Object.hasOwn(wrappers, name)) ||
      !ctx || !ctx.storagePorts || !ctx.bus || !ctx.ddata || !ctx.cache) {
    throw new TypeError('Legacy tenant domains require explicit storage ports and a tenant-local runtime frame');
  }
  // Preserve the selected composition's request-local accessors; copying their
  // values would retain the warm context in a shared immutable route tree.
  const local = Object.defineProperties({}, Object.getOwnPropertyDescriptors(ctx));
  local.authorization = authorization();
  let wares;
  Object.defineProperty(local, 'wares', { enumerable: true, get: () => wares || (wares = require('../../middleware')(env)) });
  for (const logical of domains) local[logical] = logical === 'profile'
    ? wrappers.profile(env.profile_collection, local, env) : wrappers[logical](env, local);
  // Snapshot ports need their wrappers during warmup, but neither HTTP tree.
  // Materialize only the selected version; all mutable request fields still use
  // the caller's tenant-local context/accessors.
  let v1, v2;
  const version1 = () => v1 || (v1 = createV1(env, local, { domains, apiEnabled: true }));
  const version2 = () => v2 || (v2 = createV2(env, local, version1(), { compatibilityOnly: true }));
  const router = (req, res, next) => (req.baseUrl === '/api/v2' ? version2() : version1())(req, res, next);
  return Object.defineProperties(router, {
    v1: { enumerable: true, get: version1 }, v2: { enumerable: true, get: version2 },
    context: { enumerable: true, value: local }
  });
};
