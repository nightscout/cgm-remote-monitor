'use strict';


// API for client
// currently no support to the past
var record = null;
var updateHandler = null;

	function updateFromStorage(profileStorage) { 
		profileStorage.last( function(err, records) {
			record = records.length > 0 ? records[0] : null;
			if (record) {
				console.log('Profile record loaded from storage.');
				if (updateHandler) updateHandler(record);
			}
		});
	}
	
	function update(newrecord) { 
		record = newrecord;
		if (updateHandler) updateHandler(record);
	}
	
	function dia() { 
		return record ? record.dia : 3;
	}
	
	function ic (time) {
		if (!record) return null;
		if (!record.calculator) return record.carbratio;
		var minutes =  time.getMinutes() + time.getHours() * 60;
		for (var i=0; i < record.ic.length -1; i++) {
			if (parseInt(record.ic[i+1].from)>minutes) return record.ic[i].val;
		}
		return null;
	}

	function isf (time,units) {
		if (!record) return 0;
		if (!record.calculator) return convertUnits(record.sens,units);
		var minutes =  time.getMinutes() + time.getHours() * 60;
		for (var i=0; i < record.isf.length -1; i++) {
			if (parseInt(record.isf[i+1].from)>minutes) return convertUnits(record.isf[i].val,units);
		}
		return null;
	}

	function car(time, glycemicIndex) { //glycemicIndex 1..low  2..medium 3..high but allowing float within range <1-3>
		if (!record) return null;
		if (record.simple) return record.carbs_hr;
		if (glycemicIndex==1) return record.car_low;
		if (glycemicIndex==2) return record.car_medium;
		if (glycemicIndex==3) return record.car_high;
		if (glycemicIndex>1 && glycemicIndex<2) return (record.car_medium-record.car_low) * (glycemicIndex-1) + record.car_low;
		if (glycemicIndex>2 && glycemicIndex<3) return (record.car_high-record.car_medium) * (glycemicIndex-2) + record.car_medium;
		return null;
	}
	
	function absorptionDelay(glycemicIndex) {
		if (!record) return null;
		if (record.simple) return 20; // 20 minutes is default by Scott Leibrand
		if (glycemicIndex==1) return record.delay_low;
		if (glycemicIndex==2) return record.delay_medium;
		if (glycemicIndex==3) return record.delay_high;
		if (glycemicIndex>1 && glycemicIndex<2) return (record.delay_medium-record.delay_low) * (glycemicIndex-1) + record.delay_low;
		if (glycemicIndex>2 && glycemicIndex<3) return (record.delay_high-record.delay_medium) * (glycemicIndex-2) + record.delay_medium;
		return null;
	}
	
	function basal(time) {
		if (!record) return null;
		var minutes =  time.getMinutes() + time.getHours() * 60;
		for (var i=0; i < record.basal.length -1; i++) {
			if (parseInt(record.basal[i+1].from)>minutes) return record.basal[i].val;
		}
		return null;
	}
	
	function targetBGLow(time,units) {
		if (!record) return null;
		var minutes =  time.getMinutes() + time.getHours() * 60;
		for (var i=0; i < record.targetBG.length -1; i++) {
			if (parseInt(record.targetBG[i+1].from)>minutes) return convertUnits(record.targetBG[i].low,units);
		}
		return null;
	}
	
	function targetBGHigh(time,units) {
		if (!record) return null;
		var minutes =  time.getMinutes() + time.getHours() * 60;
		for (var i=0; i < record.targetBG.length -1; i++) {
			if (parseInt(record.targetBG[i+1].from)>minutes) return convertUnits(record.targetBG[i].high,units);
		}
		return null;
	}
	
	function convertUnits(value, units) { // convert value to specified units. if no units specified return in mg/dL
		value = parseFloat(value);
		if (units.toLowerCase() == 'mg/dl' || typeof units === 'undefined') {
			if (record.units == 'mmol') return value * 18;
			else return value;
		}
		if (units == 'mmol') {
			if (record.units == 'mmol') return value;
			else return value / 18;
		}
	}
	
	function registerUpdateHandler(h) {
		updateHandler = h;
	}
	
	function data() {
		return record;
	}

function currentProfile() {

  return {
      update: update
    , updateFromStorage: updateFromStorage
    , registerUpdateHandler: registerUpdateHandler
	, dia: dia
	, ic: ic
	, isf: isf
	, car: car
	, absorptionDelay: absorptionDelay
	, basal: basal
	, targetBGLow: targetBGLow
	, targetBGHigh: targetBGHigh
	, data: data
  };

}

module.exports = currentProfile;