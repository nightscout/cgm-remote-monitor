
function init(env, ctx) {

  console.log('Configuring Google Home...');

  function googleHome() {
    return googleHome;
  }

  var intentHandlers = {};

  googleHome.configureIntentHandler = function configureIntentHandler(intent, handler, routableSlot, slotValues) {
    if (!intentHandlers[intent]) {
      intentHandlers[intent] = {};
    }
    if (routableSlot && slotValues) {
      for (var i = 0, len = slotValues.length; i < len; i++) {
        if (!intentHandlers[intent][routableSlot]) {
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

  googleHome.getIntentHandler = function getIntentHandler(intentName, metric) {
    if (intentName && intentHandlers[intentName]) {
      if (metric && intentHandlers[intentName]['metric'] &&
        intentHandlers[intentName]['metric'][metric] &&
        intentHandlers[intentName]['metric'][metric].handler) {
        return intentHandlers[intentName]['metric'][metric].handler;
      } else if (intentHandlers[intentName].handler) {
        return intentHandlers[intentName].handler;
      } else {
        return null;
      }
    } else {
      return null;
    }

  };

  googleHome.buildResponse = function buildResponse(output) {
    return {
      fulfillmentText: output
//      , fulfillmentMessages: [output]
      , source: 'Nightscout'
    };
  };

  return googleHome;
}

module.exports = init;
