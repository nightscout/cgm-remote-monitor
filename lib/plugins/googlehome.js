var _ = require('lodash');
var async = require('async');

function init (env, ctx) {
  console.log('Configuring Google Home...');
  function googleHome() {
    return googleHome;
  }
  var intentHandlers = {};
  var rollup = {};

  // There is no protection for a previously handled metric - one plugin can overwrite the handler of another plugin.
  googleHome.configureIntentHandler = function configureIntentHandler(intent, handler, metrics) {
    if (!intentHandlers[String(intent)]) {
      intentHandlers[String(intent)] = {};
    }
    if (metrics) {
      for (var i = 0, len = metrics.length; i < len; i++) {
        if (!intentHandlers[String(intent)][metrics[parseInt(i)]]) {
          intentHandlers[String(intent)][metrics[parseInt(i)]] = {};
        }
        console.log('Storing handler for intent \'' + intent + '\' for metric \'' + metrics[parseInt(i)] + '\'');
        intentHandlers[String(intent)][metrics[parseInt(i)]].handler = handler;
      }
    } else {
      console.log('Storing handler for intent \'' + intent + '\'');
      intentHandlers[String(intent)].handler = handler;
    }
  };

  // This function retrieves a handler based on the intent name and metric requested.
  googleHome.getIntentHandler = function getIntentHandler(intentName, metric) {
    console.log('Looking for handler for intent \'' + intentName + '\' for metric \'' + metric + '\'');
    if (intentName && intentHandlers[String(intentName)]) {
      if (intentHandlers[String(intentName)][String(metric)] && intentHandlers[String(intentName)][String(metric)].handler) {
        console.log('Found!');
        return intentHandlers[String(intentName)][String(metric)].handler
      } else if (intentHandlers[String(intentName)].handler) {
        console.log('Found!');
        return intentHandlers[String(intentName)].handler;
      }
      console.log('Not found!');
      return null;
    } else {
      console.log('Not found!');
      return null;
    }
  };

  googleHome.addToRollup = function(rollupGroup, handler, rollupName) {
    if (!rollup[String(rollupGroup)]) {
      console.log('Creating the rollup group: ', rollupGroup);
      rollup[String(rollupGroup)] = [];
    }
    rollup[String(rollupGroup)].push({handler: handler, name: rollupName});
  };

  googleHome.getRollup = function(rollupGroup, sbx, slots, locale, callback) {
    var handlers = _.map(rollup[String(rollupGroup)], 'handler');
    console.log('Rollup array for ', rollupGroup);
    console.log(rollup[String(rollupGroup)]);
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

  // This creates the expected Google Home response
  googleHome.buildSpeechletResponse = function buildSpeechletResponse(output, expectUserResponse) {
    return {
      payload: {
        google: {
          expectUserResponse: expectUserResponse,
          richResponse: {
            items: [
              {
                simpleResponse: {
                  textToSpeech: output
                }
              }
            ]
          }
        }
      }
    };
  };

  return googleHome;
}

module.exports = init;