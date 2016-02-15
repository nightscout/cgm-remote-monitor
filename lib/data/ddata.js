'use strict';

var _ = require('lodash');
var times = require('../times');

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

  ddata.split = function split (time, cutoff, max) {
    var result = {
      first: { }
      , rest: { }
      , last: { }
    };
    
    function recent (item) {
      return item.mills >= time - cutoff;
    }

    function filterMax(item) {
      return item.mills >= time - max;
    }
      
    function partition (field, filter, last) {
      var data;
      if (filter) {
        data = ddata[field].filter(filterMax);
      } else {
        data = ddata[field];
      }
      
      var parts = _.partition(data, recent);
      result.first[field] = parts[0];
      
      if (last) {
         result.last[field] = parts[1];
      } else {      
        result.rest[field] = parts[1];
     }
    }

    partition('treatments', false, false);
    partition('devicestatus', true, true);

    result.first.sgvs = ddata.sgvs.filter(filterMax);
    result.first.cals = ddata.cals;
    result.first.profiles = ddata.profiles;

    result.rest.mbgs = ddata.mbgs.filter(filterMax);

     console.log('results.first size', JSON.stringify(result.first).length,'bytes');
     console.log('results.rest size', JSON.stringify(result.rest).length,'bytes');
     console.log('results.last size', JSON.stringify(result.last).length,'bytes');

    return result;
  };

  ddata.processTreatments = function processTreatments ( ) {

    // filter & prepare 'Site Change' events
    ddata.sitechangeTreatments = ddata.treatments.filter( function filterSensor(t) {
      return t.eventType.indexOf('Site Change') > -1;
    }).sort(function (a,b) { return a.mills > b.mills; });

    // filter & prepare 'Insulin Change' events
    ddata.insulinchangeTreatments = ddata.treatments.filter( function filterInsulin(t) {
      return t.eventType.indexOf('Insulin Change') > -1;
    }).sort(function (a,b) { return a.mills > b.mills; });

    // filter & prepare 'Sensor' events
    ddata.sensorTreatments = ddata.treatments.filter( function filterSensor(t) {
      return t.eventType.indexOf('Sensor') > -1;
    }).sort(function (a,b) { return a.mills > b.mills; });

    // filter & prepare 'Profile Switch' events
    ddata.profileTreatments = ddata.treatments.filter( function filterProfiles(t) {
      return t.eventType === 'Profile Switch';
    }).sort(function (a,b) { return a.mills > b.mills; });

    // filter & prepare 'Combo Bolus' events
    ddata.combobolusTreatments = ddata.treatments.filter( function filterComboBoluses(t) {
      return t.eventType === 'Combo Bolus';
    }).sort(function (a,b) { return a.mills > b.mills; });

    // filter & prepare temp basals
    var tempbasalTreatments = ddata.treatments.filter( function filterBasals(t) {
      return t.eventType && t.eventType.indexOf('Temp Basal') > -1;
    });
    // cut temp basals by end events
    // better to do it only on data update
    var endevents = tempbasalTreatments.filter(function filterEnd(t) {
      return ! t.duration;
    });

    function cutIfInInterval(base, end) {
      if (base.mills < end.mills && base.mills + times.mins(base.duration).msecs > end.mills) {
        base.duration = times.msecs(end.mills-base.mills).mins;
      }
    }

    // cut by end events
    tempbasalTreatments.forEach(function allTreatments(t) {
      if (t.duration) {
        endevents.forEach(function allEndevents(e) {
          cutIfInInterval(t, e);
        });
      }
    });

    // cut by overlaping events
    tempbasalTreatments.forEach(function allTreatments(t) {
      if (t.duration) {
        tempbasalTreatments.forEach(function allEndevents(e) {
          cutIfInInterval(t, e);
        });
      }
    });

    // store prepared temp basal treatments
    ddata.tempbasalTreatments = tempbasalTreatments.filter(function filterEnd(t) {
      return t.duration;
    });
  };

  return ddata;

}

module.exports = init;