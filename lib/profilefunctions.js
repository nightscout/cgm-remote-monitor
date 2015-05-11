'use strict';

	////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // multiple profile support for predictions
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

	function timeStringToSeconds(time) {
		var split = time.split(":");
		return parseInt(split[0])*3600 + parseInt(split[1])*60;
	}
	
	// preprocess the timestamps to seconds for a couple orders of magnitude faster operation
	function preprocessProfileOnLoad(container)
	{
		for (var key in container) {
			var value = container[key];
			if( Object.prototype.toString.call(value) === '[object Array]' ) {
				preprocessProfileOnLoad(value);
			} else {
				if (value.time) {
					var sec = timeStringToSeconds(value.time);
					if (!isNaN(sec)) value.timeAsSeconds = sec;
				}
			}
		}
		container.timestampsPreProcessed = true;
	}
	
	
	function getValueByTime(profile, time, valueContainer)
	{
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
	
	function getDIA(profile, time)
	{
		return getValueByTime(profile, time,profile.dia);
	}
	
	function getSensitivity(profile, time)
	{
		return getValueByTime(profile, time,profile.sens);
	}
	
	function getCarbRatio(profile, time)
	{
		return getValueByTime(profile, time,profile.carbratio);
	}

	function getCarbAbsorptionRate(profile, time)
	{
		return getValueByTime(profile, time,profile.carbs_hr);
	}
	
	
function Profile(opts) {

  return {
    preprocessProfileOnLoad: preprocessProfileOnLoad
  };

}

module.exports = Profile;