'use strict';

function configure (app) {
  const self = {}

  
  self.getStorageVersion = function getStorageVersion () {

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


  self.getVersionInfo = function getVersionInfo() {

    return new Promise(function (resolve, reject) {

      try {
        const srvDate = new Date()
          , info = { version: app.get('version')
          , apiVersion: app.get('apiVersion')
          , srvDate: srvDate.getTime()
        };

        self.getStorageVersion()
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

  return self;
}
module.exports = configure;
