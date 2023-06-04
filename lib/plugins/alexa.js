var _ = require('lodash');
var async = require('async');
var parse_duration = require('parse-duration'); // https://www.npmjs.com/package/parse-duration
var times = require('../times');
var request = require('request');

function init () {
  console.log('Configuring Alexa...');
  function alexa() {
    return alexa;
  }
  var intentHandlers = {};
  var rollup = {};
  var deviceTimezones = {};
  var currentTz = null;

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

  // this is used to confirm an intent and its details with the user
  alexa.buildIntentConfirmResponse = function buildIntentConfirmResponse(confirmText) {
    return {
      version: '1.0',
      response: {
        outputSpeech: {
          type: 'PlainText',
          text: confirmText
        },
        shouldEndSession: false,
        directives: [
          {
            type: 'Dialog.ConfirmIntent'
          }
        ]
      }
    };
  };

  alexa.durationToMinutes = function durationToMinutes(slots) {
    return times.msecs(parse_duration(slots.duration)).mins;
  };

  alexa.hasRelTime = function hasRelTime(slots) {
    return !!(_.get(slots, 'rel_date') || _.get(slots, 'rel_time')
      || (_.get(slots, 'before_after') && _.get(slots, 'time_diff')));
  };

  function changeTimezone(date, ianaTz) {
    var invdate = new Date(date.toLocaleString('en-US', {
      timeZone: ianaTz
    }));
    var diff = date.getTime() - invdate.getTime();
    return new Date(date.getTime() - diff);
  }

  alexa.getCreatedAt = function getCreatedAt(slots) {
    // process absolute date (or now, if not set)
    var now = new Date()
      , date = _.get(slots, 'rel_date', now.toDateString())
      , time = _.get(slots, 'rel_time', now.toTimeString())
      , createdAt = changeTimezone(new Date(date+' '+time), currentTz)

    // process relative time
      , beforeAfter = _.get(slots, 'before_after')
      , timeDiff = _.get(slots, 'time_diff');
    if (beforeAfter && timeDiff) {
      var diffMs = parse_duration(timeDiff);

      // set direction
      if (beforeAfter === 'before') {
        diffMs *= -1;
      }

      // return relative date
      return new Date(now.valueOf() + diffMs);
    } else {
      // return absolute/now date
      return createdAt;
    }
  };

  alexa.getAndSetTimezone = function getAndSetTimezone(system, successCallback, errCallback) {
    var endpoint = _.get(system, 'apiEndpoint')
      , token = _.get(system, 'apiAccessToken')
      , deviceId = _.get(system, 'device.deviceId')
      , dayAgo = Math.round(new Date().getTime() / 1000) - (24 * 3600);

    // use previous timezone as long as it's not older than 24 hours
    if (deviceId in deviceTimezones && deviceTimezones[deviceId].fetched > dayAgo) {
      currentTz = _.get(deviceTimezones, deviceId + '.tz');
      console.log('Using existing timezone');
      successCallback();
      return;
    }

    // require stuff
    if (!endpoint || !token || !deviceId) {
      console.log('Missing required info to fetch timezone');
      errCallback();
      return;
    }

    var tzUrl = endpoint + '/v2/devices/' + deviceId + '/settings/System.timeZone';
    request
      .get(tzUrl)
      .auth(null, null, true, token)
      .on('response', function (response) {
        var body = '';
        response
          .on('readable', function() { body += response.read(); })
          .on('end', function() {
            currentTz = JSON.parse(body);
            if (typeof currentTz === 'string') {
              deviceTimezones[deviceId] = {
                fetched: Math.round(new Date().getTime() / 1000)
                , tz: currentTz
              };
              console.log('Using new downloaded timezone');
              successCallback();
            } else {
              currentTz = null;
              console.log('Could not use response as new timezone', body);
              errCallback();
            }
          });
      })
      .on('error', function (err) {
        console.log('Unable to fetch Alexa device timezone', err);
        // use previous tz if available, even if it's old
        currentTz = _.get(deviceTimezones, deviceId + '.tz');
        if (currentTz) {
          console.log('Using existing (expired) timezone');
          successCallback();
        } else {
          errCallback();
        }
      });
  }

  return alexa;
}

module.exports = init;