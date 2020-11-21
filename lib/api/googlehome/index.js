'use strict';

var _ = require('lodash');
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

  var action = ''
    , parameters = {}
    , handler = null;
  api.post('/googlehome', ctx.authorization.isPermitted('api:*:read'), function (req, res, next) {
    console.log('Incoming request from Google Home');
    var locale = _.get(req, 'body.queryResult.languageCode');
    if(locale){
      if(locale.length > 2) {
        locale = locale.substr(0, 2);
      }
      ctx.language.set(locale);
      moment.locale(locale);
    }

    action = _.get(req, 'body.queryResult.action', '').split('.')[0]; // multi-step interactions; we want just the first one
    action = action ? action : _.get(req, 'body.queryResult.intent.displayName'); // single-step interactions
    parameters = _.get(req, 'body.queryResult.outputContexts[0].parameters');
    handler = ctx.googleHome.getIntentHandler(action, parameters.metric);
    if (handler) {
      // check if we need create authorization
      if (handler.createAccess) {
        console.log('Intent handler requires create access');
        next();
        return;
      }

      var sbx = initializeSandbox();
      handler(function (title, response) {
        res.json(ctx.googleHome.buildSpeechletResponse(response, false));
        res.end();
        return;
      }, parameters, sbx);
    } else {
      res.json(ctx.googleHome.buildSpeechletResponse(translate('virtAsstUnknownIntentText'), true));
      res.end();
      return;
    }
  }
  // we get here if the intent handler requires create access
  , ctx.authorization.isPermitted('api:*:create'), function (req, res, next) {
    var sbx = initializeSandbox();
    handler(function (title, response) {
      res.json(ctx.googleHome.buildSpeechletResponse(response, false));
      res.end();
      return;
    }, parameters, sbx);
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
