'use strict';

var _ = require('lodash');
var times = require('../times');

var DEVICE_TYPE_FIELDS = ['uploader', 'pump', 'openaps', 'loop'];

function init( ) {

  var ddata = {
    sgvs: []
    , treatments: []
    , mbgs: []
    , cals: []
    , profiles: []
    , devicestatus: []
    , lastUpdated: 0
  };

  ddata.clone = function clone() {
    return _.clone(ddata, function (value) {
      //special handling of mongo ObjectID's
      //see https://github.com/lodash/lodash/issues/602#issuecomment-47414964

      //instead of requiring Mongo.ObjectID here and having it get pulled into the bundle
      //we'll look for the toHexString function and then assume it's an ObjectID
      if (value && value.toHexString && value.toHexString.call && value.toString && value.toString.call) {
        return value.toString();
      }
    });
  };

  ddata.splitRecent = function splitRecent (time, cutoff, max, treatmentsToo) {
    var result = {
      first: { }
      , rest: { }
    };
    
    function recent (item) {
      return item.mills >= time - cutoff;
    }

    function filterMax(item) {
      return item.mills >= time - max;
    }
      
    function partition (field, filter) {
      var data;
      if (filter) {
        data = ddata[field].filter(filterMax);
      } else {
        data = ddata[field];
      }
      
      var parts = _.partition(data, recent);
      result.first[field] = parts[0];
      result.rest[field] = parts[1];
    }

    partition('treatments', treatmentsToo ? filterMax : false);

    result.first.devicestatus = ddata.recentDeviceStatus(time);

    result.first.sgvs = ddata.sgvs.filter(filterMax);
    result.first.cals = ddata.cals;
    result.first.profiles = ddata.profiles;

    result.rest.mbgs = ddata.mbgs.filter(filterMax);

     console.log('results.first size', JSON.stringify(result.first).length,'bytes');
     console.log('results.rest size', JSON.stringify(result.rest).length,'bytes');

    return result;
  };

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

    return _.chain(deviceAndTypes)
      .map(function findMostRecent (deviceAndType) {
         return _.chain(ddata.devicestatus)
            .filter(function isSameDeviceType (status) {
              return status.device === deviceAndType.device && _.has(status, deviceAndType.type)
            })
            .filter(function notInTheFuture (status) {
              return status.mills <= time;
            })
            .maxBy('mills')
            .value();
      })
      .filter(_.isObject)
      .uniq('_id')
      .sortBy('mills')
      .value();

  };
  
  ddata.processDurations = function processDurations (treatments, keepzeroduration) {

    treatments = _.uniqBy(treatments, 'mills');

    // cut temp basals by end events
    // better to do it only on data update
      var endevents = treatments.filter(function filterEnd(t) {
          return !t.duration;
      });

    function cutIfInInterval (base, end) {
      if (base.mills < end.mills && base.mills + times.mins(base.duration).msecs > end.mills) {
        base.duration = times.msecs(end.mills-base.mills).mins;
        if (end.profile)  {
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
        return treatments.filter(function filterEnd(t) {
            return t.duration;
        });
    }
  };

  ddata.processTreatments = function processTreatments (preserveOrignalTreatments ) {

    // filter & prepare 'Site Change' events
    ddata.sitechangeTreatments = ddata.treatments.filter( function filterSensor (t) {
      return t.eventType.indexOf('Site Change') > -1;
    }).sort(function (a,b) { return a.mills > b.mills; });

    // filter & prepare 'Insulin Change' events
    ddata.insulinchangeTreatments = ddata.treatments.filter( function filterInsulin (t) {
      return t.eventType.indexOf('Insulin Change') > -1;
    }).sort(function (a,b) { return a.mills > b.mills; });

    // filter & prepare 'Sensor' events
    ddata.sensorTreatments = ddata.treatments.filter( function filterSensor (t) {
      return t.eventType.indexOf('Sensor') > -1;
    }).sort(function (a,b) { return a.mills > b.mills; });

    // filter & prepare 'Profile Switch' events
    var profileTreatments = ddata.treatments.filter( function filterProfiles (t) {
      return t.eventType === 'Profile Switch';
    }).sort(function (a,b) { return a.mills > b.mills; });
    if (preserveOrignalTreatments)
      profileTreatments = _.cloneDeep(profileTreatments);
    ddata.profileTreatments = ddata.processDurations(profileTreatments, true);

    // filter & prepare 'Combo Bolus' events
    ddata.combobolusTreatments = ddata.treatments.filter( function filterComboBoluses (t) {
      return t.eventType === 'Combo Bolus';
    }).sort(function (a,b) { return a.mills > b.mills; });

    // filter & prepare temp basals
    var tempbasalTreatments = ddata.treatments.filter( function filterBasals (t) {
      return t.eventType && t.eventType.indexOf('Temp Basal') > -1;
    });
    if (preserveOrignalTreatments)
      tempbasalTreatments = _.cloneDeep(tempbasalTreatments);
    ddata.tempbasalTreatments = ddata.processDurations(tempbasalTreatments, false);

    // filter temp target
    var tempTargetTreatments = ddata.treatments.filter( function filterTargets (t) {
      return t.eventType && t.eventType.indexOf('Temporary Target') > -1;
    });
    if (preserveOrignalTreatments)
      tempTargetTreatments = _.cloneDeep(tempTargetTreatments);
    ddata.tempTargetTreatments = ddata.processDurations(tempTargetTreatments, false);

  };

  return ddata;

}

module.exports = init;