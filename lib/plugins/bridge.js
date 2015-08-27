'use strict';

var engine = require('share2nightscout-bridge');

function init (env) {
  if (env.extendedSettings.bridge && env.extendedSettings.bridge.userName && env.extendedSettings.bridge.password) {
    return create(env);
  } else {
    console.info('Dexcom bridge not enabled');
  }
}

function bridged (entries) {
  function payload (err, glucose) {
    if (err) {
      console.error('Bridge error: ', err);
    } else {
      entries.create(glucose, function stored (err) {
        if (err) {
          console.error('Bridge storage error: ', err);
        }
      });
    }
  }
  return payload;
}

function options (env) {
  var config = {
    accountName: env.extendedSettings.bridge.userName
    , password: env.extendedSettings.bridge.password
  };

  var fetch_config = {
    maxCount: env.extendedSettings.bridge.maxCount || 1
    , minutes: env.extendedSettings.bridge.minutes || 1440
  };

  return {
    login: config
    , interval: env.extendedSettings.bridge.interval || 60000 * 2.5
    , fetch: fetch_config
    , nightscout: { }
    , maxFailures: env.extendedSettings.bridge.maxFailures || 3
    , firstFetchCount: env.extendedSettings.bridge.firstFetchCount || 3
  };
}

function create (env) {

  var bridge = { };

  var opts = options(env);
  var interval = opts.interval;

  bridge.startEngine = function startEngine (entries) {

    opts.callback = bridged(entries);

    setInterval(engine(opts), interval);
  };

  return bridge;
}

init.create = create;
init.bridged = bridged;
init.options = options;
exports = module.exports = init;
