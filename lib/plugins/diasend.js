/* jshint node: true */
"use strict";

const diasendBridge = require("diasend-nightscout-bridge");

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

function getLatestTreatment(treatments) {
  return new Promise((resolve, reject) => {
    treatments.list(
      {
        count: 1,
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

function getLatestEntry(entries) {
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

function getProfile(profile) {
  return new Promise((resolve, reject) =>
    profile.list((err, profiles) => {
      err ? reject(err) : resolve(profiles[0]);
    }, null)
  );
}

function updateProfile(profile, updatedProfile) {
  return new Promise((resolve, reject) =>
    profile.save(updatedProfile, (err, _profile) => {
      err ? reject(err) : resolve(_profile);
    })
  );
}

function makeRunner(env, entries, treatments, profile, bus) {
  var options = getOptions(env);

  const nightscoutProfileOptions = {
    nightscoutProfileName: "Diasend",
    nightscoutProfileLoader: () => getProfile(profile),
    nightscoutProfileHandler: (updatedProfile) =>
      updateProfile(profile, updatedProfile),
  };

  return function run() {
    Promise.all([getLatestEntry(entries), getLatestTreatment(treatments)]).then(
      ([entry, treatment]) => {
        let dateFrom = new Date().getTime() - 1 * 3600 * 1000;
        if (entry && entry.date > dateFrom) {
          dateFrom = entry.date;
        }
        if (treatment && treatment.date > dateFrom) {
          dateFrom = treatment.date;
        }

        const stopSynchronization = diasendBridge.startSynchronization({
          ...options,
          pollingIntervalMs: 2 * 60 * 1000,
          dateFrom: new Date(dateFrom),
          nightscoutEntriesHandler: (cgmEntries) => {
            if (!cgmEntries.length) {
              return Promise.resolve([]);
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
              return Promise.resolve([]);
            }
            return new Promise((resolve, reject) => {
              treatments.create(
                _treatments,
                function afterCreate(err, results) {
                  if (err) {
                    console.error("Diasend Bridge storage error: " + err);
                    reject(err);
                  } else {
                    resolve(results);
                  }
                }
              );
            });
          },
          // settings to import basal rate
          ...nightscoutProfileOptions,
        });

        const stopProfileSynchronization =
          diasendBridge.startPumpSettingsSynchronization({
            diasendPassword: options.diasendPassword,
            diasendUsername: options.diasendUsername,
            // every 12 hours
            pollingIntervalMs: 12 * 3600 * 1000,
            ...nightscoutProfileOptions,
          });

        if (bus) {
          bus.on("teardown", function serverTeardown() {
            stopSynchronization();
            stopProfileSynchronization();
          });
        }
      }
    );
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
