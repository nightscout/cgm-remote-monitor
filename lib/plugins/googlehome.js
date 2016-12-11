var _ = require('lodash');
var moment = require('moment');

function init(env, ctx) {

  console.log('Configuring Google Home...');

  function googleHome() {
    return googleHome;
  }

  var entries = ctx.entries;
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
      var response = '';
      if (records && records.length > 0) {
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
        response = buildPreamble(result.parameters);
        response += sbx.scaleMgdl(records[0].sgv) + direction + ' as of ' + moment(records[0].date).from(moment(sbx.time));
      } else {
        response = buildPreamble(result.parameters) + 'unknown';
      }
      next(response);
    });
  };

  googleHome.buildResponse = function buildResponse(output) {
    return {
      speech: output
      , displayText: output
      , source: 'Nightscout'
    };
  };

  function buildPreamble(parameters) {
    var preamble = '';
    if (parameters && parameters.givenName) {
      preamble = parameters.givenName + '\'s current ';
    } else {
      preamble = 'Your current ';
    }
    if (parameters && parameters.readingType) {
      preamble += parameters.readingType + ' is ';
    } else {
      preamble += 'blood glucose is ';
    }
    return preamble;
  }

  return googleHome;
}

module.exports = init;
