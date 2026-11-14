'use strict';

const tasks = require('../utils/callback-tasks');
const fitTreatmentsToBGCurve = require('./treatmenttocurve');
const constants = require('../constants');

// Oldest first; records with the same mills in _id order, so the order does
// not depend on which of the parallel queries finished first (BF-205).
function byMillsThenId(a, b) {
    const byMills = a.mills - b.mills;
    if (byMills) return byMills;
    const aId = String(a._id);
    const bId = String(b._id);
    return aId < bId ? -1 : aId > bId ? 1 : 0;
}

function uniqBasedOnMills(a) {
    var seen = {};
    return a.filter(function(item) {
        return Object.prototype.hasOwnProperty.call(seen, item.mills) ? false : (seen[item.mills] = true);
    });
}

const processForRuntime = (obj) => {
    Object.keys(obj).forEach(key => {
        if (typeof obj[key] === 'object' && obj[key]) {
          if (Object.prototype.hasOwnProperty.call(obj[key], '_id') && obj[key]._id != null) {
            obj[key]._id = obj[key]._id.toString();
          }
          if (Object.prototype.hasOwnProperty.call(obj[key], 'created_at') && !Object.prototype.hasOwnProperty.call(obj[key], 'mills')) {
            obj[key].mills = new Date(obj[key].created_at).getTime();
          }
        }
    });
}

function mergeProcessSort(oldData, newData, ageLimit) {
  processForRuntime(newData);

  var filtered = newData.filter(function hasId(object) {
    const hasId = object._id != null;
    const isFresh = (ageLimit && object.mills >= ageLimit) || (!ageLimit);
    return isFresh && hasId;
  });

  // Merge old and new data, preferring the new objects

  let merged;
  if (oldData && filtered) {
    merged = filtered; // Start with the new / updated data
    for (let i = 0; i < oldData.length; i++) {
        const oldElement = oldData?.[i];
        let found = false;
        for (let j = 0; j < filtered.length; j++) {
            if (oldElement?._id == filtered[j]._id) {
                found = true;
                break;
            }
        }
        if (!found) merged.push(oldElement); // Merge old object in, if it wasn't found in the new data
    }
  } else {
      merged = filtered;
  }
  return merged.sort(byMillsThenId);

}

// The longest look-back any loader below takes from ddata.lastUpdated
// (loadProfileSwitchTreatments). A time whose window falls outside the range
// a Date can hold cannot be turned into a query.
const LONGEST_LOOKBACK = constants.ONE_DAY * 31 * 12;

function isLoadableTime(time) {
    return !isNaN(new Date(time).getTime()) && !isNaN(new Date(time - LONGEST_LOOKBACK).getTime());
}

function init(env, ctx) {

    var dataloader = {};

    dataloader.update = function update(ddata, opts, done) {

        if (opts && done == null && opts.call) {
            done = opts;
            opts = {
                lastUpdated: Date.now(),
                frame: false
            };
        }

        if (!isLoadableTime(opts.lastUpdated)) {
            return done(new Error('dataloader: lastUpdated is not a loadable time: ' + opts.lastUpdated));
        }

        if (opts.frame) {
            ddata.page = {
                frame: true,
                after: opts.lastUpdated
                    // , before: opts.
            };
        }
        ddata.lastUpdated = opts.lastUpdated;

        const normalizeTreatments = (obj) => {
            Object.keys(obj).forEach(key => {
                if (typeof obj[key] === 'object' && obj[key]) {
                    const element = obj[key];
                  if (Object.prototype.hasOwnProperty.call(element, '_id') && element._id != null) {
                    element._id = element._id.toString();
                  }
                  if (Object.prototype.hasOwnProperty.call(element, 'amount') && !Object.prototype.hasOwnProperty.call(element, 'absolute')) {
                      element.absolute = Number(element.amount);
                  }
                  normalizeTreatments(obj[key]);
                }
            });
        }

        function loadComplete(err, result) {

            // convert all IDs to strings, as these are not used after load

            normalizeTreatments(ddata);

            ddata.treatments = [...new Set(ddata.treatments, false, function(item) {
                return item._id;
            })];

            //sort treatments so the last is the most recent
            ddata.treatments = ddata.treatments.sort(byMillsThenId);

            fitTreatmentsToBGCurve(ddata, env, ctx);
            if (err) {
                console.error(err);
            }
            ddata.processTreatments(true);

            if (env.debug && env.debug.logging) {
                var counts = [];
                Object.entries(ddata).forEach(([key, value]) => {
                    if (Array.isArray(value) && value.length > 0) {
                        counts.push(key + ':' + value.length);
                    }
                });
                console.debug('Load Complete:', counts.join(', '));
            }
            done(err, result);
        }

        // clear data we'll get from the cache

        ddata.treatments = [];
        ddata.devicestatus = [];
        ddata.entries = [];

        ddata.dbstats = {};

        tasks.parallel([
            loadEntries.bind(null, ddata, ctx)
            , loadTreatments.bind(null, ddata, ctx)
            , loadProfileSwitchTreatments.bind(null, ddata, ctx)
            , loadSensorAndInsulinTreatments.bind(null, ddata, ctx)
            , loadProfile.bind(null, ddata, ctx)
            , loadFood.bind(null, ddata, ctx)
            , loadDeviceStatus.bind(null, ddata, env, ctx)
            , loadActivity.bind(null, ddata, ctx)
            , loadDatabaseStats.bind(null, ddata, ctx)
        ], loadComplete);

    };

    return dataloader;

}

