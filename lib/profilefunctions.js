'use strict';

var _ = require('lodash');
var moment = require('moment');

function init(profileData) {

  function profile() {
    return profile;
  }

  profile.loadData = function loadData(profileData) {
    profile.data = _.cloneDeep(profileData);
    profile.preprocessProfileOnLoad(profile.data[0]);
  };

	profile.timeStringToSeconds = function timeStringToSeconds(time) {
		var split = time.split(':');
		return parseInt(split[0])*3600 + parseInt(split[1])*60;
	};
	
	// preprocess the timestamps to seconds for a couple orders of magnitude faster operation
	profile.preprocessProfileOnLoad = function preprocessProfileOnLoad(container) {
		for (var key in container) {
			var value = container[key];
						
			if( Object.prototype.toString.call(value) === '[object Array]' ) {
				profile.preprocessProfileOnLoad(value);
			}
			
			if (value.time) {
				var sec = profile.timeStringToSeconds(value.time);
				if (!isNaN(sec)) { value.timeAsSeconds = sec; }
			}
			
		}
	};

	if (profileData) { profile.loadData(profileData); }
	
	profile.getValueByTime = function getValueByTime (time, valueContainer) {
      if (!time) { time = new Date(); }

		// If the container is an Array, assume it's a valid timestamped value container

		var returnValue = valueContainer;

		if( Object.prototype.toString.call(valueContainer) === '[object Array]' ) {
			
			var timeAsDate = new Date(time);
			var timeAsSecondsFromMidnight = timeAsDate.getHours()*3600 + timeAsDate.getMinutes()*60;

			for (var t in valueContainer) {
				var value = valueContainer[t];
				if (timeAsSecondsFromMidnight >= value.timeAsSeconds) {
					returnValue = value.value;
				}
			}			
		}
		
		return returnValue;
	}
	
	profile.getCurrentProfile = function getCurrentProfile() {
	  if (profile.hasData()) return profile.data[0];
	  return {};
	}
	
  profile.hasData = function hasData() {
    var rVal = false;
    if (profile.data) rVal = true;
    return (rVal);
  }
	
  profile.getDIA = function getDIA(time) {
    return profile.getValueByTime(time,profile.getCurrentProfile()['dia']);
  }
	
  profile.getSensitivity = function getSensitivity(time) {
    return profile.getValueByTime(time,profile.getCurrentProfile()['sens']);
  }
	
  profile.getCarbRatio = function getCarbRatio(time) {
    return profile.getValueByTime(time,profile.getCurrentProfile()['carbratio']);
  }

  profile.getCarbAbsorptionRate = function getCarbAbsorptionRate(time) {
    return profile.getValueByTime(time,profile.getCurrentProfile()['carbs_hr']);
  }

  profile.getLowBGTarget = function getLowBGTarget(time) {
    return profile.getValueByTime(time,profile.getCurrentProfile()['target_low']);
  }

  profile.getHighBGTarget = function getHighBGTarget(time) {
    return profile.getValueByTime(time,profile.getCurrentProfile()['target_high']);
  }

  profile.getBasal = function getBasal(time) {
    return profile.getValueByTime(time,profile.getCurrentProfile()['basal']);
  }

	
   return profile();
}

module.exports = init;