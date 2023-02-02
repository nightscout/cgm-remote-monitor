/* jshint node: true */
"use strict";

const diasendBridge = require("diasend-nightscout-bridge");
const NightscoutClient =
  require("diasend-nightscout-bridge/dist/nightscout/internal-api").InternalApiNightscoutClient;

function init(env, entries, treatments, bus) {
  if (
    env.extendedSettings.diasend &&
    env.extendedSettings.diasend.username &&
    env.extendedSettings.diasend.password
  ) {
    console.info("Booting Diasend Connector");
    return {
      run: makeRunner(env, entries, treatments, bus),
    };
  } else {
    console.info("Diasend Connect not enabled");
    return null;
  }
}
function makeRunner(env, entries, treatments, profile, bus) {
  var options = getOptions(env);

  const nightscoutClient = new NightscoutClient(entries, treatments, profile);

  return function run() {
    const stopSynchronization = diasendBridge.startSynchronization({
      ...options,
      pollingIntervalMs: 1 * 60 * 1000,
      nightscoutClient,
    });

    const stopProfileSynchronization =
      diasendBridge.startPumpSettingsSynchronization({
        diasendPassword: options.diasendPassword,
        diasendUsername: options.diasendUsername,
        // every 12 hours
        pollingIntervalMs: 12 * 3600 * 1000,
        nightscoutProfileName: "Diasend",
        nightscoutClient,
      });

    if (bus) {
      bus.on("teardown", function serverTeardown() {
        stopSynchronization();
        stopProfileSynchronization();
      });
    }
  };
}

function getOptions(env) {
  return {
    diasendClientId: env.extendedSettings.diasend.clientId,
    diasendClientSecret: env.extendedSettings.diasend.clientSecret,
    diasendUsername: env.extendedSettings.diasend.username,
    diasendPassword: env.extendedSettings.diasend.password,
  };
}

module.exports = init;
