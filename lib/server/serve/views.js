'use strict';

// The views profile's app (research prototype, proto/views-nonresident): one
// tenant, nonresident. API v3 and the authorization endpoints as the api role
// serves them (./api.js), and GET /api/v2/properties from the evaluator's
// last cycle, on bootevent's `views` profile, which adds the
// heartbeat bus, the v1 storage modules, durable notifications and the
// evaluator (lib/server/nonresident.js). Not a role of `nightscout serve`:
// scripts/views-profile-server.js starts it, single-tenant.

const compression = require('compression');
const application = require('../app');
const logPrivacy = require('../log-privacy');

function createApp (env, ctx) {
  const app = application.front(env);

  if (ctx.bootErrors && ctx.bootErrors.length > 0) {
    ctx.bootErrors.forEach(function logBootError (failure) {
      const err = failure.err;
      const detail = typeof err === 'string' ? err
        : err instanceof Error ? logPrivacy.errorForLog(err).message : '';
      console.error('Boot error:', failure.desc, detail);
    });
    app.use(function bootErrors (req, res) {
      res.status(500).json({ status: 500, message: 'Nightscout did not finish starting; the server log says why' });
    });
    return { app };
  }

  application.cors(app, env);
  const api3 = require('../../api3')(env, ctx);
  app.use(compression());
  app.use('/api/v2/authorization', ctx.authorization.endpoints);
  // single's route (lib/api2/properties.js) reads ctx.sbx; here it is given
  // a sandbox holding the properties the evaluator kept from its last cycle
  // (lib/server/nonresident.js), after the route's own permission checks.
  const createProperties = require('../../api2/properties');
  app.use('/api/v2/properties'
    , ctx.authorization.isPermitted('api:entries:read')
    , ctx.authorization.isPermitted('api:treatments:read')
    , function propertiesView (req, res, next) {
      ctx.evaluator.properties(function computed (err, properties) {
        if (err) return next(err);
        const rctx = Object.create(ctx);
        rctx.sbx = properties ? { properties } : undefined;
        createProperties(env, rctx)(req, res, next);
      });
    });
  app.use('/api/v3', api3);
  app.use(require('../error-handler')());
  return { app, api3 };
}

// Boot the views profile. `evaluator` is passed to lib/server/nonresident.js
// (tests and the replay lab drive its scheduler).
function boot (env, language, evaluator) {
  return new Promise(resolve => {
    require('../bootevent')(env, language, { profile: 'views', evaluator }).boot(resolve);
  });
}

// Close what boot opened: the heartbeat timer, the evaluator, the MongoDB client.
async function stop (ctx) {
  if (ctx.bus && typeof ctx.bus.teardown === 'function') ctx.bus.teardown();
  if (ctx.store && ctx.store.client) await ctx.store.client.close();
}

module.exports = { boot, createApp, stop };
