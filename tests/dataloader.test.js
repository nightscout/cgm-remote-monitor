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

// BF-246: mergeProcessSort kept an old record unless a new record or an old
// record already kept had its _id, by walking the merged list for every old
// record, so each merge was quadratic in the records held. The merge is now
// linear where every id is a string. The loop as it was is kept here verbatim
// and both are run on the same random inputs.
describe('dataloader mergeProcessSort (BF-246)', function () {
  const assert = require('assert');
  const { mergeProcessSort } = dataloaderInit;

  function byMillsThenId (a, b) {
    const byMills = a.mills - b.mills;
    if (byMills) return byMills;
    const aId = String(a._id);
    const bId = String(b._id);
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  }

  // official/dev 79144cbd0 lib/data/dataloader.js, processForRuntime and
  // mergeProcessSort, unchanged apart from layout.
  function referenceMergeProcessSort (oldData, newData, ageLimit) {
    Object.keys(newData).forEach(key => {
      if (typeof newData[key] === 'object' && newData[key]) {
        if (Object.prototype.hasOwnProperty.call(newData[key], '_id') && newData[key]._id != null) {
          newData[key]._id = newData[key]._id.toString();
        }
        if (Object.prototype.hasOwnProperty.call(newData[key], 'created_at') && !Object.prototype.hasOwnProperty.call(newData[key], 'mills')) {
          newData[key].mills = new Date(newData[key].created_at).getTime();
        }
      }
    });
    const filtered = newData.filter(function hasId (object) {
      const hasId = object._id != null;
      const isFresh = (ageLimit && object.mills >= ageLimit) || (!ageLimit);
      return isFresh && hasId;
    });
    let merged;
    if (oldData && filtered) {
      merged = filtered;
      for (let i = 0; i < oldData.length; i++) {
        const oldElement = oldData?.[i];
        let found = false;
        for (let j = 0; j < filtered.length; j++) {
          if (oldElement?._id == filtered[j]._id) {
            found = true;
            break;
          }
        }
        if (!found) merged.push(oldElement);
      }
    } else {
      merged = filtered;
    }
    return merged.sort(byMillsThenId);
  }

  // A seeded generator, so a failure names a reproducible case.
  function seeded (seed) {
    return function () {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
  }

  function outcome (fn) {
    try {
      return { value: fn() };
    } catch (error) {
      return { error: error.constructor.name };
    }
  }

  it('keeps the records the loop kept, in its order, over repeated, numeric, missing and null ids and an age limit', function () {
    const random = seeded(246);
    const stringIds = ['a', 'b', 'c', 'd', 'e', '1'];
    const anyIds = stringIds.concat([1, 2, null, undefined]);
    function record (k, stringOnly) {
      const ids = stringOnly ? stringIds : anyIds;
      const id = ids[Math.floor(random() * ids.length)];
      const out = { k: k, mills: Math.floor(random() * 4) };
      // An undefined id is either absent or present as undefined.
      if (id !== undefined || random() < 0.5) out._id = id;
      if (random() < 0.2) {
        delete out.mills;
        out.created_at = new Date(Math.floor(random() * 4)).toISOString();
      }
      return out;
    }
    let linear = 0;
    let loop = 0;
    let errors = 0;
    let dropped = 0;
    for (let i = 0; i < 4000; i++) {
      const stringOnly = i % 2 === 0;
      let k = 0;
      const old = Array.from({ length: Math.floor(random() * 12) }, () => (stringOnly || random() > 0.05 ? record(k++, stringOnly) : null));
      const fresh = Array.from({ length: Math.floor(random() * 5) }, () => record(k++, stringOnly));
      const ageLimit = random() < 0.2 ? 2 : undefined;
      const oldArg = random() < 0.05 ? undefined : old;
      const expected = outcome(() => referenceMergeProcessSort(oldArg && structuredClone(oldArg), structuredClone(fresh), ageLimit));
      const actual = outcome(() => mergeProcessSort(oldArg && structuredClone(oldArg), structuredClone(fresh), ageLimit));
      assert.deepStrictEqual(actual, expected, 'case ' + i);
      if (expected.error) errors += 1;
      else if (expected.value.length < (oldArg ? oldArg.length : 0) + fresh.length) dropped += 1;
      if (stringOnly && oldArg) linear += 1;
      else if (oldArg) loop += 1;
    }
    // Both paths ran, records were dropped as duplicates, and the loop's own
    // failures (a missing old record reaching the sort) were reproduced.
    assert.ok(linear > 1500 && loop > 1500 && dropped > 1000 && errors > 0,
      'linear ' + linear + ', loop ' + loop + ', dropped ' + dropped + ', errors ' + errors);
  });

  it('prefers the new record and keeps the first of repeated old ids', function () {
    const old = [
      { _id: 'a', mills: 1, k: 'old a' },
      { _id: 'b', mills: 2, k: 'old b 1' },
      { _id: 'b', mills: 2, k: 'old b 2' },
      { _id: 'c', mills: 3, k: 'old c' }
    ];
    const merged = mergeProcessSort(old, [{ _id: 'c', mills: 3, k: 'new c' }]);
    assert.deepStrictEqual(merged.map(r => r.k), ['old a', 'old b 1', 'new c']);
  });

  it('reads each old id a bounded number of times where every id is a string', function () {
    // The loop compared every old record with every record already kept:
    // about n^2 / 2 reads of _id. The set reads each id a fixed number of times.
    const n = 2000;
    let reads = 0;
    const old = Array.from({ length: n }, (_, i) => {
      const id = 'o' + String(i).padStart(5, '0');
      return Object.defineProperty({ mills: i }, '_id', {
        enumerable: true,
        get () { reads += 1; return id; }
      });
    });
    const merged = mergeProcessSort(old, [{ _id: 'o00005', mills: 5, k: 'new' }]);
    assert.strictEqual(merged.length, n);
    assert.strictEqual(merged[5].k, 'new');
    const merging = reads;
    assert.ok(merging <= 3 * n, 'reads of an old _id while merging: ' + merging + ' for ' + n + ' records');
  });
});
