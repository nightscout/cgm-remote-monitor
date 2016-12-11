'use strict';

var _ = require('lodash');

function configure (app, wares, ctx, env) {
    var express = require('express');
    var api = express.Router();

    // invoke common middleware
    api.use(wares.sendJSONStatus);
    // text body types get handled as raw buffer stream
    api.use(wares.bodyParser.raw());
    // json body types get handled as parsed json
    api.use(wares.bodyParser.json());

    ctx.plugins.eachEnabledPlugin(function each(plugin) {
      if (plugin.googleHome) {
        if (plugin.googleHome.intentHandlers) {
          console.log(plugin.name + ' is Google Home enabled');
          _.each(plugin.googleHome.intentHandlers, function (handler) {
            if (handler) {
              ctx.googleHome.configureIntentHandler(handler);
            }
          });
        }
      } else {
        console.log('Plugin ' + plugin.name + ' is not Google Home enabled');
      }
    });

    api.post('/googlehome', ctx.authorization.isPermitted('api:*:read'), function (req, res, next) {
      console.log('Incoming request from Google Home');
      onIntent(req.body, function (response) {
        res.json(ctx.googleHome.buildResponse(response));
        next();
      });
    });

    function onIntent(body, next) {
      console.log('Received intent request');
      console.log(JSON.stringify(body));
      handleIntent(body, next);
    }

    // https://docs.api.ai/docs/webhook#section-format-of-request-to-the-service
    function handleIntent(body, next) {
      var intentName = body.result.metadata.intentName;
        var handler = ctx.googleHome.getIntentHandler(intentName);
        if (handler) {
          var sbx = initializeSandbox();
          handler(body.result, next, sbx);
        } else if (intentName === 'current_bg' || intentName === 'current_bg_given_name') {
          var sbx = initializeSandbox();
          ctx.googleHome.currentBGHandler(body.result, next, sbx);
        } else {
          next('Unknown Intent', 'I\'m sorry I don\'t know what you\'re asking for');
        }
    }

    function initializeSandbox() {
      var sbx = require('../../sandbox')();
      sbx.serverInit(env, ctx);
      ctx.plugins.setProperties(sbx);
      return sbx;
    }

    return api;
}

module.exports = configure;