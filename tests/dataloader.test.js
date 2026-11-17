'use strict';

const should = require('should');

const dataloaderInit = require('../lib/data/dataloader');
const createDData = require('../lib/data/ddata');

describe('dataloader', function () {
  [false, true].forEach(function (logging) {
    it('completes update with logging=' + logging + ' when db.stats is promise-based', function (done) {
      const ddata = createDData();
      ddata.processTreatments = function () {};
      const ctx = {
        settings: {},
        language: {
          translate: function (value) { return value; }
        },
        cache: {
          isEmpty: function () { return true; },
          // the loader reads entries and treatments by reference now and keeps
          // cloning device statuses, so this stub has to answer both accessors
          insertData: function (key, results) { return results; },
          insertDataRef: function (key, results) { return results; },
          getData: function () { return []; },
          getDataRef: function () { return []; },
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
        debug: { logging: logging },
        settings: {
          isEnabled: function () { return false; },
          units: 'mg/dl'
        },
        extendedSettings: {}
      };
      const loader = dataloaderInit(env, ctx);
      const originalInfo = console.info;
      const originalDebug = console.debug;
      const logs = [];
      console.info = console.debug = function (...args) { logs.push(args); };

      loader.update(ddata, function (err) {
        console.info = originalInfo;
        console.debug = originalDebug;
        logs.length.should.equal(logging ? 1 : 0);
        if (logging) logs[0][0].should.equal('Load Complete:');
        should.not.exist(err);
        ddata.dbstats.should.eql({
          dataSize: 123,
          indexSize: 456
        });
        done();
      });
    });

  });

  describe('records with the same mills (BF-205)', function () {
    const mills = Date.now() - 10 * 60000;
    const at = new Date(mills).toISOString();
    const lower = { _id: '5f0000000000000000000001', eventType: 'Temp Basal', created_at: at, duration: 30, absolute: 0.5 };
    const higher = { _id: '5f0000000000000000000002', eventType: 'Temp Basal', created_at: at, duration: 30, absolute: 2 };
    const sensor = { _id: '5f0000000000000000000003', eventType: 'Sensor Start', created_at: at };
    const meal = { _id: '5f0000000000000000000004', eventType: 'Meal Bolus', created_at: at, insulin: 1 };

    // The main treatments query answers with the same documents in the
    // order given; the newest-of-type query answers with the Sensor Start.
    function load (order, callback) {
      const ddata = createDData();
      const empty = function (query, cb) { cb(null, []); };
      const ctx = {
        settings: {},
        bus: new (require('events').EventEmitter)(),
        language: { translate: function (value) { return value; } },
        ddata: ddata,
        entries: { list: empty },
        treatments: {
          list: function (query, cb) {
            const type = query.find && query.find.eventType;
            if (type && type.$eq === 'Sensor Start') return cb(null, [JSON.parse(JSON.stringify(sensor))]);
            if (type) return cb(null, []);
            cb(null, JSON.parse(JSON.stringify(order)));
          }
        },
        profile: { last: function (cb) { cb(null, []); } },
        food: { list: function (cb) { cb(null, []); } },
        devicestatus: { list: empty },
        activity: { list: empty },
        store: { db: { stats: function () { return Promise.resolve({ dataSize: 1, indexSize: 1 }); } } }
      };
      const env = {
        settings: { isEnabled: function () { return false; }, units: 'mg/dl' },
        extendedSettings: {}
      };
      ctx.cache = require('../lib/server/cache')(env, ctx);
      dataloaderInit(env, ctx).update(ddata, function (err) {
        // leave the loader's callback before asserting, so a failed
        // assertion reaches mocha instead of the loader
        setImmediate(callback, err, ddata);
      });
    }

    // Loads twice, in two query orders, and hands both results to check.
    function loadBoth (firstOrder, secondOrder, check, done) {
      load(firstOrder, function (err, first) {
        if (err) return done(err);
        load(secondOrder, function (err2, second) {
          if (err2) return done(err2);
          try {
            check(first, second);
            done();
          } catch (assertion) {
            done(assertion);
          }
        });
      });
    }

    it('come out in the same order whatever order the queries return them in', function (done) {
      loadBoth([lower, higher, sensor, meal], [meal, sensor, higher, lower], function (first, second) {
        first.treatments.should.have.length(4);
        first.treatments.map(function (t) { return t._id; })
          .should.eql(second.treatments.map(function (t) { return t._id; }));
      }, done);
    });

    it('keep the same temp basal of two at one time whatever the query order', function (done) {
      loadBoth([lower, higher], [higher, lower], function (first, second) {
        first.tempbasalTreatments.should.have.length(1);
        second.tempbasalTreatments.should.have.length(1);
        second.tempbasalTreatments[0]._id.should.equal(first.tempbasalTreatments[0]._id);
      }, done);
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
