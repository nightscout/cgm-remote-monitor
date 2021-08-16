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
  api.use(wares.bodyParser.json({
    limit: 1048576
    , extended: true
  }));

  ctx.virtAsstBase.setupVirtAsstHandlers(ctx.alexa);

  var intentDetails = null
    , handler = null
    , slots = {};
  function handleIntent(intent, next, createAllowed) {
    // go through the process of fetching the handler if we haven't already
    if (!handler) {
      slots = intent.slots
      var intentName = intent.name
        , metric;
      if (slots) {
        // get metric name based on intent, since Amazon doesn't let us unify the names... :-(
        var metricSlotSrc;
        switch (intentName) {
          case 'MetricNow':
            metricSlotSrc = 'metric';
            break;
  
          case 'MetricReportNow':
            metricSlotSrc = 'action_current';
            break;
        }
  
        var slotStatus = _.get(slots, metricSlotSrc+'.resolutions.resolutionsPerAuthority[0].status.code');
        var slotName = _.get(slots, metricSlotSrc+'.resolutions.resolutionsPerAuthority[0].values[0].value.name');
        if (slotStatus === 'ER_SUCCESS_MATCH' && slotName) {
          metric = slotName;
        } else {
          next(translate('virtAsstUnknownIntentTitle'), translate('virtAsstUnknownIntentText'));
          return false;
        }
  
        // get rid of all the fluff from amazon
        for (var slot in slots) {
          slots[slot] = _.get(slots, slot+'.value');
        }
      }
  
      // store it
      handler = ctx.alexa.getIntentHandler(intentName, metric);
    }

    if (handler) {
      // check if create access is required
      if (handler.createAccess) {
        var confStatus = _.get(intent, 'confirmationStatus');
        if (!createAllowed) {
          // it's required and we don't have it in this context
          return true;
        } else if (confStatus === 'DENIED') {
          // the user cancelled the interaction
          next(translate('virtAsstCancelledTitle'), translate('virtAsstCancelledText'));
          return false;
        } else if (confStatus !== 'CONFIRMED') {
          // the user did not confirm the interaction, which we should probably require since it can mess with people's systems
          next('', '');
          return false;
        }
      }

      var sbx = ctx.virtAsstBase.initSandbox();
      handler(next, slots, sbx);
      return false;
    } else {
      next(translate('virtAsstUnknownIntentTitle'), translate('virtAsstUnknownIntentText'));
      return false;
    }
  }

  api.post('/alexa', ctx.authorization.isPermitted('api:*:read'), function (req, res, next) {
    console.log('Incoming request from Alexa');
    var locale = _.get(req, 'body.request.locale');
    if(locale){
      if(locale.length > 2) {
        locale = locale.substr(0, 2);
      }
      ctx.language.set(locale);
      moment.locale(locale);
    }

    var type = _.get(req, 'body.request.type');
    intentDetails = _.get(req, 'body.request.intent');
    switch (type) {
      case 'SessionEndedRequest':
        console.log('Session ended');
        res.json('');
        res.end();
        break;

      case 'LaunchRequest':
        if (!intentDetails) {
          console.log('Session launched');
          res.json(ctx.alexa.buildSpeechletResponse(
              translate('virtAsstTitleLaunch'),
              translate('virtAsstLaunch'),
              translate('virtAsstLaunch'),
              false
          ));
          res.end();
          break;
        }
        // if intent is set then fallback to IntentRequest

      case 'IntentRequest': // eslint-disable-line no-fallthrough
        console.log('Received intent request');
        console.log(JSON.stringify(intentDetails));
        var createAccess = handleIntent(intentDetails, function (title, response) {
          res.json(ctx.alexa.buildSpeechletResponse(title, response, '', true));
          res.end();
        }, false);

        // go on to the next perms check if needed
        if (createAccess) {
          console.log('Intent handler requires create access');
          next();
        }
        break;
    }
  }
  // we get here if we need create access
  , ctx.authorization.isPermitted('api:*:write'), function (req, res) {
    console.log(req);
    handleIntent(intentDetails, function (title, response) {
      res.json(ctx.alexa.buildSpeechletResponse(title, response, '', true));
      res.end();
    }, true);
  });

  ctx.virtAsstBase.setupMutualIntents(ctx.alexa);

  return api;
}

module.exports = configure;
