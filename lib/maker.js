'use strict';

var _ = require('lodash');
var request = require('request');

function init (env) {

  var key = env.extendedSettings && env.extendedSettings.maker && env.extendedSettings.maker.key;

  var TIME_30_MINS_MS = 30 * 60 * 1000;

  function maker() {
    return maker;
  }

  var lastAllClear = 0;

  maker.sendAllClear = function sendAllClear (callback) {
    if (Date.now() - lastAllClear > TIME_30_MINS_MS) {
      lastAllClear = Date.now();
      maker.makeRequest('ns-allclear', function allClearCallback (err) {
        if (err) {
          lastAllClear = 0;
          callback(err);
        } else {
          callback && callback(null, {sent: true});
        }
      });
    } else {
      callback && callback(null, {sent: false});
    }
  };

  maker.sendEvent = function sendEvent (event, callback) {
    if (!event || !event.name) {
      callback('No event name found');
    } else {
      maker.makeRequest(event, function sendCallback (err, response) {
        if (err) {
          callback(err);
        } else {
          lastAllClear = 0;
          callback && callback(null, response);
        }
      });
    }
  };

  //exposed for testing
  maker.valuesToQuery = function valuesToQuery (values) {
    var query = '';

    if (values && values.length) {
      lastAllClear = 0;
      _.forEach(values, function eachValue (value, index) {
        if (query) {
          query += '&';
        } else {
          query += '?';
        }
        query += 'value' + (index + 1) + '=' + encodeURIComponent(value);
      });
    }

    return query;
  };

  maker.makeRequest = function makeRequest(event, callback) {
    request
      .get('https://maker.ifttt.com/trigger/' + event.name + '/with/key/' + key + maker.valuesToQuery(event.values))
      .on('response', function (response) {
        callback && callback(null, response);
      })
      .on('error', function (err) {
        callback && callback(err);
      });
  };

  if (key) {
    return maker();
  } else {
    return null;
  }

}

module.exports = init;