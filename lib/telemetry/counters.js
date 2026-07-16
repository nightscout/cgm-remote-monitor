'use strict';

const allowlists = require('./allowlists');

function createCounters (options) {
  options = options || {};
  var dateProvider = options.dateProvider || function now () { return new Date(); };
  var onChange = options.onChange || function noop () {};
  var initial = options.state || {};
  var since = initial.since || dateProvider().toISOString();
  var used = Object.assign({}, initial.used || {});
  var health = Object.assign(defaultHealth(), initial.health || {});

  function defaultHealth () {
    return {
    http_2xx: 0,
    http_3xx: 0,
    http_4xx: 0,
    http_5xx: 0,
    websocket_connections: 0
    };
  }

  function persist () {
    onChange({
      since,
      used: Object.assign({}, used),
      health: Object.assign({}, health)
    });
  }

  function increment (name, amount) {
    if (!allowlists.isAllowedCounter(name)) {
      return false;
    }
    used[name] = (used[name] || 0) + (amount || 1);
    persist();
    return true;
  }

  function recordStatus (statusCode) {
    var code = Number(statusCode);
    if (code >= 200 && code < 300) {
      health.http_2xx += 1;
    } else if (code >= 300 && code < 400) {
      health.http_3xx += 1;
    } else if (code >= 400 && code < 500) {
      health.http_4xx += 1;
    } else if (code >= 500 && code < 600) {
      health.http_5xx += 1;
    }
    persist();
  }

  function recordWebsocketConnection () {
    health.websocket_connections += 1;
    persist();
  }

  function reset (now) {
    since = (now || dateProvider()).toISOString();
    used = {};
    health = defaultHealth();
    persist();
  }

  function snapshot () {
    return {
      since,
      used: Object.assign({}, used),
      health: Object.assign({}, health)
    };
  }

  return {
    increment,
    recordStatus,
    recordWebsocketConnection,
    reset,
    snapshot
  };
}

module.exports = createCounters;
