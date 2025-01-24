'use strict';

var _ = require('lodash');
var moment = require('moment');
var fs = require('fs');

function configure (app, wares, ctx, env) {
  var express = require('express')
    , api = express.Router( );
  

  // invoke common middleware
  api.use(wares.sendJSONStatus);
  // text body types get handled as raw buffer stream
  api.use(wares.rawParser);
  // json body types get handled as parsed json
  api.use(wares.jsonParser);

  ctx.virtAsstBase.setupVirtAsstHandlers(ctx.alice);

  api.post('/alice', ctx.authorization.isPermitted('api:*:read'), function (req, res, next) {

    // locale, language and translate settings
    var locale = _.get(req, 'body.meta.locale');
    if(locale){
        if(locale.length > 2) {
            locale = locale.substr(0, 2);
        }
        ctx.language.set(locale);
        ctx.language.loadLocalization(fs);
        moment.locale(locale);
    } else {
        console.log('Unknown locale');
    }
    var translate = ctx.language.translate;

    console.log('Incoming request from alice');

    if(req.body.request.nlu.intents.alice != undefined) {
        var intent = req.body.request.nlu.intents.alice;
        var intentName, metricName;
        if(intent.slots.metricnow != undefined) {
            intentName = "MetricNow";
            metricName = _.get(req, 'body.request.nlu.intents.alice.slots.' + intentName.toLowerCase() + '.value');
            metricName = metricName.replace("_", " ");
        } else if(intent.slots.nsstatus != undefined) {
            intentName = "NSStatus";
            metricName = undefined;
        } else if(intent.slots.lastloop != undefined) {
            intentName = "LastLoop";
            metricName = undefined;
        } else {
            console.log('Available intent didn\'t found');
            res.json(ctx.alice.buildSpeechletResponse(translate('virtAsstUnknownIntentText')));
            next( );
            return;
        }
        console.log('Intent ' + intentName + ' founded');
        console.log('Metric is ' + metricName);

        var handler = ctx.alice.getIntentHandler(intentName, metricName);
        if (handler){
            var sbx = initializeSandbox();
            handler(function (title, response) {
                var sendResponse = "";
                if( metricName == 'bg' 
                    || (metricName == undefined && intentName == 'NSStatus')) {
                    // add prefix for correct phrase
                    sendResponse = translate('virtAsstTitleCurrentBG') + " " + response;
                } else {
                    sendResponse = response;
                }
                res.json(ctx.alice.buildSpeechletResponse(sendResponse));
                next( );
                return;
                }, [], sbx);
        } else {
            res.json(ctx.alice.buildSpeechletResponse(translate('virtAsstUnknownIntentText')));
            next( );
            return;
        }
    } else {
        console.log('Intent didn\'t found');
        res.json(ctx.alice.buildSpeechletResponse(translate('virtAsstUnknownIntentText')));
    }

  });

  ctx.virtAsstBase.setupMutualIntents(ctx.alice);

  function initializeSandbox() {
    var sbx = require('../../sandbox')();
    sbx.serverInit(env, ctx);
    ctx.plugins.setProperties(sbx);
    return sbx;
  }

  return api;
}

module.exports = configure;
