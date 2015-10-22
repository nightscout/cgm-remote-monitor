'use strict';

var _ = require('lodash');
var moment = require('moment-timezone');
var NodeCache = require('node-cache');
var times = require('./times');

function init(profileData) {

  var profile = { };

  profile.timeValueCache = new NodeCache({ stdTTL: 600, checkperiod: 600 });

  profile.loadData = function loadData(profileData) {
    if (profileData && profileData.length) {
      profile.data =  profile.convertToProfileStore(profileData);
      _.each(profile.data, function eachProfileRecord (record) {
        _.each(record.store, profile.preprocessProfileOnLoad);
      });
    }
  };
  
  // since 0.8.2 profile data will be converted following way
  //
  // source (result from api call) - only [0] used now
  // [ { XXX, startDate: xxx }, { YYY, startDate: yyy } ]
  //
  // converted data
  // [
  //   {
  //     defaultProfile: 'Default'
  //     , store: {
  //       'Default' : { XXX }
  //     }
  //     , startDate: xxx
  //   }
  //   , {
  //     defaultProfile: 'Default'
  //     , store: {
  //       'Default' : { YYY }
  //     }
  //     , startDate: yyy
  //   }
  // ]
  
  // example of one new profile
  //
  //   {
  //     defaultProfile: '2-Weekend'
  //     , store: {
  //       '1-Weekday' : { AAA }
  //       '2-Weekend' : { BBB }
  //       '3-Exercise' : { CCC }
  //     }
  //     , startDate: xxx
  //   }
  //
  // for basals currently used profile will be determined by
  // last treatment record
  // { 
  //   eventType: 'Profile Change'
  //   , profile: '2-Weekend'
  // }
  //
  // for boluscalc profile used for calculation will be specified by key `profile` 
  // 
  
  profile.convertToProfileStore = function convertToProfileStore (dataArray) {
    var convertedProfiles = [];
    _.each(dataArray, function (profile) {
      if (!profile.defaultProfile) {
        var newObject = {};
        newObject.defaultProfile = 'Default';
        newObject.store = {};
        newObject.startDate = profile.startDate;
        newObject._id = profile._id;
        delete profile.startDate;
        delete profile._id;
        delete profile.created_at;
        newObject.store['Default'] = profile;
        convertedProfiles.push(newObject);
        console.log('Profile not updated yet. Converted profile:', newObject);
      } else {
        convertedProfiles.push(profile);
      }
    });
    return convertedProfiles;
  };

  profile.timeStringToSeconds = function timeStringToSeconds(time) {
    var split = time.split(':');
    return parseInt(split[0])*3600 + parseInt(split[1])*60;
  };

  // preprocess the timestamps to seconds for a couple orders of magnitude faster operation
  profile.preprocessProfileOnLoad = function preprocessProfileOnLoad(container) {
    _.each(container, function eachValue (value) {
      if( Object.prototype.toString.call(value) === '[object Array]' ) {
        profile.preprocessProfileOnLoad(value);
      }

      if (value.time) {
        var sec = profile.timeStringToSeconds(value.time);
        if (!isNaN(sec)) { value.timeAsSeconds = sec; }
      }
    });
  };
  profile.getValueByTime = function getValueByTime (time, valueType) {
    if (!time) { time = Date.now(); }

    //round to the minute for better caching
    var minuteTime = Math.round(time / 60000) * 60000;

    var cacheKey = (minuteTime + valueType);
    var returnValue = profile.timeValueCache[cacheKey];

    if (returnValue) {
      return returnValue;
    }

    var valueContainer = profile.getCurrentProfile()[valueType];

    // Assumes the timestamps are in UTC
    // Use local time zone if profile doesn't contain a time zone
    // This WILL break on the server; added warnings elsewhere that this is missing
    // TODO: Better warnings to user for missing configuration

    var t = profile.getTimezone() ? moment(minuteTime).tz(profile.getTimezone()) : moment(minuteTime);

    // Convert to seconds from midnight
    var mmtMidnight = t.clone().startOf('day');
    var timeAsSecondsFromMidnight = t.clone().diff(mmtMidnight, 'seconds');

    // If the container is an Array, assume it's a valid timestamped value container

    returnValue = valueContainer;

    if( Object.prototype.toString.call(valueContainer) === '[object Array]' ) {
      _.each(valueContainer, function eachValue (value) {
        if (timeAsSecondsFromMidnight >= value.timeAsSeconds) {
          returnValue = value.value;
        }
      });
    }

	if (returnValue) { returnValue = parseFloat(returnValue); }

    profile.timeValueCache[cacheKey] = returnValue;

    return returnValue;
  };

  profile.getCurrentProfile = function getCurrentProfile() {
    var data = profile.hasData() ? profile.data[0] : null;
    return data && data.store[data.defaultProfile] ? data.store[data.defaultProfile] : {};
  };

  profile.getUnits = function getUnits() {
    return profile.getCurrentProfile()['units'];
  };

  profile.getTimezone = function getTimezone() {
    return profile.getCurrentProfile()['timezone'];
  };

  profile.hasData = function hasData() {
    return profile.data ? true : false;
  };

  profile.getDIA = function getDIA(time) {
    return profile.getValueByTime(time, 'dia');
  };

  profile.getSensitivity = function getSensitivity(time) {
    return profile.getValueByTime(time, 'sens');
  };

  profile.getCarbRatio = function getCarbRatio(time) {
    return profile.getValueByTime(time, 'carbratio');
  };

  profile.getCarbAbsorptionRate = function getCarbAbsorptionRate(time) {
    return profile.getValueByTime(time, 'carbs_hr');
  };

  profile.getLowBGTarget = function getLowBGTarget(time) {
    return profile.getValueByTime(time, 'target_low');
  };

  profile.getHighBGTarget = function getHighBGTarget(time) {
    return profile.getValueByTime(time, 'target_high');
  };

  profile.getBasal = function getBasal(time) {
    return profile.getValueByTime(time,'basal');
  };

  profile.tempBasalTreatment = function tempBasalTreatment(time, basaltreatments) {
    var treatment = null;
    basaltreatments.forEach( function eachTreatment (t) {
        var duration = times.mins(t.duration || 0).msecs;
        if (time < t.mills + duration && time > t.mills) {
          treatment = t;
        }
    });
    return treatment;
  };

  profile.getTempBasal = function getTempBasal(time, basaltreatments) {

    var cacheKey = time + JSON.stringify(basaltreatments);
    var returnValue = profile.timeValueCache[cacheKey];

    if (returnValue) {
      return returnValue;
    }

    var basal = profile.getValueByTime(time,'basal');
    var tempbasal = basal;
    var treatment = profile.tempBasalTreatment(time, basaltreatments);
    if (treatment && treatment.percent) {
      tempbasal = basal * (100 + treatment.percent) / 100;
    }
    if (treatment && treatment.absolute) {
      tempbasal = treatment.absolute;
    }
    returnValue = {
      basal: basal
      , treatment: treatment
      , tempbasal: tempbasal
    };
    profile.timeValueCache[cacheKey] = returnValue;
    return returnValue;
  };

  if (profileData) { profile.loadData(profileData); }

  return profile;
}

module.exports = init;