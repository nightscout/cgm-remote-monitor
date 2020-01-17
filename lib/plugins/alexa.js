var _ = require('lodash');
var async = require('async');

function init(env, ctx) {
  console.log('Configuring Alexa.');
  function alexa() {
    return alexa;
  }
  var intentHandlers = {};
  var rollup = {};

  // This configures a router/handler. A routable slot the name of a slot that you wish to route on and the slotValues
  // are the values that determine the routing. This allows for specific intent handlers based on the value of a
  // specific slot. Routing is only supported on one slot for now.
  // There is no protection for a previously configured handler - one plugin can overwrite the handler of another
  // plugin.
  alexa.configureIntentHandler = function configureIntentHandler(intent, handler, routableSlot, slotValues) {
    if (! intentHandlers[intent]) {
      intentHandlers[intent] = {};
    }
    if (routableSlot && slotValues) {
      for (var i = 0, len = slotValues.length; i < len; i++) {
        if (! intentHandlers[intent][routableSlot]) {
          intentHandlers[intent][routableSlot] = {};
        }
        if (!intentHandlers[intent][routableSlot][slotValues[i]]) {
          intentHandlers[intent][routableSlot][slotValues[i]] = {};
        }
        intentHandlers[intent][routableSlot][slotValues[i]].handler = handler;
      }
    } else {
      intentHandlers[intent].handler = handler;
    }
  };

  // This function retrieves a handler based on the intent name and slots requested.
  alexa.getIntentHandler = function getIntentHandler(intentName, slots) {
    if (intentName && intentHandlers[intentName]) {
      if (slots) {
        var slotKeys = Object.keys(slots);
        for (var i = 0, len = slotKeys.length; i < len; i++) {
          if (intentHandlers[intentName][slotKeys[i]] && slots[slotKeys[i]].value &&
            intentHandlers[intentName][slotKeys[i]][slots[slotKeys[i]].value] &&
            intentHandlers[intentName][slotKeys[i]][slots[slotKeys[i]].value].handler) {

            return intentHandlers[intentName][slotKeys[i]][slots[slotKeys[i]].value].handler;
          }
        }
      }
      if (intentHandlers[intentName].handler) {
        return intentHandlers[intentName].handler;
      }
      return null;
    } else {
      return null;
    }

  };

  alexa.addToRollup = function(rollupGroup, handler, rollupName) {
    if (!rollup[rollupGroup]) {
      console.log('Creating the rollup group: ', rollupGroup);
      rollup[rollupGroup] = [];
    }
    rollup[rollupGroup].push({handler: handler, name: rollupName});
    // status = _.orderBy(status, ['priority'], ['asc'])
  };

  alexa.getRollup = function(rollupGroup, sbx, slots, locale, callback) {
    var handlers = _.map(rollup[rollupGroup], 'handler');
    console.log('Rollup array for ', rollupGroup);
    console.log(rollup[rollupGroup]);
    var nHandlers = [];
    _.each(handlers, function (handler) {
      nHandlers.push(handler.bind(null, slots, sbx));
    });
    async.parallelLimit(nHandlers, 10, function(err, results) {
      if (err) {
        console.error('Error: ', err);
      }
      callback(_.map(_.orderBy(results, ['priority'], ['asc']), 'results').join(' '));
    });
  };

  // This creates the expected alexa response
  alexa.buildSpeechletResponse = function buildSpeechletResponse(title, output, repromptText, shouldEndSession) {
    return {
      version: '1.0',
      response: {
        outputSpeech: {
          type: 'PlainText',
          text: output
        },
        card: {
          type: 'Simple',
          title: title,
          content: output
        },
        reprompt: {
          outputSpeech: {
            type: 'PlainText',
            text: repromptText
          }
        },
        shouldEndSession: shouldEndSession
      }
    };
  };

  return alexa;
}

module.exports = init;
