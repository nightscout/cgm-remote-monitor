'use strict';

var engine = require('share2nightscout-bridge');

function init (env) {
  if (env.extendedSettings.bridge && env.extendedSettings.bridge.accountName && env.extendedSettings.bridge.password) {
    return buildBridge(env);
  } else {
    console.info('Dexcom bridge not enabled');
  }
}

function buildBridge (env) {

  var bridge = { };

  var config = {
    accountName: env.extendedSettings.bridge.accountName
    , password: env.extendedSettings.bridge.password
  };

  var interval = env.extendedSettings.bridge.interval || 60000 * 2.5;

  var fetch_config = {
    maxCount: env.extendedSettings.bridge.maxCount || 1
    , minutes: env.extendedSettings.bridge.minutes || 1440
  };

  var opts = {
    login: config
    , fetch: fetch_config
    , nightscout: { }
    , maxFailures: env.extendedSettings.bridge.maxFailures || 3
    , firstFetchCount: env.extendedSettings.bridge.firstFetchCount || 3
  };

  bridge.startEngine = function startEngine (entries) {

    opts.callback = function bridged (err, glucose) {
      if (err) {
        console.error('Bridge error: ', err);
      } else {
        entries.create(glucose, function stored (err) {
          if (err) {
            console.error('Bridge storage error: ', err);
          }
        });
      }
    };

    setInterval(engine(opts), interval);
  };

  return bridge;
}

module.exports = init;