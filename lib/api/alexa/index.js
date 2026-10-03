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
  // also support url-encoded content-type
  api.use(wares.urlencodedParser);
  // text body types get handled as raw buffer stream

  ctx.virtAsstBase.setupVirtAsstHandlers(ctx.alexa);
  api.post('/alexa', ctx.authorization.isPermitted('api:*:read'), function (req, res, next) {
    console.log('Incoming request from Alexa');
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
      default:
        // Any other request type (e.g. System.ExceptionEncountered) still has
        // to be answered, or it hangs until the client gives up. Amazon does
        // not accept speech in reply to these, so answer as for SessionEnded.
        console.log('Unhandled Alexa request type', req.body.request.type);
        res.json('');
        next( );
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
      var slotStatus = slots?.metric?.resolutions?.resolutionsPerAuthority?.[0]?.status?.code;
      var slotName = slots?.metric?.resolutions?.resolutionsPerAuthority?.[0]?.values?.[0]?.value?.name;
      if (slotStatus == "ER_SUCCESS_MATCH" && slotName) {
        metric = slotName;
      } else {
        next(translate('virtAsstUnknownIntentTitle'), translate('virtAsstUnknownIntentText'));
        return;
      }
    }

    var handler = ctx.alexa.getIntentHandler(intentName, metric);
    if (handler){
      var sbx = ctx.sbx;
      handler(next, slots, sbx);
      return;
    } else {
      next(translate('virtAsstUnknownIntentTitle'), translate('virtAsstUnknownIntentText'));
      return;
    }
  }

  return api;
}

module.exports = configure;
