'use strict';

var moment = require('moment');

function configure (app, wares, ctx, env) {
  var express = require('express')
    , api = express.Router( );
  var translate = ctx.language.translate;

  // invoke common middleware
  api.use(wares.sendJSONStatus);
  // text body types get handled as raw buffer stream
  api.use(wares.bodyParser.raw());
  // json body types get handled as parsed json
  api.use(wares.bodyParser.json());

  ctx.virtAsstBase.setupVirtAsstHandlers(ctx.googleHome);

  api.post('/googlehome', ctx.authorization.isPermitted('api:*:read'), function (req, res, next) {
    console.log('Incoming request from Google Home');
    var locale = req.body.queryResult.languageCode;
    if(locale){
      if(locale.length > 2) {
        locale = locale.substr(0, 2);
      }
      ctx.language.set(locale);
      moment.locale(locale);
    }

    var handler = ctx.googleHome.getIntentHandler(req.body.queryResult.intent.displayName, req.body.queryResult.parameters.metric);
    if (handler){
      var sbx = initializeSandbox();
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

  function initializeSandbox() {
    var sbx = require('../../sandbox')();
    sbx.serverInit(env, ctx);
    ctx.plugins.setProperties(sbx);
    return sbx;
  }

  return api;
}

module.exports = configure;
