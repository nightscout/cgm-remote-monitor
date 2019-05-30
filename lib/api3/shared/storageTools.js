'use strict';

function configure (app) {
  var self = {}

  self.getStorageCurrentDate = function getStorageCurrentDate (done) {
    var storage = app.get('entriesCollection').storage
      ;

    storage.currentDate(function currentDateDone (err, result) {
      if (err) {
        done(err, null);
      }
      if (!result) {
        done(null, {
          srvDate: new Date()
        });
      }
      else {
        done(null, result);
      }
    });
  }


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
