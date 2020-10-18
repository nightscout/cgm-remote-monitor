'use strict';

var _ = require('lodash');
var times = require('../times');
var consts = require('../constants');

var DEVICE_TYPE_FIELDS = ['uploader', 'pump', 'openaps', 'loop', 'xdripjs'];

function init () {

  var ddata = {
    sgvs: []
    , treatments: []
    , mbgs: []
    , cals: []
    , profiles: []
    , devicestatus: []
    , food: []
    , activity: []
    , dbstats: {}
    , lastUpdated: 0
  };

  /**
   * Convert Mongo ids to strings and ensure all objects have the mills property for
   * significantly faster processing than constant date parsing, plus simplified
   * logic
   */
  ddata.processRawDataForRuntime = (data) => {

    let obj = _.cloneDeep(data);

    Object.keys(obj).forEach(key => {
      if (typeof obj[key] === 'object' && obj[key]) {
        if (Object.prototype.hasOwnProperty.call(obj[key], '_id')) {
          obj[key]._id = obj[key]._id.toString();
        }
        if (Object.prototype.hasOwnProperty.call(obj[key], 'created_at')
            && !Object.prototype.hasOwnProperty.call(obj[key], 'mills')) {
          obj[key].mills = new Date(obj[key].created_at).getTime();
        }
        if (Object.prototype.hasOwnProperty.call(obj[key], 'sysTime')
            && !Object.prototype.hasOwnProperty.call(obj[key], 'mills')) {       
          obj[key].mills = new Date(obj[key].sysTime).getTime();
        }
      }
    });

    return obj;
  };

  /**
   * Merge two arrays based on _id string, preferring new objects when a collision is found
   * @param {array} oldData 
   * @param {array} newData 
   */
  ddata.idMergePreferNew = (oldData, newData) => {

    if (!newData && oldData) return oldData;
    if (!oldData && newData) return newData;

    const merged = _.cloneDeep(newData);

    for (let i = 0; i < oldData.length; i++) {
      const oldElement = oldData[i];
      let found = false;
      for (let j = 0; j < newData.length; j++) {
        if (oldElement._id == newData[j]._id) {
          found = true;
          break;
        }
      }
      if (!found) merged.push(oldElement); // Merge old object in, if it wasn't found in the new data
    }

    return merged;
  };

  ddata.clone = function clone () {
    return _.clone(ddata, function(value) {
      //special handling of mongo ObjectID's
      //see https://github.com/lodash/lodash/issues/602#issuecomment-47414964

      //instead of requiring Mongo.ObjectID here and having it get pulled into the bundle
      //we'll look for the toHexString function and then assume it's an ObjectID
      if (value && value.toHexString && value.toHexString.call && value.toString && value.toString.call) {
        return value.toString();
      }
    });
  };

  ddata.dataWithRecentStatuses = function dataWithRecentStatuses () {
    var results = {};
    results.devicestatus = ddata.recentDeviceStatus(Date.now());
    results.sgvs = ddata.sgvs;
    results.cals = ddata.cals;

    var profiles = _.cloneDeep(ddata.profiles);
    if (profiles && profiles[0] && profiles[0].store) {
      Object.keys(profiles[0].store).forEach(k => {
        if (k.indexOf('@@@@@') > 0) {
          delete profiles[0].store[k];
        }
      })
    }
    results.profiles = profiles;
    results.mbgs = ddata.mbgs;
    results.food = ddata.food;
    results.treatments = ddata.treatments;
    results.dbstats = ddata.dbstats;

    return results;
  }

  ddata.recentDeviceStatus = function recentDeviceStatus (time) {

    var deviceAndTypes =
      _.chain(ddata.devicestatus)
      .map(function eachStatus (status) {
        return _.chain(status)
          .keys()
          .filter(function isExcluded (key) {
            return _.includes(DEVICE_TYPE_FIELDS, key);
          })
          .map(function toDeviceTypeKey (key) {
            return {
              device: status.device
              , type: key
            };
          })
          .value();
      })
      .flatten()
      .uniqWith(_.isEqual)
      .value();

    //console.info('>>>deviceAndTypes', deviceAndTypes);

    var rv = _.chain(deviceAndTypes)
      .map(function findMostRecent (deviceAndType) {
        return _.chain(ddata.devicestatus)
          .filter(function isSameDeviceType (status) {
            return status.device === deviceAndType.device && _.has(status, deviceAndType.type)
          })
          .filter(function notInTheFuture (status) {
            return status.mills <= time;
          })
          .sortBy('mills')
          .takeRight(10)
          .value();
      }).value();

    var merged = [].concat.apply([], rv);

    rv = _.chain(merged)
      .filter(_.isObject)
      .uniq('_id')
      .sortBy('mills')
      .value();

    return rv;

  };

  ddata.processDurations = function processDurations (treatments, keepzeroduration) {

    treatments = _.uniqBy(treatments, 'mills');

    // cut temp basals by end events
    // better to do it only on data update
    var endevents = treatments.filter(function filterEnd (t) {
      return !t.duration;
    });

    function cutIfInInterval (base, end) {
      if (base.mills < end.mills && base.mills + times.mins(base.duration).msecs > end.mills) {
        base.duration = times.msecs(end.mills - base.mills).mins;
        if (end.profile) {
          base.cuttedby = end.profile;
          end.cutting = base.profile;
        }
      }
    }

    // cut by end events
    treatments.forEach(function allTreatments (t) {
      if (t.duration) {
        endevents.forEach(function allEndevents (e) {
          cutIfInInterval(t, e);
        });
      }
    });

    // cut by overlaping events
    treatments.forEach(function allTreatments (t) {
      if (t.duration) {
        treatments.forEach(function allEndevents (e) {
          cutIfInInterval(t, e);
        });
      }
    });

    if (keepzeroduration) {
      return treatments;
    } else {
      return treatments.filter(function filterEnd (t) {
        return t.duration;
      });
    }
  };

  ddata.processTreatments = function processTreatments (preserveOrignalTreatments) {

    // filter & prepare 'Site Change' events
    ddata.sitechangeTreatments = ddata.treatments.filter(function filterSensor (t) {
      return t.eventType.indexOf('Site Change') > -1;
    }).sort(function(a, b) {
      return a.mills > b.mills;
    });

    // filter & prepare 'Insulin Change' events
    ddata.insulinchangeTreatments = ddata.treatments.filter(function filterInsulin (t) {
      return t.eventType.indexOf('Insulin Change') > -1;
    }).sort(function(a, b) {
      return a.mills > b.mills;
    });

    // filter & prepare 'Pump Battery Change' events
    ddata.batteryTreatments = ddata.treatments.filter(function filterSensor (t) {
      return t.eventType.indexOf('Pump Battery Change') > -1;
    }).sort(function(a, b) {
      return a.mills > b.mills;
    });

    // filter & prepare 'Sensor' events
    ddata.sensorTreatments = ddata.treatments.filter(function filterSensor (t) {
      return t.eventType.indexOf('Sensor') > -1;
    }).sort(function(a, b) {
      return a.mills > b.mills;
    });

    // filter & prepare 'Profile Switch' events
    var profileTreatments = ddata.treatments.filter(function filterProfiles (t) {
      return t.eventType === 'Profile Switch';
    }).sort(function(a, b) {
      return a.mills > b.mills;
    });
    if (preserveOrignalTreatments)
      profileTreatments = _.cloneDeep(profileTreatments);
    ddata.profileTreatments = ddata.processDurations(profileTreatments, true);

    // filter & prepare 'Combo Bolus' events
    ddata.combobolusTreatments = ddata.treatments.filter(function filterComboBoluses (t) {
      return t.eventType === 'Combo Bolus';
    }).sort(function(a, b) {
      return a.mills > b.mills;
    });

    // filter & prepare temp basals
    var tempbasalTreatments = ddata.treatments.filter(function filterBasals (t) {
      return t.eventType && t.eventType.indexOf('Temp Basal') > -1;
    });
    if (preserveOrignalTreatments)
      tempbasalTreatments = _.cloneDeep(tempbasalTreatments);
    ddata.tempbasalTreatments = ddata.processDurations(tempbasalTreatments, false);

    // filter temp target
    var tempTargetTreatments = ddata.treatments.filter(function filterTargets (t) {
      //check for a units being sent
      if (t.units) {
        if (t.units == 'mmol') {
          //convert to mgdl
          t.targetTop = t.targetTop * consts.MMOL_TO_MGDL;
          t.targetBottom = t.targetBottom * consts.MMOL_TO_MGDL;
          t.units = 'mg/dl';
        }
      }
      //if we have a temp target thats below 20, assume its mmol and convert to mgdl for safety.
      if (t.targetTop < 20) {
        t.targetTop = t.targetTop * consts.MMOL_TO_MGDL;
        t.units = 'mg/dl';
      }
      if (t.targetBottom < 20) {
        t.targetBottom = t.targetBottom * consts.MMOL_TO_MGDL;
        t.units = 'mg/dl';
      }
      return t.eventType && t.eventType.indexOf('Temporary Target') > -1;
    });
    if (preserveOrignalTreatments)
      tempTargetTreatments = _.cloneDeep(tempTargetTreatments);
    ddata.tempTargetTreatments = ddata.processDurations(tempTargetTreatments, false);

  };

  return ddata;

}

module.exports = init;
