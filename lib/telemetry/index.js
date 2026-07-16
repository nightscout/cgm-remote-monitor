'use strict';

const crypto = require('crypto');
const config = require('./config');
const createCounters = require('./counters');
const payload = require('./payload');
const routeCounters = require('./route-counters');
const sender = require('./sender');

function create (env, ctx) {
  var telemetryConfig = config.normalize(env && env.telemetry);
  var counters = createCounters();
  var processSecret = telemetryConfig.secret || crypto.randomBytes(32).toString('base64url');
  var secretSource = telemetryConfig.secret ? 'configured' : 'ephemeral';

  function preview (options) {
    options = options || {};
    return {
      enabled: telemetryConfig.enabled,
      mode: telemetryConfig.mode,
      secretSource,
      payload: payload.build(env, ctx, {
        now: options.now,
        installationSecret: options.installationSecret || processSecret,
        counters: counters.snapshot(),
        startup: options.startup,
        uptimeBucket: options.uptimeBucket
      })
    };
  }

  function start () {
    return false;
  }

  function stop () {
    return false;
  }

  function sendOnce (options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    options = options || {};
    callback = callback || function noop () {};

    if (!telemetryConfig.enabled) {
      process.nextTick(function disabled () {
        callback(null, { sent: false, reason: 'disabled' });
      });
      return;
    }

    var current = preview(options);
    sender.send(telemetryConfig.endpoint, current.payload, options, callback);
  }

  return {
    config: telemetryConfig,
    counters,
    preview,
    routeCounters: function createRouteCounters () {
      return routeCounters.middleware({ counters });
    },
    sendOnce,
    start,
    stop
  };
}

module.exports = create;
