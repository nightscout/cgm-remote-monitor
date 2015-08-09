'use strict';

function init (env) {

  if (env.extendedSettings.bridge && env.extendedSettings.bridge.accountName && env.extendedSettings.bridge.password) {
    return startBridge(env);
  } else {
    console.info('Dexcom bridge not enabled');
  }

}

function startBridge (env) {

  var bridge = {
    engine: require('share2nightscout-bridge')
  };

  var config = {
    accountName: env.extendedSettings.bridge.accountName
    , password: env.extendedSettings.bridge.password
  };

  bridge.interval = env.extendedSettings.bridge.interval || 60000 * 2.5;

  var fetch_config = {
    maxCount: env.extendedSettings.bridge.maxCount || 1
    , minutes: env.extendedSettings.bridge.minutes || 1440
  };

  bridge.opts = {
    login: config
    , fetch: fetch_config
    , nightscout: { }
    , maxFailures: env.extendedSettings.bridge.maxFailures || 3
    , firstFetchCount: env.extendedSettings.bridge.firstFetchCount || 3
  };

  return bridge;
}

module.exports = init;