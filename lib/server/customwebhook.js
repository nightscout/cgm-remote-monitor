'use strict';

var http = require('http');
var https = require('https');

//how many CUSTOM_WEBHOOK_URL_n / CUSTOM_WEBHOOK_EVENT_n pairs are recognized
var MAX_WEBHOOKS = 4;

var TIMEOUT_MS = 5000;

function init (env) {

  var webhooks = findWebhooks(env && env.settings);

  var customwebhook = { };

  //exposed for testing and for startup logging
  customwebhook.webhooks = webhooks;

  //The event names a notification can match. These mirror the granularity
  //levels produced by makeRequests in lib/plugins/maker.js so operators can
  //reuse the event names already documented for the Maker integration.
  //Unlike Maker, a matching destination is sent exactly one request.
  customwebhook.eventNames = function eventNames (event) {
    var names = ['ns-event'];

    if (event && event.level) {
      names.push('ns-' + event.level);
    }

    if (event && event.name) {
      names.push('ns' + ((event.level && '-' + event.level) || '') + '-' + event.name);
    }

    return names;
  };

  customwebhook.sendEvent = function sendEvent (event, callback) {
    callback = callback || function noopCallback ( ) { };

    if (!event || !event.name) {
      callback('No event name found');
    } else if (!event.level) {
      callback('No event level found');
    } else {
      deliver(customwebhook.eventNames(event), event, callback);
    }
  };

  customwebhook.sendAllClear = function sendAllClear (notify, callback) {
    callback = callback || function noopCallback ( ) { };

    deliver(['ns-allclear'], {
      name: 'allclear'
      , title: (notify && notify.title) || 'All Clear'
      , message: notify && notify.message
    }, callback);
  };

  //exposed so tests can replace the outbound request
  customwebhook.sendRequest = function sendRequest (webhook, payload, callback) {
    var target = webhook.target;
    var transport = target.protocol === 'https:' ? https : http;
    var body = JSON.stringify(payload);
    var finished = false;

    //a destroyed socket can emit both 'timeout' and 'error', only report once
    function finish (err, response) {
      if (finished) { return; }
      finished = true;
      callback(err, response);
    }

    var options = {
      hostname: target.hostname
      , port: target.port || undefined
      , path: target.pathname + target.search
      , method: 'POST'
      , timeout: TIMEOUT_MS
      , headers: {
        'Content-Type': 'application/json'
        , 'Content-Length': Buffer.byteLength(body)
      }
    };

    var request = transport.request(options, function onResponse (response) {
      //drain the response so the socket is released
      response.on('data', function onData ( ) { });
      response.on('end', function onEnd ( ) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          finish(null, response);
        } else {
          finish('unexpected status ' + response.statusCode);
        }
      });
    });

    request.on('error', function onError (err) {
      finish((err && err.message) || 'request failed');
    });

    request.on('timeout', function onTimeout ( ) {
      //destroy triggers the error handler above, which reports the failure
      request.destroy();
    });

    request.write(body);
    request.end();
  };

  function deliver (names, event, callback) {
    var matched = [ ];
    //one delivery per destination per notification, so an endpoint configured
    //for more than one matching event name is never sent duplicates
    var seen = Object.create(null);

    webhooks.forEach(function eachWebhook (webhook) {
      if (names.indexOf(webhook.event) < 0 || seen[webhook.url]) {
        return;
      }
      seen[webhook.url] = true;
      matched.push(webhook);
    });

    if (matched.length === 0) {
      callback(null, {sent: 0});
      return;
    }

    var pending = matched.length;
    var errs = [ ];

    matched.forEach(function eachMatched (webhook) {
      customwebhook.sendRequest(webhook, payloadFor(webhook, event), function requestCallback (err) {
        if (err) {
          //report the origin only, the full URL may carry a token
          errs.push(describe(webhook) + ': ' + err);
        }

        pending -= 1;
        if (pending === 0) {
          callback(errs.length > 0 ? errs.join(', ') : null, {
            sent: matched.length - errs.length
            , matched: matched.length
          });
        }
      });
    });
  }

  function payloadFor (webhook, event) {
    var now = Date.now();

    return {
      source: 'nightscout'
      , event: webhook.event
      , name: event.name
      , level: event.level || null
      , title: event.title
      , message: event.message
      , isAnnouncement: !!event.isAnnouncement
      , mills: now
      , iso: new Date(now).toISOString()
    };
  }

  if (webhooks.length > 0) {
    webhooks.forEach(function eachWebhook (webhook) {
      console.info('custom webhook ' + webhook.index + ' listening for ' + webhook.event + ' at ' + describe(webhook));
    });
    return customwebhook;
  } else {
    return null;
  }

}

//host and port only, never the path or query, which may contain a secret
function describe (webhook) {
  return webhook.target.protocol + '//' + webhook.target.host;
}

function findWebhooks (settings) {
  var found = [ ];

  if (!settings) {
    return found;
  }

  for (var i = 1; i <= MAX_WEBHOOKS; i++) {
    var url = trimmed(settings['customWebhookUrl' + i]);
    var event = trimmed(settings['customWebhookEvent' + i]);

    //an unused slot is normal, indexes do not have to be contiguous
    if (!url && !event) {
      continue;
    }

    if (!url || !event) {
      console.warn('ignoring custom webhook ' + i + ', both CUSTOM_WEBHOOK_URL_' + i +
        ' and CUSTOM_WEBHOOK_EVENT_' + i + ' are required');
      continue;
    }

    var target = parseTarget(url);

    if (!target) {
      console.warn('ignoring custom webhook ' + i + ', CUSTOM_WEBHOOK_URL_' + i +
        ' is not a valid http or https URL');
      continue;
    }

    found.push({index: i, event: event, url: url, target: target});
  }

  return found;
}

function parseTarget (url) {
  var target;

  try {
    target = new URL(url);
  } catch (err) {
    return null;
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return null;
  }

  return target;
}

function trimmed (value) {
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = init;
