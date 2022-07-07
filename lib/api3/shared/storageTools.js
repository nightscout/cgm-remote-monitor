'use strict';

function getStorageVersion (app) {

  return new Promise(function (resolve, reject) {

    try {
      const storage = app.get('entriesCollection').storage;
      let storageVersion = app.get('storageVersion');

      if (storageVersion) {
        process.nextTick(() => {
          resolve(storageVersion);
        });
      } else {
        storage.version()
          .then(storageVersion => {

            app.set('storageVersion', storageVersion);
            resolve(storageVersion);
          }, reject);
      }
    } catch (error) {
      reject(error);
    }
  });
}


function getVersionInfo(app) {

  return new Promise(function (resolve, reject) {

    try {
      const srvDate = new Date()
        , info = { version: app.get('version')
        , apiVersion: app.get('apiVersion')
        , srvDate: srvDate.getTime()
      };

      getStorageVersion(app)
        .then(storageVersion => {

          if (!storageVersion)
            throw new Error('empty storageVersion');

          info.storage = storageVersion;

          resolve(info);

        }, reject);

    } catch(error) {
      reject(error);
    }
  });
}


module.exports = {
  getStorageVersion,
  getVersionInfo
};
