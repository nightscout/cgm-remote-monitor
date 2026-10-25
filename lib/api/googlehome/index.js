'use strict';

function configure (app, wares, ctx) {
  var express = require('express')
    , api = express.Router( );
  var translate = ctx.language.translate;

  // invoke common middleware
  api.use(wares.sendJSONStatus);
  // text body types get handled as raw buffer stream
  api.use(wares.rawParser);
  // json body types get handled as parsed json
  api.use(wares.jsonParser);


  ctx.virtAsstBase.setupVirtAsstHandlers(ctx.googleHome);

  api.post('/googlehome', ctx.authorization.isPermitted('api:*:read'), function (req, res, next) {
    console.log('Incoming request from Google Home');
    // The locale belongs to this request, not to the server. `ctx.language` is
    // one instance shared by the whole process and `moment.locale()` is global
    // state inside the library, so setting either one here re-languages every
    // later request in the process until something sets it back. Neither can be
    // scoped to this request as things stand: `language.set` only records the
    // code, since translations are read once at boot and never reloaded, and
    // every virtual-assistant handler captures `ctx.moment` at plugin init, so a
    // per-request locale cannot reach the handlers without being threaded
    // through all of them. Until that exists, answer in the server's configured
    // language rather than leaving the caller's behind for everyone else.

    var handler = ctx.googleHome.getIntentHandler(req.body.queryResult.intent.displayName, req.body.queryResult.parameters.metric);
    if (handler){
      var sbx = ctx.sbx;
      handler(function (title, response) {
        res.json(ctx.googleHome.buildSpeechletResponse(response, false));
        next( );
        return;
      }, req.body.queryResult.parameters, sbx);
    } else {
      res.json(ctx.googleHome.buildSpeechletResponse(translate('virtAsstUnknownIntentText'), true));
      next( );
      return;
    }
  });

  ctx.virtAsstBase.setupMutualIntents(ctx.googleHome);

  return api;
}

module.exports = configure;
