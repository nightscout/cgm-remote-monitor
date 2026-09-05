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
        insertData: function (key, results) { return results; },
        getRemovalGeneration: function () { return 0; }
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

  it('does not resurrect treatments deleted while a load is in flight', function (done) {
    const ddata = createDData();
    ddata.processTreatments = function () {};

    const bus = new (require('events').EventEmitter)();
    const ghost = {
      _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      eventType: 'Exercise',
      created_at: new Date(Date.now() - 60000).toISOString(),
      mills: Date.now() - 60000,
      duration: 43200
    };

    let treatmentLoads = 0;
    const ctx = {
      settings: {},
      bus: bus,
      language: {
        translate: function (value) { return value; }
      },
      ddata: ddata,
      entries: {
        list: function (query, callback) { callback(null, []); }
      },
      treatments: {
        list: function (query, callback) {
          // secondary loaders filter on eventType; only the main load matters here
          if (query.find && query.find.eventType) return callback(null, []);
          treatmentLoads += 1;
          if (treatmentLoads === 1) {
            // the query result still contains the document, but the delete
            // commits and flushes the cache before the merge happens
            bus.emit('data-update', { type: 'treatments', op: 'remove', count: 1 });
            return callback(null, [ghost]);
          }
          callback(null, []);
        }
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
    ctx.cache = require('../lib/server/cache')(env, ctx);
    const loader = dataloaderInit(env, ctx);

    loader.update(ddata, function (err) {
      should.not.exist(err);
      treatmentLoads.should.equal(2);
      ddata.treatments.filter(function (t) { return t._id === ghost._id; }).should.have.length(0);
      ctx.cache.getData('treatments').filter(function (t) { return t._id === ghost._id; }).should.have.length(0);
      done();
    });
  });
});
