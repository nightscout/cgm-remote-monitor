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
      pollingIntervalMs: options.diasendPollingInterval,
      nightscoutClient,
    });

    const stopProfileSynchronization =
      diasendBridge.startPumpSettingsSynchronization({
        diasendPassword: options.diasendPassword,
        diasendUsername: options.diasendUsername,
        pollingIntervalMs: options.diasendPumpSettingsPollingInterval,
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
    diasendUsername: env.extendedSettings.diasend.username,
    diasendPassword: env.extendedSettings.diasend.password,
    // default is 1 minute
    diasendPollingInterval:
      env.extendedSettings.diasend.pollingIntervalMs || 60 * 1000,
    // default is 12 hours
    diasendPumpSettingsPollingInterval:
      env.extendedSettings.diasend.pumpSettingsPollingIntervalMs ||
      12 * 60 * 60 * 1000,
  };
}

module.exports = init;
