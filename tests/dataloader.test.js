'use strict';

require('should');

const dataloaderInit = require('../lib/data/dataloader');
const createDData = require('../lib/data/ddata');

describe('dataloader', function () {
  it('completes update when db.stats is promise-based', function (done) {
    const ddata = createDData();
    ddata.processTreatments = function () {};
    const ctx = {
      settings: {},
      language: {
        translate: function (value) { return value; }
      },
      cache: {
        isEmpty: function () { return true; },
        insertData: function (key, results) { return results; }
      },
      ddata: ddata,
      entries: {
        list: function (query, callback) { callback(null, []); }
      },
      treatments: {
        list: function (query, callback) { callback(null, []); }
      },
      profile: {
        last: function (callback) { callback(null, []); }
      },
      food: {
        list: function (callback) { callback(null, []); }
      },
      devicestatus: {
        list: function (query, callback) { callback(null, []); }
      },
      activity: {
        list: function (query, callback) { callback(null, []); }
      },
      store: {
        db: {
          stats: function () {
            return Promise.resolve({ dataSize: 123, indexSize: 456 });
          }
        }
      }
    };
    const env = {
      settings: {
        isEnabled: function () { return false; },
        units: 'mg/dl'
      },
      extendedSettings: {}
    };
    const loader = dataloaderInit(env, ctx);

    loader.update(ddata, function (err) {
      should.not.exist(err);
      ddata.dbstats.should.eql({
        dataSize: 123,
        indexSize: 456
      });
      done();
    });
  });
});
