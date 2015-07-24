'use strict';

var async = require('async');
var request = require('request');

function init (env) {

  var key = env.extendedSettings && env.extendedSettings.maker && env.extendedSettings.maker.key;

  var TIME_30_MINS_MS = 30 * 60 * 1000;

  var maker = { };

  var lastAllClear = 0;

  maker.sendAllClear = function sendAllClear (notify, callback) {
    if (Date.now() - lastAllClear > TIME_30_MINS_MS) {
      lastAllClear = Date.now();

      //can be used to prevent maker/twitter deduping (add to IFTTT tweet text)
      var shortTimestamp = Math.round(Date.now() / 1000 / 60);

      maker.makeRequest({
        value1: (notify && notify.title) || 'All Clear'
        , value2: notify && notify.message && '\n' + notify.message
        , value3: '\n' + shortTimestamp
      }, 'ns-allclear', function allClearCallback (err) {
        if (err) {
          lastAllClear = 0;
          callback(err);
        } else if (callback) {
          callback(null, {sent: true});
        }
      });
    } else if (callback) {
      callback(null, {sent: false});
    }
  };

  maker.sendEvent = function sendEvent (event, callback) {
    if (!event || !event.name) {
      if (callback) { callback('No event name found'); }
    } else {
      maker.makeRequests(event, function sendCallback (err, response) {
        if (err) {
          if (callback) { callback(err); }
        } else {
          lastAllClear = 0;
          if (callback) { callback(null, response); }
        }
      });
    }
  };

  //exposed for testing
  maker.valuesToQuery = function valuesToQuery (event) {
    var query = '';

    for (var i = 1; i <= 3; i++) {
      var name = 'value' + i;
      var value = event[name];
      lastAllClear = 0;
      if (value) {
        if (query) {
          query += '&';
        } else {
          query += '?';
        }
        query += name + '=' + encodeURIComponent(value);
      }
    }

    return query;
  };

  maker.makeRequest = function makeRequest(event, eventName, callback) {
    var url = 'https://maker.ifttt.com/trigger/' + eventName + '/with/key/' + key + maker.valuesToQuery(event);
    request
      .get(url)
      .on('response', function (response) {
        console.info('sent maker request: ', url);
        if (callback) { callback(null, response); }
      })
      .on('error', function (err) {
        if (callback) { callback(err); }
      });
  };

  maker.makeRequests = function makeRequests(event, callback) {
    function sendGeneric (callback) {
      maker.makeRequest(event, 'ns-event', callback);
    }

    function sendByLevel (callback) {
      maker.makeRequest (event, 'ns-' + event.level, callback);
    }

    function sendByLevelAndName (callback) {
      maker.makeRequest(event, 'ns' + ((event.level && '-' + event.level) || '') + '-' + event.name, callback);
    }

    //since maker events only filter on name, we are sending multiple events and different levels of granularity
    async.series([sendGeneric, sendByLevel, sendByLevelAndName], callback);
  };

  if (key) {
    return maker;
  } else {
    return null;
  }

}

module.exports = init;