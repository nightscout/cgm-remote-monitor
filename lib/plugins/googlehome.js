var _ = require('lodash');
var async = require('async');
var parse_duration = require('parse-duration'); // https://www.npmjs.com/package/parse-duration
var times = require('../times');
var moment = require('moment-timezone');

function init () {
  console.log('Configuring Google Home...');
  function googleHome() {
    return googleHome;
  }
  var intentHandlers = {};
  var rollup = {};

  // There is no protection for a previously handled metric - one plugin can overwrite the handler of another plugin.
  googleHome.configureIntentHandler = function configureIntentHandler(intent, handler, metrics) {
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
  googleHome.getIntentHandler = function getIntentHandler(intentName, metric) {
    var handler;
    if (!metric) {
      console.log('Looking for handler for intent \'' + intentName + '\'');
      handler = _.get(intentHandlers, intentName+'.handler');
    } else {
      console.log('Looking for handler for intent \'' + intentName + '\' for metric \'' + metric + '\'');
      handler = _.get(intentHandlers, intentName+'.'+metric+'.handler');
    }

    if (handler) {
      console.log('Found!');
      return handler;
    } else {
      console.log('Not found!');
      return null;
    }
  };

  googleHome.addToRollup = function(rollupGroup, handler, rollupName) {
    if (!rollup[rollupGroup]) {
      console.log('Creating the rollup group: ', rollupGroup);
      rollup[rollupGroup] = [];
    }
    rollup[rollupGroup].push({handler: handler, name: rollupName});
  };

  googleHome.getRollup = function(rollupGroup, sbx, slots, locale, callback) {
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
      },
      fulfillmentMessages: [
        {
          text: {
            text: [
              output
            ]
          }
        }
      ]
    };
  };

  googleHome.durationToMinutes = function durationToMinutes(slots) {
    var amount = slots.duration.amount || 0
      , unit = slots.duration.unit || 'min';

      return times.msecs(parse_duration(amount+unit)).mins;
  };

  googleHome.hasRelTime = function hasRelTime(slots) {
    return !!slots.date_time;
  };

  googleHome.getCreatedAt = function getCreatedAt(slots) {
    if (slots.date_time) {
      // sometimes it's two deep for some reason... have yet to figure out why...
      return moment(slots.date_time.date_time || slots.date_time).toDate();
    } else {
      return new Date();
    }
  };

  return googleHome;
}

module.exports = init;