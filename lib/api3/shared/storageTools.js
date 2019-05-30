'use strict';

function configure (app) {
  var self = {}

  self.getStorageVersion = function getStorageVersion (done) {
    var storage = app.get('entriesCollection').storage
      , storageVersion = app.get('storageVersion')
      ;

    if (storageVersion) {
      done(null, storageVersion);
    }
    else {
      storage.version(function queryVersionDone (err, storageVersion) {
        if (err) {
          done(err, null);
        }
        else {
          app.set('storageVersion', storageVersion);
          done(null, storageVersion);
        }
      });
    }
  }

  return self;
}
module.exports = configure;
