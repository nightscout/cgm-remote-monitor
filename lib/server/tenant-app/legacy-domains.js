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
  const local = { ...ctx, authorization: authorization(), wares: require('../../middleware')(env) };
  for (const logical of domains) local[logical] = logical === 'profile'
    ? wrappers.profile(env.profile_collection, local, env) : wrappers[logical](env, local);
  const v1 = createV1(env, local, { domains, apiEnabled: true });
  const v2 = createV2(env, local, v1, { compatibilityOnly: true });
  const router = (req, res, next) => (req.baseUrl === '/api/v2' ? v2 : v1)(req, res, next);
  return Object.assign(router, { v1, v2, context: local });
};