// One query definition serves resident loading and private raw caches. Raw
// readers keep the same window/order without computing unused clinical arrays.
function rawQuery (logical, ddata, ctx, env) {
    const framed = ddata.page && ddata.page.frame;
    let longLoad;
    if (logical === 'entries') longLoad = Math.round(constants.TWO_DAYS);
    else if (logical === 'treatments') longLoad = Math.round(constants.ONE_DAY * 2.5);
    else if (logical === 'devicestatus') longLoad = env.extendedSettings.devicestatus &&
        env.extendedSettings.devicestatus.days && env.extendedSettings.devicestatus.days == 2 ? constants.TWO_DAYS : constants.ONE_DAY;
    else throw new TypeError('No raw cache query for domain');
    const span = ctx.cache.isEmpty(logical) || framed ? longLoad : constants.FIFTEEN_MINUTES;
    const stamp = value => logical === 'entries' ? value : new Date(value).toISOString();
    const range = { $gte: stamp(ddata.lastUpdated - span) };
    if (framed) range.$lte = stamp(ddata.lastUpdated);
    const field = logical === 'entries' ? 'date' : 'created_at';
    return { find: { [field]: range }, sort: { [field]: logical === 'devicestatus' ? -1 : 1 } };
}

function loadEntries(ddata, ctx, callback, attempt) {

    attempt = attempt || 0;
    const withFrame = ddata.page && ddata.page.frame;
    const cacheGeneration = ctx.cache.getRemovalGeneration('entries');
    const q = rawQuery('entries', ddata, ctx);

    var obscureDeviceProvenance = ctx.settings.obscureDeviceProvenance;
    ctx.entries.list(q, function(err, results) {

        if (err) {
            console.log("Problem loading entries");
        }

        if (!err && results) {

            // a removal invalidated the cache while the query was in flight;
            // the results may contain deleted documents, so reload instead of
            // merging them into the cache
            if (!withFrame && ctx.cache.getRemovalGeneration('entries') !== cacheGeneration && attempt < 2) {
                return loadEntries(ddata, ctx, callback, attempt + 1);
            }

            const r = ctx.ddata.processRawDataForRuntime(results);
            // The loop below reads each document and builds a new one from it;
            // it never writes to what it reads, so it does not need copies.
            // A framed load answers from its own query: the cache holds the
            // live window, counted from now, not the frame (BF-204).
            let currentData;
            if (withFrame) {
                currentData = r;
            } else {
                currentData = ctx.cache.getRemovalGeneration('entries') !== cacheGeneration
                    ? ctx.cache.getDataRef('entries').reverse()
                    : ctx.cache.insertDataRef('entries', r).reverse();
            }

            const mbgs = [];
            const sgvs = [];
            const cals = [];

            currentData.forEach(function(element) {
                if (element) {
                    if (element.mbg) {
                        mbgs.push({
                            _id: element._id,
                            mgdl: Number(element.mbg),
                            mills: element.date,
                            device: obscureDeviceProvenance || element.device,
                            type: 'mbg'
                        });
                    } else if (element.sgv) {
                        sgvs.push({
                            _id: element._id,
                            mgdl: Number(element.sgv),
                            mills: element.date,
                            device: obscureDeviceProvenance || element.device,
                            direction: element.direction,
                            filtered: element.filtered,
                            unfiltered: element.unfiltered,
                            noise: element.noise,
                            rssi: element.rssi,
                            type: 'sgv'
                        });
                    } else if (element.type === 'cal') {
                        cals.push({
                            _id: element._id,
                            mills: element.date,
                            scale: element.scale,
                            intercept: element.intercept,
                            slope: element.slope,
                            type: 'cal'
                        });
                    }
                }
            });

            ddata.sgvs = sgvs;
            ddata.mbgs = mbgs;
            ddata.cals = cals;
        }
        callback();
    });
}

