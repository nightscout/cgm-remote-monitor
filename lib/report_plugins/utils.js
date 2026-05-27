'use strict';

var consts = require('../constants');
var { mmolToMgdl, guessUnitFromValueAndHint, guessUnitByProximity } = require('../units')();

var moment = window.moment;
var utils = { };

function init( ) {
  return utils;
}

module.exports = init;

utils.localeDate = function localeDate(day) {
  var translate = window.Nightscout.client.translate;
  var zone = window.Nightscout.client.sbx.data.profile.getTimezone();
  var date;
  if (typeof day === 'string') {
    date = moment.tz(day + 'T00:00:00',zone);
  } else {
    date = moment(day);
  }
  var ret = 
    [translate('Sunday'),translate('Monday'),translate('Tuesday'),translate('Wednesday'),translate('Thursday'),translate('Friday'),translate('Saturday')][date.day()];
  ret += ' ';
  ret += date.toDate().toLocaleDateString();
  return ret;
};

utils.localeDateTime = function localeDateTime(day) {
  var zone = window.Nightscout.client.sbx.data.profile.getTimezone();
  var date;
  if (typeof day === 'string') {
    date = moment.tz(day + 'T00:00:00',zone);
  } else {
    date = moment(day);
  }
  var ret = date.toDate().toLocaleDateString() + ' ' + date.toDate().toLocaleTimeString();
  return ret;
};

utils.scaledTreatmentBG = function scaledTreatmentBG(treatment,data) {
  var client = window.Nightscout.client;

  var SIX_MINS_IN_MS =  360000;
 
  function calcBGByTime(time) {
    var closeBGs = data.filter(function(d) {
      if (!d.y) {
        return false;
      } else {
        return Math.abs((new Date(d.date)).getTime() - time) <= SIX_MINS_IN_MS;
      }
    });

    var totalBG = 0;
    closeBGs.forEach(function(d) {
      totalBG += Number(d.y);
    });

    return totalBG > 0 ? (totalBG / closeBGs.length) : 450;
  }

  var treatmentGlucose = null;

  if (treatment.glucose && isNaN(treatment.glucose)) {
    console.warn('found an invalid glucose value', treatment);
  } else if (treatment.glucose) {
    var value = Number(treatment.glucose);
    var unit = guessUnitFromValueAndHint(value, treatment.units);
    if (unit === null) {
      unit = guessUnitByProximity(value, calcBGByTime(treatment.mills));
    }
    var mgdl = unit === 'mmol' ? mmolToMgdl(value) : value;
    treatmentGlucose = client.utils.scaleMgdl(mgdl);
  }

  return treatmentGlucose || client.utils.scaleMgdl(calcBGByTime(treatment.mills));
};
