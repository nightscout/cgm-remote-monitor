'use strict';

const crypto = require('crypto');
const config = require('./config');
const createCounters = require('./counters');
const payload = require('./payload');

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

  return {
    config: telemetryConfig,
    counters,
    preview,
    start,
    stop
  };
}

module.exports = create;
