'use strict';

const allowlists = require('./allowlists');

function createCounters () {
  var used = {};
  var health = {
    http_2xx: 0,
    http_3xx: 0,
    http_4xx: 0,
    http_5xx: 0,
    websocket_connections: 0
  };

  function increment (name, amount) {
    if (!allowlists.isAllowedCounter(name)) {
      return false;
    }
    used[name] = (used[name] || 0) + (amount || 1);
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
  }

  function recordWebsocketConnection () {
    health.websocket_connections += 1;
  }

  function snapshot () {
    return {
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
