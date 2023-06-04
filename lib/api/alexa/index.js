'use strict';

var _ = require('lodash');
var moment = require('moment');

const TELL_ALEXA_TO_DO_ITS_JOB = {
  version: '1.0',
  response: {
    directives: [
      {
        type: 'Dialog.Delegate'
      }
    ]
  }
};

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
  // also support url-encoded content-type
  api.use(wares.urlencodedParser);
  // text body types get handled as raw buffer stream

  ctx.virtAsstBase.setupVirtAsstHandlers(ctx.alexa);

  function handleSystemIntents(intentName, next) {
    switch (intentName) {
      case 'AMAZON.CancelIntent':
      case 'AMAZON.StopIntent':
        // the user cancelled the interaction
        next(translate('virtAsstCancelledTitle'), translate('virtAsstCancelledText'));
        break;

      case 'AMAZON.NavigateHomeIntent':
        next(translate('virtAsstTitleLaunch'), translate('virtAsstLaunch'));
        break;

      case 'AMAZON.HelpIntent':
        next(translate('Help'), translate('virtAsstHelp'));
        break;

      default:
        // not handled
        return false;
    }

    // we handled it here
    return true;
  }

  function getMetricFromSlots(intentName, slots) {
    // get metric name based on intent, since Amazon doesn't let us unify the names... :-(
    var metricSlotSrc = null;
    switch (intentName) {
      case 'MetricNow':
        metricSlotSrc = 'metric';
        break;
    }

    if (metricSlotSrc) {
      var slotStatus = _.get(slots, metricSlotSrc+'.resolutions.resolutionsPerAuthority[0].status.code');
      var slotName = _.get(slots, metricSlotSrc+'.resolutions.resolutionsPerAuthority[0].values[0].value.name');
      if (slotStatus === 'ER_SUCCESS_MATCH' && slotName) {
        return slotName;
      } else {
        // this intent requires a metric parameter, but it's not here
        return false;
      }
    } else {
      // this intent doesn't require a metric parameter
      return null;
    }
  }

  function simplifySlots(slots) {
      // get rid of all the fluff from amazon
      for (var slot in slots) {
        slots[slot] = _.get(slots, slot+'.resolutions.resolutionsPerAuthority[0].values[0].value.name') || _.get(slots, slot+'.value');
      }
      return slots;
  }

  function handleConversationLogic(intentDetails, handler, res, next) {
    var dialogState = _.get(intentDetails, 'dialogState')
      , confirmationStatus = _.get(intentDetails, 'intent.confirmationStatus');

    // check where we are in the conversation
    switch (dialogState) {
      case 'STARTED':
      case 'IN_PROGRESS':
        // not everything is done yet, so we need to check the required fields
        var slots = simplifySlots(_.get(intentDetails, 'intent.slots'))
          , hasMore = false;
        handler.alexaSettings.requiredFields.forEach(function(field) {
          if (!_.get(slots, field)) {
            hasMore = true;
          }
        });

        if (confirmationStatus !== 'NONE' || hasMore || !handler.alexaSettings.intentConfirmer) {
          // the user has responded to the intent confirmation request,
          // or we'll let alexa ask for the required slots to be filled,
          // or all the required slots are filled but we don't have a intentConfirmer, so we let alexa continue
          res.json(TELL_ALEXA_TO_DO_ITS_JOB);
        } else {
          // alexa doesn't have a user-friendly way to confirm the details with the user, so we have to do their job for them :-(
          var sbx = ctx.virtAsstBase.initSandbox(ctx.alexa)
            , response = handler.alexaSettings.intentConfirmer(slots, sbx);

          if (response === false) {
            // the intent confirmer is OK with alexa asking the confirmation in this situation
            res.json(TELL_ALEXA_TO_DO_ITS_JOB);
          } else {
            // the intent confirmer gave us the text to use to confirm the intent
            res.json(ctx.alexa.buildIntentConfirmResponse(response));
          }
        }

        // our work here is done
        res.end();
        return false;

      case 'COMPLETED':
        // we have everything we need
        switch (confirmationStatus) {
          case 'DENIED':
            // the user cancelled the interaction
            next(translate('virtAsstCancelledTitle'), translate('virtAsstCancelledText'));
            return false;

          case 'CONFIRMED':
            // everything looks good to us and the user
            return true;

          default:
            // the user did not confirm the interaction, which we should probably require since it can mess with people's systems
            next(translate('virtAsstUnknownIntentTitle'), translate('virtAsstUnknownIntentText'));
            return false;
        }
    }
  }

  function handleIntent(intentDetails, res, next, createAllowed) {
    var intentName = _.get(intentDetails, 'intent.name')
      , slots = _.get(intentDetails, 'intent.slots')
      , metric = null;

    // handle applicable system intents
    if (handleSystemIntents(intentName, next)) {
      // system intent was handled
      return false;
    }

    if (slots) {
      metric = getMetricFromSlots(intentName, slots);
      if (metric === false) {
        // necessary but not present
        next(translate('virtAsstUnknownIntentTitle'), translate('virtAsstUnknownIntentText'));
        return false;
      }
    }

    // store it
    var handler = ctx.alexa.getIntentHandler(intentName, metric);

    if (handler) {
      // handle stuff when the handler will write data
      if (handler.createAccess) {
        // check if create access needs to be requested
        if (!createAllowed) {
          return true;
        }

        // only process conversation logic when create access is required (we should only need to confirm stuff if they're writing data)
        var goodToGo = handleConversationLogic(intentDetails, handler, res, next);
        if (!goodToGo) {
          return false;
        }
      }

      slots = simplifySlots(slots);

      // launch handler
      var sbx = ctx.virtAsstBase.initSandbox(ctx.alexa);
      handler(next, slots, sbx);
      return false;
    } else {
      // don't know what they're asking for
      next(translate('virtAsstUnknownIntentTitle'), translate('virtAsstUnknownIntentText'));
      return false;
    }
  }

  function updateLocale(locale) {
    if(locale){
      if(locale.length > 2) {
        locale = locale.substr(0, 2);
      }
      ctx.language.set(locale);
      moment.locale(locale);
    }
  }

  var intentDetails = null;
  api.post('/alexa', ctx.authorization.isPermitted('api:*:read'), function (req, res, next) {
    console.log('Incoming request from Alexa');

    updateLocale(_.get(req, 'body.request.locale'));

    var type = _.get(req, 'body.request.type');
    intentDetails = _.get(req, 'body.request');
    switch (type) {
      case 'SessionEndedRequest':
        console.log('Session ended');
        res.json({});
        res.end();
        break;

      case 'LaunchRequest':
        if (!_.get(intentDetails, 'intent')) {
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

        ctx.alexa.getAndSetTimezone(_.get(req, 'body.context.System'),
        // timezone success
        function() {
          var createAccess = handleIntent(intentDetails, res, function (title, response) {
            res.json(ctx.alexa.buildSpeechletResponse(title, response, '', true));
            res.end();
          }, false);
  
          // go on to the next perms check if needed
          if (createAccess) {
            console.log('Intent handler requires create access');
            next();
          } else {
            // reset app state
            intentDetails = null;
          }
        },
        // timezone fail
        function() {
          res.json(ctx.alexa.buildSpeechletResponse(
            translate('Error'),
            translate('virtAsstTimezoneIssue'),
            '',
            true
          ));
          res.end();
        });
        break;
    }
  }
  // we get here if we need create access
  , ctx.authorization.isPermitted('api:*:write'), function (req, res) {
    handleIntent(intentDetails, res, function (title, response) {
      res.json(ctx.alexa.buildSpeechletResponse(title, response, '', true));
      res.end();
    }, true);

    // reset app state
    intentDetails = null;
  });

  ctx.virtAsstBase.setupMutualIntents(ctx.alexa);

  return api;
}

module.exports = configure;
