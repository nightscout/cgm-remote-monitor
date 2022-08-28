/* jshint node: true */
"use strict";

const diasendBridge = require("diasend-nightscout-bridge");
const diasendPumpSettingsToNightscoutProfile =
  require("diasend-nightscout-bridge/dist/adapter").diasendPumpSettingsToNightscoutProfile;

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

function getLatestSgvEntry(entries) {
  return new Promise((resolve, reject) => {
    entries.list(
      {
        count: 1,
        type: "sgv",
      },
      function (err, records) {
        if (err) {
          reject(err);
        } else {
          resolve(records[0]);
        }
      }
    );
  });
}

function makeRunner(env, entries, treatments, profile, bus) {
  var options = getOptions(env);

  return function run() {
    getLatestSgvEntry(entries).then((entry) => {
      const stopSynchronization = diasendBridge.startSynchronization({
        ...options,
        pollingIntervalMs: 1 * 60 * 1000,
        dateFrom: new Date(
          entry ? entry.date + 1000 : new Date().getTime() - 1 * 3600 * 1000
        ),
        nightscoutEntriesHandler: (cgmEntries) => {
          if (!cgmEntries.length) {
            return Promise.resolve();
          }
          return new Promise((resolve, reject) => {
            entries.create(cgmEntries, function afterCreate(err, results) {
              if (err) {
                console.error("Diasend Bridge storage error: " + err);
                reject(err);
              } else {
                resolve(results);
              }
            });
          });
        },
        nightscoutTreatmentsHandler: (_treatments) => {
          if (!_treatments.length) {
            return Promise.resolve();
          }
          return new Promise((resolve, reject) => {
            treatments.create(_treatments, function afterCreate(err, results) {
              if (err) {
                console.error("Diasend Bridge storage error: " + err);
                reject(err);
              } else {
                resolve(results);
              }
            });
          });
        },
      });

      const stopProfileSynchronization =
        diasendBridge.startPumpSettingsSynchronization({
          diasendPassword: options.diasendPassword,
          diasendUsername: options.diasendUsername,
          // every hour
          pollingIntervalMs: 1 * 3600 * 1000,
          nightscoutProfileName: "Diasend",
          nightscoutPumpSettingsHandler: (pumpSettings) =>
            new Promise((resolve, reject) =>
              profile.list((err, profiles) => {
                err ? reject(err) : resolve(profiles[0]);
              }, null)
            )
              .then(
                (_profile) =>
                  new Promise((resolve, reject) =>
                    profile.save(
                      {
                        ..._profile,
                        store: {
                          ..._profile.store,
                          Diasend:
                            diasendPumpSettingsToNightscoutProfile(
                              pumpSettings
                            ),
                        },
                      },
                      (err, _profile) => {
                        err ? reject(err) : resolve(_profile);
                      }
                    )
                  )
              )
              .catch(console.error),
        });

      if (bus) {
        bus.on("teardown", function serverTeardown() {
          stopSynchronization();
          stopProfileSynchronization();
        });
      }
    });
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
