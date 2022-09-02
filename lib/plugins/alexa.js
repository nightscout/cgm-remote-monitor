var _ = require('lodash');
var async = require('async');

function init () {
  console.log('Configuring Alexa...');
  function alexa() {
    return alexa;
  }
  var intentHandlers = {};
  var rollup = {};

  // There is no protection for a previously handled metric - one plugin can overwrite the handler of another plugin.
  alexa.configureIntentHandler = function configureIntentHandler(intent, handler, metrics) {
    if (!intentHandlers[intent]) {
      intentHandlers[intent] = {};
    }
    if (metrics) {
      for (var i = 0, len = metrics.length; i < len; i++) {
        if (!intentHandlers[intent][metrics[i]]) {
          intentHandlers[intent][metrics[i]] = {};
        }
        console.log('Storing handler for intent \'' + intent + '\' for metric \'' + metrics[i] + '\'');
        intentHandlers[intent][metrics[i]].handler = handler;
      }
    } else {
      console.log('Storing handler for intent \'' + intent + '\'');
      intentHandlers[intent].handler = handler;
    }
  };

  // This function retrieves a handler based on the intent name and metric requested.
  alexa.getIntentHandler = function getIntentHandler(intentName, metric) {
    if (metric === undefined) {
      console.log('Looking for handler for intent \'' + intentName + '\'');
      if (intentName
        && intentHandlers[intentName]
        && intentHandlers[intentName].handler
      ) {
        console.log('Found!');
        return intentHandlers[intentName].handler;
      }
    } else {
      console.log('Looking for handler for intent \'' + intentName + '\' for metric \'' + metric + '\'');
      if (intentName
        && intentHandlers[intentName]
        && intentHandlers[intentName][metric]
        && intentHandlers[intentName][metric].handler
      ) {
        console.log('Found!');
        return intentHandlers[intentName][metric].handler
      }
    }

    console.log('Not found!');
    return null;
  };

  alexa.addToRollup = function(rollupGroup, handler, rollupName) {
    if (!rollup[rollupGroup]) {
      console.log('Creating the rollup group: ', rollupGroup);
      rollup[rollupGroup] = [];
    }
    rollup[rollupGroup].push({handler: handler, name: rollupName});
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