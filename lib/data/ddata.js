'use strict';


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
    // Deep clone the data using JSON operations - this data should be pure JSON without Date objects or functions
    let obj = JSON.parse(JSON.stringify(data));

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
        if (Object.prototype.hasOwnProperty.call(obj[key], 'durationInMilliseconds')
            && !Object.prototype.hasOwnProperty.call(obj[key], 'duration')) {
          var durationInMilliseconds = Number(obj[key].durationInMilliseconds) || 0;
          if (durationInMilliseconds > 0) {
            obj[key].duration = Math.round(durationInMilliseconds / 60000);
          }
        }
        if (!Object.prototype.hasOwnProperty.call(obj[key], 'endmills') || obj[key].endmills == null) {
          var baseMills = Number(obj[key].mills);
          if (Number.isFinite(baseMills)) {
            obj[key].mills = baseMills;
            if (Object.prototype.hasOwnProperty.call(obj[key], 'durationInMilliseconds')) {
              var endmillsDuration = Number(obj[key].durationInMilliseconds) || 0;
              if (endmillsDuration > 0) {
                obj[key].endmills = baseMills + endmillsDuration;
              }
            } else if (Object.prototype.hasOwnProperty.call(obj[key], 'duration')) {
              obj[key].endmills = baseMills + times.mins(Number(obj[key].duration) || 0).msecs;
            }
          }
        }
      }
    });

    return obj;
  };

  /**
   * Merge two arrays based on _id string, preferring new objects when a collision is found
   * This is used when combining data from different sources or updates to ensure:
   * - We keep the newest version of any duplicate records
   * - We preserve records that exist only in the old data
   * - We add all new records from the new data
   * @param {Array} oldData - Original array of objects with _id properties
   * @param {Array} newData - New array of objects with _id properties
   */
  ddata.idMergePreferNew = (oldData, newData) => {
    // Handle edge cases where one array is missing
    if (!newData && oldData) return oldData;
    if (!oldData && newData) return newData;    // Start with all new data (this ensures we get the newest version of any duplicates)
    // Deep clone using JSON operations since we're dealing with pure data objects
    const merged = JSON.parse(JSON.stringify(newData));

    // Look through old data for any records that don't exist in new data
    for (let i = 0; i < oldData.length; i++) {
      const oldElement = oldData[i];
      let found = false;
      // Check if this old record exists in the new data
      for (let j = 0; j < newData.length; j++) {
        if ((oldElement._id && oldElement._id == newData[j]._id)
            || (oldElement.identifier && oldElement.identifier === newData[j].identifier)) {
          found = true;
          break;
        }
      }
      // If old record wasn't found in new data, add it to preserve the record
      if (!found) merged.push(oldElement);
    }

    return merged;
  };

  // Special clone function that handles MongoDB ObjectIDs
  ddata.clone = function clone () {
    // Create a shallow clone of the ddata object
    const cloned = { ...ddata };

    // Handle special types like MongoDB ObjectIDs in the cloned object
    Object.keys(cloned).forEach(key => {
      const value = cloned[key];
      if (value && value.toHexString && value.toHexString.call && value.toString && value.toString.call) {
        // Convert MongoDB ObjectIDs to strings
        cloned[key] = value.toString();
      }
    });

    return cloned;
  };

  ddata.dataWithRecentStatuses = function dataWithRecentStatuses () {    var results = {};
    results.devicestatus = ddata.recentDeviceStatus(Date.now());
    results.sgvs = ddata.sgvs;
    results.cals = ddata.cals;

    // Deep clone profiles since we'll be modifying the structure
    var profiles = JSON.parse(JSON.stringify(ddata.profiles));
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
    // First, extract unique device-type pairs from the devicestatus entries
    // For example, if a device "pump1" has both "pump" and "loop" fields,
    // we'll create two entries: {device: "pump1", type: "pump"} and {device: "pump1", type: "loop"}
    var deviceAndTypes = ddata.devicestatus
      .map(function eachStatus (status) {
        return Object.keys(status)
          .filter(key => DEVICE_TYPE_FIELDS?.includes(key))
          .map(key => ({
            device: status.device,
            type: key
          }));
      })
      .flat()
      // Remove duplicate device-type combinations to prevent processing the same type multiple times
      .filter((item, index, self) =>
        index === self.findIndex(t =>
          t.device === item.device && t.type === item.type
        ));

    // For each unique device-type pair, find the 10 most recent status entries
    var rv = deviceAndTypes.map(function findMostRecent (deviceAndType) {
      return ddata.devicestatus
        // Match status entries for this specific device and type
        .filter(status => status.device === deviceAndType.device &&
          Object.prototype.hasOwnProperty.call(status, deviceAndType.type))
        // Only include entries up to the specified time
        .filter(status => status.mills <= time)
        // Sort by timestamp to get most recent
        .sort((a, b) => (a.mills || 0) - (b.mills || 0))
        // Take the last 10 entries
        .slice(-10);
    });

    // Flatten the array of arrays into a single array of status entries
    var merged = rv.flat();

    // Process the merged results:
    // 1. Ensure entries are valid objects
    // 2. Remove duplicates based on _id
    // 3. Sort by timestamp
    rv = merged
      .filter(item => typeof item === 'object' && item !== null)
      .filter((item, index, self) =>
        index === self.findIndex(t => t._id === item._id))
      .sort((a, b) => (a.mills || 0) - (b.mills || 0));

    return rv;
  };

  ddata.processDurations = function processDurations (treatments, keepzeroduration) {
    // Ensure treatments with same timestamp are only processed once
    treatments = treatments.filter((treatment, index, self) =>
      index === self.findIndex(t => t.mills === treatment.mills)
    );

    // Find all events that mark the end of a duration (events without a duration field)
    var endevents = treatments.filter(function filterEnd (t) {
      return !t.duration;
    });

    // Helper function to cut durations if they overlap with end events
    // For example: if a temp basal duration overlaps with a basal change,
    // cut the temp basal duration to end when the basal changes
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
      profileTreatments = JSON.parse(JSON.stringify(profileTreatments));
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
      tempbasalTreatments = JSON.parse(JSON.stringify(tempbasalTreatments));
    ddata.tempbasalTreatments = ddata.processDurations(tempbasalTreatments, false);

    // filter temp target
    var tempTargetTreatments = ddata.treatments.filter(function filterTargets (t) {
      return t.eventType && t.eventType.indexOf('Temporary Target') > -1;
    });

    function convertTempTargetTreatmentUnites (_treatments) {
      // Create deep copy to avoid modifying original treatments
      let treatments = JSON.parse(JSON.stringify(_treatments));

      for (let i = 0; i < treatments.length; i++) {
        let t = treatments[i];
        let converted = false;

        // Handle explicit mmol units
        // Convert blood glucose targets from mmol/L to mg/dL if specified in mmol
        if (Object.prototype.hasOwnProperty.call(t,'units')) {
          if (t.units == 'mmol') {
            //convert to mgdl using the constant conversion factor
            t.targetTop = t.targetTop * consts.MMOL_TO_MGDL;
            t.targetBottom = t.targetBottom * consts.MMOL_TO_MGDL;
            t.units = 'mg/dl';
            converted = true;
          }
        }

        // Safety check: if no units specified but values are in mmol range (below 20),
        // assume they're mmol/L and convert to mg/dL
        // This prevents dangerously low targets from incorrect unit assumptions
        if (!converted && (t.targetTop < 20 || t.targetBottom < 20)) {
          t.targetTop = t.targetTop * consts.MMOL_TO_MGDL;
          t.targetBottom = t.targetBottom * consts.MMOL_TO_MGDL;
          t.units = 'mg/dl';
        }
      }
      return treatments;
    }

    // Only clone treatments if we need to preserve the originals
    if (preserveOrignalTreatments)
      tempTargetTreatments = JSON.parse(JSON.stringify(tempTargetTreatments));
    // Convert units and process durations
    tempTargetTreatments = convertTempTargetTreatmentUnites(tempTargetTreatments);
    ddata.tempTargetTreatments = ddata.processDurations(tempTargetTreatments, false);

  };

  return ddata;

}

module.exports = init;
