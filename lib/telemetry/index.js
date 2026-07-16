'use strict';

const crypto = require('crypto');
const config = require('./config');
const createCounters = require('./counters');
const payload = require('./payload');
const routeCounters = require('./route-counters');
const sender = require('./sender');
const createStore = require('./store');
const schedule = require('./schedule');

function create (env, ctx, options) {
  options = options || {};
  var telemetryConfig = config.normalize(env && env.telemetry);
  var store = options.store || createStore(telemetryConfig.storeDir);
  var secretResult = resolveSecret(telemetryConfig, store);
  var processSecret = secretResult.secret;
  var secretSource = secretResult.source;
  var scheduleState = readScheduleState(store);
  var counters = createCounters({
    state: readCounterState(store),
    onChange: writeCounterState(store),
    dateProvider: options.dateProvider
  });

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

    var now = options.now || new Date();
    var current = preview(Object.assign({}, options, { now }));
    sender.send(telemetryConfig.endpoint, current.payload, options, function sent (err, result) {
      scheduleState = schedule.afterAttempt(scheduleState, now, result, options.random);
      writeScheduleState(store, scheduleState);
      if (result && result.sent) {
        counters.reset(now);
      }
      callback(err, result);
    });
  }

  function schedulePreview (options) {
    options = options || {};
    var now = options.now || new Date();
    scheduleState = schedule.initializeState(scheduleState, now, options.random);
    writeScheduleState(store, scheduleState);
    return Object.assign({
      due: schedule.isDue(scheduleState, now, telemetryConfig.enabled)
    }, scheduleState);
  }

  return {
    config: telemetryConfig,
    counters,
    secretSource,
    preview,
    routeCounters: function createRouteCounters () {
      return routeCounters.middleware({ counters });
    },
    sendOnce,
    schedulePreview,
    start,
    stop
  };
}

function resolveSecret (telemetryConfig, store) {
  if (telemetryConfig.secret) {
    return { secret: telemetryConfig.secret, source: 'configured' };
  }
  try {
    return { secret: store.readOrCreateSecret(), source: 'generated' };
  } catch (err) {
    return { secret: crypto.randomBytes(32).toString('base64url'), source: 'ephemeral' };
  }
}

function readCounterState (store) {
  try {
    return store.readCounters() || {};
  } catch (err) {
    return {};
  }
}

function writeCounterState (store) {
  return function write (state) {
    try {
      store.writeCounters(state);
    } catch (err) {
      // Counter persistence should never affect request handling.
    }
  };
}

function readScheduleState (store) {
  try {
    return store.readSchedule() || {};
  } catch (err) {
    return {};
  }
}

function writeScheduleState (store, state) {
  try {
    store.writeSchedule(state);
  } catch (err) {
    // Schedule persistence should never affect request handling.
  }
}

module.exports = create;