function loadActivity(ddata, ctx, callback) {
    var dateRange = {
        $gte: new Date(ddata.lastUpdated - (constants.ONE_DAY * 2)).toISOString()
    };
    if (ddata.page && ddata.page.frame) {
        dateRange['$lte'] = new Date(ddata.lastUpdated).toISOString();
    }

    var q = {
        find: {
            created_at: dateRange
        },
        sort: {
            created_at: 1
        }
    };

    ctx.activity.list(q, function(err, results) {

        if (err) {
            console.log("Problem loading activity data");
        }

        if (!err && results) {
            var activity = [];
            results.forEach(function(element) {
                if (element) {
                    if (element.created_at) {
                        var d = new Date(element.created_at);
                        activity.push({
                            mills: d,
                            heartrate: element.heartrate,
                            steps: element.steps,
                            activitylevel: element.activitylevel
                        });
                    }
                }
            });

            ddata.activity = uniqBasedOnMills(activity);
        }
        callback();
    });
}

function loadTreatments(ddata, ctx, callback, attempt) {

    attempt = attempt || 0;
    const withFrame = ddata.page && ddata.page.frame;
    const cacheGeneration = ctx.cache.getRemovalGeneration('treatments');
    const tq = rawQuery('treatments', ddata, ctx);

    ctx.treatments.list(tq, function(err, results) {
        if (!err && results) {

            // a removal invalidated the cache while the query was in flight;
            // the results may contain deleted documents, so reload instead of
            // merging them into the cache
            if (!withFrame && ctx.cache.getRemovalGeneration('treatments') !== cacheGeneration && attempt < 2) {
                return loadTreatments(ddata, ctx, callback, attempt + 1);
            }

            // update cache and apply to runtime data
            const r = ctx.ddata.processRawDataForRuntime(results);
            // idMergePreferNew deep-clones what it is given and does not write
            // to it, so this caller does not need copies either.
            // A framed load answers from its own query (BF-204).
            let currentData;
            if (withFrame) {
                currentData = r;
            } else {
                currentData = ctx.cache.getRemovalGeneration('treatments') !== cacheGeneration
                    ? ctx.cache.getDataRef('treatments')
                    : ctx.cache.insertDataRef('treatments', r);
            }
            ddata.treatments = ctx.ddata.idMergePreferNew(ddata.treatments, currentData);
        }

        callback();
    });
}

function loadProfileSwitchTreatments(ddata, ctx, callback) {
    var dateRange = {
        $gte: new Date(ddata.lastUpdated - (constants.ONE_DAY * 31 * 12)).toISOString()
    };

    if (ddata.page && ddata.page.frame) {
        dateRange['$lte'] = new Date(ddata.lastUpdated).toISOString();
    }

    // Load the latest profile switch treatment
    var tq = {
        find: {
            eventType: 'Profile Switch',
            created_at: dateRange,
            duration: 0
        },
        sort: {
            created_at: -1
        },
        count: 1
    };

    ctx.treatments.list(tq, function(err, results) {
        if (!err && results) {
            ddata.treatments = mergeProcessSort(ddata.treatments, results);
        }

        // Store last profile switch
        if (results) {
            ddata.lastProfileFromSwitch = null;
            var now = new Date().getTime();
            for (var p = 0; p < results.length; p++) {
                var pdate = new Date(results[p].created_at).getTime();
                if (pdate < now) {
                    ddata.lastProfileFromSwitch = results[p].profile;
                    break;
                }
            }
        }

        callback();
    });
}

