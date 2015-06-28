'use strict';

var request = require('request');

function init (env) {

  console.info('>>>env.extendedSettings', env.extendedSettings);
  var key = env.extendedSettings && env.extendedSettings.maker && env.extendedSettings.maker.key;

  function maker() {
    return maker;
  }

  maker.sendEvent = function sendEvent (event, callback) {

    if (!event || !event.name) {
      callback('No event name found');
    } else {
      var query = '';

      if (event.values && event.values.length) {
        _.forEach(event.values, function eachValue (value, index) {
          if (query) {
            query += '&';
          } else {
            query += '?';
          }
          query += 'value' + (index + 1) + '=\'' + encodeURIComponent(value) + '\'';
        });
      }

      request
        .get('https://maker.ifttt.com/trigger/' + event.name + '/with/key/' + key + query)
        .on('response', function (response) {
          callback(null, response);
        })
        .on('error', function (err) {
          callback(err);
        });
    }
  };

  if (key) {
    return maker();
  } else {
    return null;
  }

}

module.exports = init;