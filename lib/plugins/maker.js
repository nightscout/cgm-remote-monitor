'use strict';

var tasks = require('../utils/callback-tasks');
var https = require('https');

var times = require('../times');
const REQUEST_TIMEOUT_MS = 10000;

function init (env) {

  var keys = env.extendedSettings && env.extendedSettings.maker &&
    env.extendedSettings.maker.key && env.extendedSettings.maker.key.split(' ');

  var announcementKeys = (env.extendedSettings && env.extendedSettings.maker &&
    env.extendedSettings.maker.announcementKey && env.extendedSettings.maker.announcementKey.split(' ')) || keys;

  var maker = { };

  var lastAllClear = 0;

  maker.sendAllClear = function sendAllClear (notify, callback) {
    if (Date.now() - lastAllClear > times.mins(30).msecs) {
      lastAllClear = Date.now();

      //can be used to prevent maker/twitter deduping (add to IFTTT tweet text)
      var shortTimestamp = Math.round(Date.now() / 1000 / 60);

      maker.makeKeyRequests({
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
      callback('No event name found');
    } else if (!event.level) {
      callback('No event level found');
    } else {
      maker.makeRequests(event, function sendCallback (err, response) {
        if (err) {
          callback(err);
        } else {
          lastAllClear = 0;
          callback(null, response);
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

  maker.makeRequests = function makeRequests(event, callback) {
    const eventNames = ['ns-event', 'ns-' + event.level,
      'ns' + ((event.level && '-' + event.level) || '') + '-' + event.name];
    let firstError;
    // Keep the stage barrier, but a recipient's failure must not suppress the
    // level/name-specific events that another recipient listens for.
    tasks.series(eventNames.map(function (eventName) {
      return function (next) {
        maker.makeKeyRequests(event, eventName, function (err, response) {
          firstError = firstError || err;
          next(null, response);
        });
      };
    }), function (err, responses) {
      callback(firstError || err, responses);
    });
  };
  maker.makeKeyRequests = function makeKeyRequests(event, eventName, callback) {
    var selectedKeys = event.isAnnouncement ? announcementKeys : keys;
    let firstError;
    // Keys are independent recipients. Start them together and collect errors
    // without letting the task helper stop the remaining recipients early.
    tasks.parallel((selectedKeys || []).map(function (key) {
      return function (next) {
        maker.makeKeyRequest(key, event, eventName, function (err, response) {
          firstError = firstError || err;
          next(null, response);
        });
      };
    }), function (err, responses) {
      callback(firstError || err, responses.length <= 1 ? responses[0] : responses);
    });
  };

  maker.makeKeyRequest = function makeKeyRequest(key, event, eventName, callback) {
    var url = 'https://maker.ifttt.com/trigger/' + eventName + '/with/key/' + key + maker.valuesToQuery(event);
    let request, completed = false;
    function finish(err, response) {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (err && request) request.destroy(err);
      if (!err) console.info('sent maker request: ', eventName);
      callback(err, response);
    }
    // An absolute deadline also bounds DNS/TLS setup and a response whose body
    // never ends; a socket inactivity timeout alone does not cover those paths.
    const timer = setTimeout(function () {
      const error = new Error('Maker request timed out');
      error.code = 'ETIMEDOUT';
      finish(error);
    }, REQUEST_TIMEOUT_MS);
    try {
      request = https.get(url, function (response) {
        response.on('error', finish);
        response.on('aborted', function () {finish(new Error('Maker response aborted'));});
        response.on('end', function () {
          finish(null, response);
        });
        response.resume();
      });
      request.on('error', finish);
    } catch (err) {
      finish(err);
    }
  };

  if (keys && keys.length > 0) {
    return maker;
  } else {
    return null;
  }

}

module.exports = init;