function loadSensorAndInsulinTreatments(ddata, ctx, callback) {
    tasks.parallel([
        loadLatestSingle.bind(null, ddata, ctx, 'Sensor Start')
        ,loadLatestSingle.bind(null, ddata, ctx, 'Sensor Change')
        ,loadLatestSingle.bind(null, ddata, ctx, 'Sensor Stop')
        ,loadLatestSingle.bind(null, ddata, ctx, 'Site Change')
        ,loadLatestSingle.bind(null, ddata, ctx, 'Insulin Change')
        ,loadLatestSingle.bind(null, ddata, ctx, 'Pump Battery Change')
    ], callback);
}

function loadLatestSingle(ddata, ctx, dataType, callback) {

    var dateRange = {
        $gte: new Date(ddata.lastUpdated - (constants.ONE_DAY * 62)).toISOString()
    };

    if (ddata.page && ddata.page.frame) {
        dateRange['$lte'] = new Date(ddata.lastUpdated).toISOString();
    }

    var tq = {
        find: {
            eventType: {
                $eq: dataType
            },
            created_at: dateRange
        },
        sort: {
            created_at: -1
        },
        count: 1
    };

    ctx.treatments.list(tq, function(err, results) {
        if (!err && results) {
            ddata.treatments = mergeProcessSort(ddata.treatments, results);
        }
        callback();
    });
}

function loadProfile(ddata, ctx, callback) {
    ctx.profile.last(function(err, results) {
        if (!err && results) {
            var profiles = [];
            results.forEach(function(element) {
                if (element) {
                    profiles[0] = element;
                }
            });
            ddata.profiles = profiles;
        }
        callback();
    });
}

function loadFood(ddata, ctx, callback) {
    ctx.food.list(function(err, results) {
        if (!err && results) {
            ddata.food = results;
        }
        callback();
    });
}

function loadDeviceStatus(ddata, env, ctx, callback, attempt) {

    attempt = attempt || 0;
    const withFrame = ddata.page && ddata.page.frame;
    const cacheGeneration = ctx.cache.getRemovalGeneration('devicestatus');
    const opts = rawQuery('devicestatus', ddata, ctx, env);

    ctx.devicestatus.list(opts, function(err, results) {
        if (!err && results) {

            // a removal invalidated the cache while the query was in flight;
            // the results may contain deleted documents, so reload instead of
            // merging them into the cache
            if (!withFrame && ctx.cache.getRemovalGeneration('devicestatus') !== cacheGeneration && attempt < 2) {
                return loadDeviceStatus(ddata, env, ctx, callback, attempt + 1);
            }

            // update cache and apply to runtime data
            const r = ctx.ddata.processRawDataForRuntime(results);
            // eachStatus below rewrites uploaderBattery into uploader, and
            // mergeProcessSort writes _id and mills, on documents that then stay
            // in ddata for the life of the process. This caller needs copies.
            // A framed load answers from its own query, whose documents
            // nothing else holds (BF-204).
            let currentData;
            if (withFrame) {
                currentData = r;
            } else {
                currentData = ctx.cache.getRemovalGeneration('devicestatus') !== cacheGeneration
                    ? ctx.cache.getData('devicestatus')
                    : ctx.cache.insertData('devicestatus', r);
            }
            const res2 = currentData.map(function eachStatus(result) {
                if ('uploaderBattery' in result) {
                    result.uploader = {
                        battery: result.uploaderBattery
                    };
                    delete result.uploaderBattery;
                }
                return result;
            });

            ddata.devicestatus = mergeProcessSort(ddata.devicestatus, res2);
        } else {
            ddata.devicestatus = [];
        }
        callback();
    });
}

function loadDatabaseStats(ddata, ctx, callback) {
    Promise.resolve()
      .then(function () {
        return ctx.store.db.stats();
      })
      .then(function (result) {
        if (result) {
          ddata.dbstats = {
            dataSize: result.dataSize,
            indexSize: result.indexSize
          };
        }
      })
      .catch(function (err) {
        console.log("Problem loading database stats");
        if (err) {
          console.error(err);
        }
      })
      .finally(function () {
        callback();
      });
}

module.exports = init;
// Request-local raw cached reads use the same framed windows, ordering and
// normalization as the full clinical loader, without reading other domains.
module.exports.rawQuery = rawQuery;
