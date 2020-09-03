'use strict';

const _ = require('lodash');
const async = require('async');
const times = require('../times');
const fitTreatmentsToBGCurve = require('./treatmenttocurve');
const constants = require('../constants');

function uniq(a) {
    var seen = {};
    return a.filter(function(item) {
        return Object.prototype.hasOwnProperty.call(seen, item.mills) ? false : (seen[item.mills] = true);
    });
}

function init(env, ctx) {

    var dataloader = {};

    dataloader.update = function update(ddata, opts, done) {

        //console.log("Database is connected: " + ctx.store.client.isConnected());

        if (opts && done == null && opts.call) {
            done = opts;
            opts = {
                lastUpdated: Date.now(),
                frame: false
            };
        }

        if (opts.frame) {
            ddata.page = {
                frame: true,
                after: opts.lastUpdated
                    // , before: opts.
            };
        }
        ddata.lastUpdated = opts.lastUpdated;
        // console.log('LOOKING SINCE', (new Date(ddata.lastUpdated)));

        let statusData = _.clone(ddata.devicestatus);
        const initialLoad = ddata.devicestatus.length > 0 ? false : true;

        const convertIds = (obj) => {
            Object.keys(obj).forEach(key => {
                if (typeof obj[key] === 'object' && obj[key]) {
                  if (obj[key].hasOwnProperty('_id')) {
                    obj[key]._id = obj[key]._id.toString();
                  }
                  convertIds(obj[key]);
                }
            });
        }

        function loadComplete(err, result) {

            // convert all IDs to strings, as these are not used after load

            convertIds(ddata);

            ddata.treatments = _.uniq(ddata.treatments, false, function(item) {
                return item._id;
            });

            //sort treatments so the last is the most recent
            ddata.treatments = _.sortBy(ddata.treatments, function(item) {
                return item.mills;
            });
            fitTreatmentsToBGCurve(ddata, env, ctx);
            if (err) {
                console.error(err);
            }
            ddata.processTreatments(true);

            var counts = [];
            _.forIn(ddata, function each(value, key) {
                if (_.isArray(value) && value.length > 0) {
                    counts.push(key + ':' + value.length);
                }
            });

            if (!initialLoad) {
                console.log('Merging device statuses', statusData.length, ddata.devicestatus.length);
                ddata.devicestatus = _.unionWith(statusData,ddata.devicestatus, function (a,b) {
                    return a._id == b._id;
                });
                console.log('Merging device statuses', statusData.length, ddata.devicestatus.length);
            }

            console.info('Load Complete:\n\t', counts.join(', '));

            done(err, result);
        }

        if (!initialLoad) {
            ddata.devicestatus = [];
        }
        
        // clear treatments, we're going to merge from more queries
        ddata.treatments = [];
        ddata.dbstats = {};

        async.parallel([
            loadEntries.bind(null, ddata, ctx)
            , loadTreatments.bind(null, ddata, ctx)
            , loadProfileSwitchTreatments.bind(null, ddata, ctx)
            , loadSensorAndInsulinTreatments.bind(null, ddata, ctx)
            , loadProfile.bind(null, ddata, ctx)
            , loadFood.bind(null, ddata, ctx)
            , loadDeviceStatus.bind(null, ddata, env, ctx, initialLoad)
            , loadActivity.bind(null, ddata, ctx)
            , loadDatabaseStats.bind(null, ddata, ctx)
        ], loadComplete);

    };

    return dataloader;

}

function loadEntries(ddata, ctx, callback) {
    var dateRange = {
        $gte: ddata.lastUpdated - constants.TWO_DAYS
    };
    if (ddata.page && ddata.page.frame) {
        dateRange['$lte'] = ddata.lastUpdated;
    }
    var q = {
        find: {
            date: dateRange
        },
        sort: {
            date: 1
        }
    };

    ctx.entries.list(q, function(err, results) {

        if (err) {
            console.log("Problem loading entries");
        }

        if (!err && results) {
            var mbgs = [];
            var sgvs = [];
            var cals = [];
            results.forEach(function(element) {
                if (element) {
                    if (element.mbg) {
                        mbgs.push({
                            mgdl: Number(element.mbg),
                            mills: element.date,
                            device: element.device
                        });
                    } else if (element.sgv) {
                        sgvs.push({
                            mgdl: Number(element.sgv),
                            mills: element.date,
                            device: element.device,
                            direction: element.direction,
                            filtered: element.filtered,
                            unfiltered: element.unfiltered,
                            noise: element.noise,
                            rssi: element.rssi
                        });
                    } else if (element.type === 'cal') {
                        cals.push({
                            mills: element.date,
                            scale: element.scale,
                            intercept: element.intercept,
                            slope: element.slope
                        });
                    }
                }
            });

            //stop using uniq for SGVs since we use buckets, also enables more detailed monitoring
            ddata.sgvs = sgvs;

            ddata.mbgs = uniq(mbgs);
            ddata.cals = uniq(cals);
        }
        callback();
    });
}

