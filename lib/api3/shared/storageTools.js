'use strict';

function configure (app) {
  var self = {}

  
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
      const srvDate = new Date()
        , info = { version: app.get('version')
        , apiVersion: app.get('apiVersion')
        , srvDate: srvDate.getTime()
      };

      const storageVersion = await self.getStorageVersion();

      if (!storageVersion) 
        throw 'empty storageVersion';
        
      info.storage = storageVersion;

      resolve(info);
    });
  }

  return self;
}
module.exports = configure;
