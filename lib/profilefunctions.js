'use strict';

var _ = require('lodash');
var c = require('memory-cache');
var times = require('./times');

var cacheTTL = 5000;
var prevBasalTreatment = null;

function init (profileData, ctx) {

var moment = ctx.moment;

  var cache = new c.Cache();
  var profile = {};

  profile.clear = function clear() {
    cache.clear();
    profile.data = null;
    prevBasalTreatment = null;
  }

  profile.clear();

  profile.loadData = function loadData (profileData) {
    if (profileData && profileData.length) {
      profile.data = profile.convertToProfileStore(profileData);
      _.each(profile.data, function eachProfileRecord (record) {
        _.each(record.store, profile.preprocessProfileOnLoad);
        record.mills = new Date(record.startDate).getTime();
      });
    }
  };

  profile.convertToProfileStore = function convertToProfileStore (dataArray) {
    var convertedProfiles = [];
    _.each(dataArray, function(profile) {
      if (!profile.defaultProfile) {
        var newObject = {};
        newObject.defaultProfile = 'Default';
        newObject.store = {};
        newObject.startDate = profile.startDate ? profile.startDate : '1980-01-01';
        newObject._id = profile._id;
        newObject.convertedOnTheFly = true;
        delete profile.startDate;
        delete profile._id;
        delete profile.created_at;
        newObject.store['Default'] = profile;
        convertedProfiles.push(newObject);
        console.log('Profile not updated yet. Converted profile:', newObject);
      } else {
        delete profile.convertedOnTheFly;
        convertedProfiles.push(profile);
      }
    });
    return convertedProfiles;
  };

  profile.timeStringToSeconds = function timeStringToSeconds (time) {
    var split = time.split(':');
    return parseInt(split[0]) * 3600 + parseInt(split[1]) * 60;
  };

  // preprocess the timestamps to seconds for a couple orders of magnitude faster operation
  profile.preprocessProfileOnLoad = function preprocessProfileOnLoad (container) {
    _.each(container, function eachValue (value) {

      if (value === null) return;

      if (Object.prototype.toString.call(value) === '[object Array]') {
        profile.preprocessProfileOnLoad(value);
      }

      if (value.time) {
        var sec = profile.timeStringToSeconds(value.time);
        if (!isNaN(sec)) { value.timeAsSeconds = sec; }
      }
    });
  };

  profile.getValueByTime = function getValueByTime (time, valueType, spec_profile) {
    if (!time) { time = Date.now(); }

    //round to the minute for better caching
    var minuteTime = Math.round(time / 60000) * 60000;
    var cacheKey = (minuteTime + valueType + spec_profile);
    var returnValue = cache.get(cacheKey);

    if (returnValue) {
      return returnValue;
    }

    // CircadianPercentageProfile support
    var timeshift = 0;
    var percentage = 100;
    var activeTreatment = profile.activeProfileTreatmentToTime(time);
    var isCcpProfile = !spec_profile && activeTreatment && activeTreatment.CircadianPercentageProfile;
    if (isCcpProfile) {
      percentage = activeTreatment.percentage;
      timeshift = activeTreatment.timeshift; // in hours
    }
    var offset = timeshift % 24;
    time = time + offset * times.hours(offset).msecs;

    var valueContainer = profile.getCurrentProfile(time, spec_profile)[valueType];

    // Assumes the timestamps are in UTC
    // Use local time zone if profile doesn't contain a time zone
    // This WILL break on the server; added warnings elsewhere that this is missing
    // TODO: Better warnings to user for missing configuration

    var t = profile.getTimezone(spec_profile) ? moment(minuteTime).tz(profile.getTimezone(spec_profile)) : moment(minuteTime);

    // Convert to seconds from midnight
    var mmtMidnight = t.clone().startOf('day');
    var timeAsSecondsFromMidnight = t.clone().diff(mmtMidnight, 'seconds');

    // If the container is an Array, assume it's a valid timestamped value container

    returnValue = valueContainer;

    if (Object.prototype.toString.call(valueContainer) === '[object Array]') {
      _.each(valueContainer, function eachValue (value) {
        if (timeAsSecondsFromMidnight >= value.timeAsSeconds) {
          returnValue = value.value;
        }
      });
    }

    if (returnValue) {
      returnValue = parseFloat(returnValue);
      if (isCcpProfile) {
        switch (valueType) {
          case "sens":
          case "carbratio":
            returnValue = returnValue * 100 / percentage;
            break;
          case "basal":
            returnValue = returnValue * percentage / 100;
            break;
        }
      }
    }

    cache.put(cacheKey, returnValue, cacheTTL);

    return returnValue;
  };

  profile.getCurrentProfile = function getCurrentProfile (time, spec_profile) {

    time = time || Date.now();
    var minuteTime = Math.round(time / 60000) * 60000;
    var cacheKey = ("profile" + minuteTime + spec_profile);
    var returnValue = cache.get(cacheKey);

    if (returnValue) {
      return returnValue;
    }

    var pdataActive = profile.profileFromTime(time);
    var data = profile.hasData() ? pdataActive : null;
    var timeprofile = profile.activeProfileToTime(time);
    returnValue = data && data.store[timeprofile] ? data.store[timeprofile] : {};

    cache.put(cacheKey, returnValue, cacheTTL);
    return returnValue;

  };

  profile.getUnits = function getUnits (spec_profile) {
    var pu = profile.getCurrentProfile(null, spec_profile)['units'] + ' ';
    if (pu.toLowerCase().includes('mmol')) return 'mmol';
    return 'mg/dl';
  };

  profile.getTimezone = function getTimezone (spec_profile) {
    let rVal =  profile.getCurrentProfile(null, spec_profile)['timezone'];
    // Work around Loop uploading non-ISO compliant time zone string
    if (rVal) rVal.replace('ETC','Etc');
    return rVal;
  };

  profile.hasData = function hasData () {
    return profile.data ? true : false;
  };

  profile.getDIA = function getDIA (time, spec_profile) {
    return profile.getValueByTime(Number(time), 'dia', spec_profile);
  };

  profile.getSensitivity = function getSensitivity (time, spec_profile) {
    return profile.getValueByTime(Number(time), 'sens', spec_profile);
  };

  profile.getCarbRatio = function getCarbRatio (time, spec_profile) {
    return profile.getValueByTime(Number(time), 'carbratio', spec_profile);
  };

  profile.getCarbAbsorptionRate = function getCarbAbsorptionRate (time, spec_profile) {
    return profile.getValueByTime(Number(time), 'carbs_hr', spec_profile);
  };

  profile.getLowBGTarget = function getLowBGTarget (time, spec_profile) {
    return profile.getValueByTime(Number(time), 'target_low', spec_profile);
  };

  profile.getHighBGTarget = function getHighBGTarget (time, spec_profile) {
    return profile.getValueByTime(Number(time), 'target_high', spec_profile);
  };

  profile.getBasal = function getBasal (time, spec_profile) {
    return profile.getValueByTime(Number(time), 'basal', spec_profile);
  };

  profile.updateTreatments = function updateTreatments (profiletreatments, tempbasaltreatments, combobolustreatments) {

    profile.profiletreatments = profiletreatments || [];
    profile.tempbasaltreatments = tempbasaltreatments || [];

    // dedupe temp basal events    
    profile.tempbasaltreatments = _.uniqBy(profile.tempbasaltreatments, 'mills');

    _.each(profile.tempbasaltreatments, function addDuration (t) {
      t.endmills = t.mills + times.mins(t.duration || 0).msecs;
    });

    profile.tempbasaltreatments.sort(function compareTreatmentMills (a, b) {
      return a.mills - b.mills;
    });

    profile.combobolustreatments = combobolustreatments || [];

    cache.clear();
  };

  profile.activeProfileToTime = function activeProfileToTime (time) {
    if (profile.hasData()) {
      time = Number(time) || new Date().getTime();
      
      var pdataActive = profile.profileFromTime(time);
      var timeprofile = pdataActive.defaultProfile;
      var treatment = profile.activeProfileTreatmentToTime(time);

      if (treatment && pdataActive.store && pdataActive.store[treatment.profile]) {
        timeprofile = treatment.profile;
      }
      return timeprofile;
    }
    return null;
  };

  profile.activeProfileTreatmentToTime = function activeProfileTreatmentToTime (time) {
    
    var minuteTime = Math.round(time / 60000) * 60000;
    var cacheKey = 'profileCache' + minuteTime;
    var returnValue = cache.get(cacheKey);

    if (returnValue) {
      return returnValue;
    }

    var treatment = null;
    if (profile.hasData()) {
      var pdataActive = profile.profileFromTime(time);
        profile.profiletreatments.forEach(function eachTreatment(t) {
          if (time >= t.mills && t.mills >= pdataActive.mills) {
              var duration = times.mins(t.duration || 0).msecs;
              if (duration != 0 && time < t.mills + duration) {
                  treatment = t;
                  // if profile switch contains json of profile inject it in to store to be findable by profile name
                  if (treatment.profileJson && !pdataActive.store[treatment.profile]) {
                    if (treatment.profile.indexOf("@@@@@") < 0)
                      treatment.profile += "@@@@@" + treatment.mills;
                    let json = JSON.parse(treatment.profileJson);
                    pdataActive.store[treatment.profile] = json;
                  }
              }
              if (duration == 0) {
                treatment = t;
                // if profile switch contains json of profile inject it in to store to be findable by profile name
                if (treatment.profileJson && !pdataActive.store[treatment.profile]) {
                    if (treatment.profile.indexOf("@@@@@") < 0)
                      treatment.profile += "@@@@@" + treatment.mills;
                  let json = JSON.parse(treatment.profileJson);
                  pdataActive.store[treatment.profile] = json;
                }
              }
          }
      });
    }

    returnValue = treatment;
    cache.put(cacheKey, returnValue, cacheTTL);
    return returnValue;
  };

  profile.profileSwitchName = function profileSwitchName (name) {
    var index = name.indexOf("@@@@@");
    if (index < 0) return name;
    else return name.substring(0, index);
  }

  profile.profileFromTime = function profileFromTime (time) {
      var profileData = null;

      if (profile.hasData()) {
          profileData = profile.data[0];
          for (var i = 0; i < profile.data.length; i++)
          {
              if (Number(time) >= Number(profile.data[i].mills)) {
                  profileData = profile.data[i];
                  break;
              }
          }
      }

      return profileData;
  }

  profile.tempBasalTreatment = function tempBasalTreatment (time) {

    // Most queries for the data in reporting will match the latest found value, caching that hugely improves performance
    if (prevBasalTreatment && time >= prevBasalTreatment.mills && time <= prevBasalTreatment.endmills) {
      return prevBasalTreatment;
    }

    // Binary search for events for O(log n) performance
    var first = 0
      , last = profile.tempbasaltreatments.length - 1;

    while (first <= last) {
      var i = first + Math.floor((last - first) / 2);
      var t = profile.tempbasaltreatments[i];
      if (time >= t.mills && time <= t.endmills) {
        prevBasalTreatment = t;
        return t;
      }
      if (time < t.mills) {
        last = i - 1;
      } else {
        first = i + 1;
      }
    }

    return null;
  };

  profile.comboBolusTreatment = function comboBolusTreatment (time) {
    var treatment = null;
    profile.combobolustreatments.forEach(function eachTreatment (t) {
      var duration = times.mins(t.duration || 0).msecs;
      if (time < t.mills + duration && time > t.mills) {
        treatment = t;
      }
    });
    return treatment;
  };

  profile.getTempBasal = function getTempBasal (time, spec_profile) {

    var minuteTime = Math.round(time / 60000) * 60000;
    var cacheKey = 'basalCache' + minuteTime + spec_profile;
    var returnValue = cache.get(cacheKey);

    if (returnValue) {
      return returnValue;
    }

    var basal = profile.getBasal(time, spec_profile);
    var tempbasal = basal;
    var combobolusbasal = 0;
    var treatment = profile.tempBasalTreatment(time);
    var combobolustreatment = profile.comboBolusTreatment(time);

    //special handling for absolute to support temp to 0
    if (treatment && !isNaN(treatment.absolute) && treatment.duration > 0) {
      tempbasal = Number(treatment.absolute);
    } else if (treatment && treatment.percent) {
      tempbasal = basal * (100 + treatment.percent) / 100;
    }
    if (combobolustreatment && combobolustreatment.relative) {
      combobolusbasal = combobolustreatment.relative;
    }
    returnValue = {
      basal: basal
      , treatment: treatment
      , combobolustreatment: combobolustreatment
      , tempbasal: tempbasal
      , combobolusbasal: combobolusbasal
      , totalbasal: tempbasal + combobolusbasal
    };
    cache.put(cacheKey, returnValue, cacheTTL);
    return returnValue;
  };

  profile.listBasalProfiles = function listBasalProfiles () {
    var profiles = [];
    if (profile.hasData()) {
      var current = profile.activeProfileToTime();
      profiles.push(current);

      Object.keys(profile.data[0].store).forEach(key => {
        if (key !== current && key.indexOf('@@@@@') < 0) profiles.push(key);
      })
    }
    return profiles;
  };

  if (profileData) { profile.loadData(profileData); }
  // init treatments array
  profile.updateTreatments([], []);

  return profile;
}

module.exports = init;
