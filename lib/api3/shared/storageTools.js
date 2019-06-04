'use strict';

function configure (app) {
  var self = {}

  self.getStorageCurrentDate = function getStorageCurrentDate () {

    return new Promise(async function (resolve) {
      const storage = app.get('entriesCollection').storage;

      const result = await storage.currentDate();
      if (!result) {
        resolve({
          srvDate: new Date()
        });
      }
      else {
        resolve(result);
      }
    });
  }


  self.getStorageVersion = function getStorageVersion () {

    return new Promise(async function (resolve) {
      const storage = app.get('entriesCollection').storage;
      let storageVersion = app.get('storageVersion');

      if (storageVersion) {
        resolve(storageVersion);
      }
      else {
        storageVersion = await storage.version();
        app.set('storageVersion', storageVersion);
        resolve(storageVersion);
      }
    });
  }


  self.getVersionInfo = function getVersionInfo() {

    return new Promise(async function (resolve) {
      const info = { version: app.get('version')
        , apiVersion: app.get('apiVersion')
      };

      const results = await Promise.all([
        self.getStorageCurrentDate(),
        self.getStorageVersion()
      ]);
      const [dateResult, storageVersion] = results;

      if (!dateResult)
        throw 'empty dateResult';

      if (!storageVersion) 
        throw 'empty storageVersion';
        
      info.storage = storageVersion;
      info.storage.srvDate = dateResult.srvDate.getTime();
      info.storage.srvDateString = dateResult.srvDate.toISOString();

      resolve(info);
    });
  }

  return self;
}
module.exports = configure;
