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
      run: makeRunner(env, entries, bus),
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

function makeRunner(env, entries, bus) {
  var options = getOptions(env);

  getLatestSgvEntry(entries).then((entry) => {
    console.log("latest value", entry);
  });

  return function run() {
    getLatestSgvEntry(entries).then((entry) => {
      const stopSynchronization = diasendBridge.startSynchronization({
        ...options,
        pollingIntervalMs: 1 * 60 * 1000,
        dateFrom: entry.date + 1,
        nightscoutEntriesHandler: (cgmEntries) => {
          if (!cgmEntries.length) {
            return Promise.resolve();
          }
          return new Promise((resolve, reject) => {
            entries.create(cgmEntries, function afterCreate(err) {
              if (err) {
                console.error("Diasend Bridge storage error: " + err);
                reject(err);
              } else {
                resolve();
              }
            });
          });
        },
      });

      if (bus) {
        bus.on("teardown", function serverTeardown() {
          stopSynchronization();
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
