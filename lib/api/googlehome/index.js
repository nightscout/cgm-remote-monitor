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
  api.use(wares.rawParser);
  // json body types get handled as parsed json
  api.use(wares.jsonParser);


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

    // build the final list of parameters
    var contexts = _.get(req, 'body.queryResult.outputContexts', []);
    contexts.forEach(function(c) {
      // check if this context has parameters
      if ("parameters" in c) {
        for (var param in c.parameters) {
          // add the param if it doesn't already exist (it's a stack, so later indexes are older versions of the param from the user)
          if (!(param in parameters)) {
            parameters[param] = c.parameters[param];
          }
        }
      }
    });

    handler = ctx.googleHome.getIntentHandler(action, parameters.metric);
    if (handler) {
      // check if we need create authorization
      if (handler.createAccess) {
        console.log('Intent handler requires create access');
        next();
        return;
      }

      var sbx = ctx.virtAsstBase.initSandbox(ctx.googleHome);
      handler(function (title, response) {
        res.json(ctx.googleHome.buildSpeechletResponse(response, false));
        res.end();
        return;
      }, parameters, sbx);

      // reset app state
      action = '';
      parameters = {};
      handler = null;
    } else {
      res.json(ctx.googleHome.buildSpeechletResponse(translate('virtAsstUnknownIntentText'), true));
      res.end();
      return;
    }
  }
  // we get here if the intent handler requires create access
  , ctx.authorization.isPermitted('api:*:write'), function (req, res) {
    var sbx = ctx.virtAsstBase.initSandbox(ctx.googleHome);
    handler(function (title, response) {
      res.json(ctx.googleHome.buildSpeechletResponse(response, false));
      res.end();
      return;
    }, parameters, sbx);

    // reset app state
    action = '';
    parameters = {};
    handler = null;
  });

  ctx.virtAsstBase.setupMutualIntents(ctx.googleHome);

  return api;
}

module.exports = configure;
