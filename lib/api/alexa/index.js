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

  ctx.virtAsstBase.setupVirtAsstHandlers(ctx.alexa);

  api.post('/alexa', ctx.authorization.isPermitted('api:*:read'), function (req, res, next) {
    console.log('Incoming request from Alexa');
    var locale = req.body.request.locale;
    if(locale){
      if(locale.length > 2) {
        locale = locale.substr(0, 2);
      }
      ctx.language.set(locale);
      moment.locale(locale);
    }

    switch (req.body.request.type) {
      case 'SessionEndedRequest':
        onSessionEnded(function () {
          res.json('');
          next( );
        });
        break;
      case 'LaunchRequest':
        if (!req.body.request.intent) {
          onLaunch(function () {
            res.json(ctx.alexa.buildSpeechletResponse(
                translate('virtAsstTitleLaunch'),
                translate('virtAsstLaunch'),
                translate('virtAsstLaunch'),
                false
            ));
            next( );
          });
          break;
        }
        // if intent is set then fallback to IntentRequest
      case 'IntentRequest': // eslint-disable-line no-fallthrough
        onIntent(req.body.request.intent, function (title, response) {
          res.json(ctx.alexa.buildSpeechletResponse(title, response, '', true));
          next( );
        });
        break;
    }
  });

  ctx.virtAsstBase.setupMutualIntents(ctx.alexa);

  function onLaunch(next) {
    console.log('Session launched');
    next( );
  }

  function onIntent(intent, next) {
    console.log('Received intent request');
    console.log(JSON.stringify(intent));
    handleIntent(intent.name, intent.slots, next);
  }

  function onSessionEnded(next) {
    console.log('Session ended');
    next( );
  }

  function handleIntent(intentName, slots, next) {
    var metric;
    if (slots) {
      if (slots.metric
        && slots.metric.resolutions
        && slots.metric.resolutions.resolutionsPerAuthority
        && slots.metric.resolutions.resolutionsPerAuthority.length
        && slots.metric.resolutions.resolutionsPerAuthority[0].status
        && slots.metric.resolutions.resolutionsPerAuthority[0].status.code
        && slots.metric.resolutions.resolutionsPerAuthority[0].status.code == "ER_SUCCESS_MATCH"
        && slots.metric.resolutions.resolutionsPerAuthority[0].values
        && slots.metric.resolutions.resolutionsPerAuthority[0].values.length
        && slots.metric.resolutions.resolutionsPerAuthority[0].values[0].value
        && slots.metric.resolutions.resolutionsPerAuthority[0].values[0].value.name
      ){
        metric = slots.metric.resolutions.resolutionsPerAuthority[0].values[0].value.name;
      } else {
        next(translate('virtAsstUnknownIntentTitle'), translate('virtAsstUnknownIntentText'));
        return;
      }
    }

    var handler = ctx.alexa.getIntentHandler(intentName, metric);
    if (handler){
      var sbx = initializeSandbox();
      handler(next, slots, sbx);
      return;
    } else {
      next(translate('virtAsstUnknownIntentTitle'), translate('virtAsstUnknownIntentText'));
      return;
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
