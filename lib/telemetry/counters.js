'use strict';

const allowlists = require('./allowlists');

function createCounters (options) {
  options = options || {};
  var dateProvider = options.dateProvider || function now () { return new Date(); };
  var onChange = options.onChange || function noop () {};
  var initial = options.state || {};
  var day = initial.day || currentDay();
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

  function currentDay () {
    return dateProvider().toISOString().slice(0, 10);
  }

  function ensureCurrentDay () {
    var today = currentDay();
    if (day !== today) {
      day = today;
      used = {};
      health = defaultHealth();
      persist();
    }
  }

  function persist () {
    onChange({
      day,
      used: Object.assign({}, used),
      health: Object.assign({}, health)
    });
  }

  function increment (name, amount) {
    ensureCurrentDay();
    if (!allowlists.isAllowedCounter(name)) {
      return false;
    }
    used[name] = (used[name] || 0) + (amount || 1);
    persist();
    return true;
  }

  function recordStatus (statusCode) {
    ensureCurrentDay();
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
    ensureCurrentDay();
    health.websocket_connections += 1;
    persist();
  }

  function snapshot () {
    ensureCurrentDay();
    return {
      day,
      used: Object.assign({}, used),
      health: Object.assign({}, health)
    };
  }

  return {
    increment,
    recordStatus,
    recordWebsocketConnection,
    snapshot
  };
}

module.exports = createCounters;