function mergeToTreatments(ddata, results) {
    var filtered = _.filter(results, function hasId(treatment) {
        return !_.isEmpty(treatment._id);
    });

    var treatments = _.map(filtered, function update(treatment) {
        treatment.mills = new Date(treatment.created_at).getTime();
        return treatment;
    });

    //filter out temps older than a day and an hour ago since we don't display them
    var oldestAgo = ddata.lastUpdated - constants.TWO_DAYS - times.hour().msecs;
    treatments = _.filter(treatments, function noOldTemps(treatment) {
        return !treatment.eventType || treatment.eventType.indexOf('Temp Basal') === -1 || treatment.mills > oldestAgo;
    });

    ddata.treatments = _.unionWith(ddata.treatments, treatments, function(a, b) {
        return a._id.toString() == b._id.toString();
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

            ddata.activity = uniq(activity);
        }
        callback();
    });
}

function loadTreatments(ddata, ctx, callback) {

    // Load 2.5 days to cover last 48 hours including overlapping temp boluses or temp targets
    var dateRange = {
        $gte: new Date(ddata.lastUpdated - (constants.ONE_DAY * 2.5)).toISOString()
    };
    if (ddata.page && ddata.page.frame) {
        dateRange['$lte'] = new Date(ddata.lastUpdated).toISOString();
    }
    var tq = {
        find: {
            created_at: dateRange
        },
        sort: {
            created_at: 1
        }
    };

    ctx.treatments.list(tq, function(err, results) {
        if (!err && results) {
            mergeToTreatments(ddata, results);
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
            mergeToTreatments(ddata, results);
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
    async.parallel([
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
        $gte: new Date(ddata.lastUpdated - (constants.ONE_DAY * 32)).toISOString()
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
            mergeToTreatments(ddata, results);
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

function loadDeviceStatus(ddata, env, ctx, initialLoad, callback) {

    let loadPeriod = constants.ONE_DAY;
    if(env.extendedSettings.devicestatus && env.extendedSettings.devicestatus.days && env.extendedSettings.devicestatus.days == 2) loadPeriod = constants.TWO_DAYS;

    if (initialLoad) {
        console.log('Loading first device status batch');
    } else {
        console.log('Loading device status update');
        loadPeriod = constants.FIFTEEN_MINUTES;
    }

    var dateRange = {
        $gte: new Date( ddata.lastUpdated - (loadPeriod) ).toISOString()
    };
    if (ddata.page && ddata.page.frame) {
        console.log('data.page.frame?', ddata.lastUpdated);
        dateRange['$lte'] = new Date(ddata.lastUpdated).toISOString();
    }
    var opts = {
        find: {
            created_at: dateRange
        },
        sort: {
            created_at: -1
        }
    };
/*
    if (env.extendedSettings.devicestatus && env.extendedSettings.devicestatus.advanced) {
        //not adding count: 1 restriction
    } else {
        opts.count = 1;
    }
*/
    ctx.devicestatus.list(opts, function(err, results) {
        if (!err && results) {
            ddata.devicestatus = _.map(results, function eachStatus(result) {
                result.mills = new Date(result.created_at).getTime();
                if ('uploaderBattery' in result) {
                    result.uploader = {
                        battery: result.uploaderBattery
                    };
                    delete result.uploaderBattery;
                }
                return result;
            }).reverse();
        } else {
            ddata.devicestatus = [];
        }
        callback();
    });
}

function loadDatabaseStats(ddata, ctx, callback) {
    ctx.store.db.stats(function mongoDone (err, result) {
        if (err) {
            console.log("Problem loading database stats");
        }
        if (!err && result) {
            ddata.dbstats = { 
                  dataSize:  result.dataSize
                , indexSize: result.indexSize
                , fileSize:  result.fileSize
            };
        }
        callback();
    });
}

module.exports = init;

