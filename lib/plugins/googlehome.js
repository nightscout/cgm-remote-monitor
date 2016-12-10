var _ = require('lodash');
var async = require('async');

function init(env, ctx) {

  console.log('Configuring Google Home...');

  function googleHome() {
    return googleHome;
  }

  var intentHandlers = {};

  googleHome.configureIntentHandler = function configureIntentHandler(handler) {
    var intentName = handler.intentName;
    var intentHandler = handler.intentHandler;
    if (!intentHandlers[intentName]) {
      intentHandlers[intentName] = {};
    }
    intentHandlers[intentName].handler = intentHandler;
  };

  googleHome.getIntentHandler = function getIntentHandler(intentName) {
    if (intentName && intentHandlers[intentName]) {
      if (intentHandlers[intentName].handler) {
        return intentHandlers[intentName].handler;
      }
    }
    return null;
  };

  googleHome.currentBGHandler = function currentBGHandler(result, next, sbx) {
    entries.list({count: 1}, function(err, records) {
      var direction = '';
      if (records[0].direction === 'FortyFiveDown') {
        direction = ' and slightly dropping';
      } else if (records[0].direction === 'FortyFiveUp') {
        direction = ' and slightly rising';
      } else if (records[0].direction === 'Flat') {
        direction = ' and holding';
      } else if (records[0].direction === 'SingleUp') {
        direction = ' and rising';
      } else if (records[0].direction === 'SingleDown') {
        direction = ' and dropping';
      } else if (records[0].direction === 'DoubleDown') {
        direction = ' and rapidly dropping';
      } else if (records[0].direction === 'DoubleUp') {
        direction = ' and rapidly rising';
      }

      var response = '';
      if (result.parameters && results.parameters.givenName) {
        response += parameters.givenName + '\'s current ';
      } else {
        response += 'Your current ';
      }
      if (result.parameters && result.parameters.readingType) {
        response += parameters.readingType + ' is ';
      } else {
        response += 'blood glucose is ';
      }
      response += sbx.scaleMgdl(records[0].sgv) + direction + ' as of ' + moment(records[0].date).from(moment(sbx.time));

      next(response);
    }):
  };

  googleHome.buildResponse = function buildResponse(output) {
    return {
      speech: output
      , displayText: output
      , source: 'Nightscout'
    };
  };

  return googleHome;
}

module.exports = init;
