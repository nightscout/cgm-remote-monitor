'use strict';

// The `api` role (D5, D21): API v3 served from bootevent's `api` profile,
// which builds env, storage, the history clock, authorization, alarm levels
// and the write sanitizer, and nothing else: no heartbeat bus, ddata, data
// loader, cache, plugins, notifications, websocket or v1/v2 modules.
//
// The app answers:
//   /api/v3/*                 API v3, unchanged (lib/api3)
//   /api/v2/authorization/*   the authorization endpoints, where API v3
//                             clients exchange an access token for a JWT
// Anything else is a 404. A boot that recorded errors answers 500 to every
// request, as `single`'s boot-error page does, with no detail in the body.

const compression = require('compression');
const application = require('../app');
const logPrivacy = require('../log-privacy');

function createApp (env, ctx) {
  const app = application.front(env);

  if (ctx.bootErrors && ctx.bootErrors.length > 0) {
    // `single` shows these on its boot-error page; this role has no page.
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
  app.use('/api/v3', api3);
  app.use(require('../error-handler')());
  return { app, api3 };
}

// Boot the api profile. Resolves with the context once every stage has run;
// boot errors are in ctx.bootErrors, as with `single`.
function boot (env, language) {
  return new Promise(resolve => {
    require('../bootevent')(env, language, { profile: 'api' }).boot(resolve);
  });
}

module.exports = { boot, createApp };
