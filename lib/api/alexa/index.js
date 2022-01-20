'use strict';

var moment = require('moment');
var _each = require('lodash/each');

function configure (app, wares, ctx, env) {
  var entries = ctx.entries;
  var express = require('express')
    , api = express.Router( );
  var translate = ctx.language.translate;

  // invoke common middleware
  api.use(wares.sendJSONStatus);
  // text body types get handled as raw buffer stream
  api.use(wares.bodyParser.raw());
  // json body types get handled as parsed json
  api.use(wares.bodyParser.json());

  ctx.plugins.eachEnabledPlugin(function each(plugin){
    if (plugin.virtAsst) {
      if (plugin.virtAsst.intentHandlers) {
        console.log('Alexa: Plugin ' + plugin.name + ' supports Virtual Assistants');
        _each(plugin.virtAsst.intentHandlers, function (route) {
          if (route) {
            ctx.alexa.configureIntentHandler(route.intent, route.intentHandler, route.metrics);
          }
        });
      }
      if (plugin.virtAsst.rollupHandlers) {
        console.log('Alexa: Plugin ' + plugin.name + ' supports rollups for Virtual Assistants');
        _each(plugin.virtAsst.rollupHandlers, function (route) {
          console.log('Route');
          console.log(route);
          if (route) {
            ctx.alexa.addToRollup(route.rollupGroup, route.rollupHandler, route.rollupName);
          }
        });
      }
    } else {
      console.log('Alexa: Plugin ' + plugin.name + ' does not support Virtual Assistants');
    }
  });

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
      case 'IntentRequest':
        onIntent(req.body.request.intent, function (title, response) {
          res.json(ctx.alexa.buildSpeechletResponse(title, response, '', 'true'));
          next( );
        });
        break;
      case 'LaunchRequest':
        onLaunch(req.body.request.intent, function (title, response) {
          res.json(ctx.alexa.buildSpeechletResponse(title, response, '', 'true'));
          next( );
        });
        break;
      case 'SessionEndedRequest':
        onSessionEnded(req.body.request.intent, function (alexaResponse) {
          res.json(alexaResponse);
          next( );
        });
        break;
    }
  });

  ctx.alexa.addToRollup('Status', function bgRollupHandler(slots, sbx, callback) {
    entries.list({count: 1}, function (err, records) {
      var direction;
      if (translate(records[0].direction)) {
        direction = translate(records[0].direction);
      } else {
        direction = records[0].direction;
      }
      var status = translate('virtAsstStatus', {
        params: [
          sbx.scaleMgdl(records[0].sgv),
          direction,
          moment(records[0].date).from(moment(sbx.time))
        ]
      });
      
      callback(null, {results: status, priority: -1});
    });
  }, 'BG Status');

  ctx.alexa.configureIntentHandler('MetricNow', function (callback, slots, sbx, locale) {
    entries.list({count: 1}, function(err, records) {
      var direction;
      if(translate(records[0].direction)){
        direction = translate(records[0].direction);
      } else {
        direction = records[0].direction;
      }
      var status =  translate('virtAsstStatus', {
        params: [
          sbx.scaleMgdl(records[0].sgv),
          direction,
          moment(records[0].date).from(moment(sbx.time))]
      });
      
      callback(translate('virtAsstTitleCurrentBG'), status);
    });
  }, ['bg', 'blood glucose', 'number']);

  ctx.alexa.configureIntentHandler('NSStatus', function (callback, slots, sbx, locale) {
    ctx.alexa.getRollup('Status', sbx, slots, locale, function (status) {
      callback(translate('virtAsstTitleFullStatus'), status);
    });
  });


  function onLaunch(intent, next) {
    console.log('Session launched');
    console.log(JSON.stringify(intent));
    handleIntent(intent.name, intent.slots, next);
  }

  function onIntent(intent, next) {
    console.log('Received intent request');
    console.log(JSON.stringify(intent));
    handleIntent(intent.name, intent.slots, next);
  }

  function onSessionEnded() {
    console.log('Session ended');
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
      }
    }

    var handler = ctx.alexa.getIntentHandler(intentName, metric);
    if (handler){
      var sbx = initializeSandbox();
      handler(next, slots, sbx);
    } else {
      next(translate('virtAsstUnknownIntentTitle'), translate('virtAsstUnknownIntentText'));
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