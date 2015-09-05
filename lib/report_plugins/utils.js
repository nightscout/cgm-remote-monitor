'use strict';

var utils = { };

function init( ) {
  return utils;
}

module.exports = init;

utils.localeDate = function localeDate(day) {
  var translate = Nightscout.client.translate;
  var date;
  if (typeof day === 'string') {
    date = new Date(day + ' 00:00:00');
  } else {
    date = day;
  }
  var ret = 
    [translate('Sunday'),translate('Monday'),translate('Tuesday'),translate('Wednesday'),translate('Thursday'),translate('Friday'),translate('Saturday')][date.getDay()];
  ret += ' ';
  ret += date.toLocaleDateString();
  return ret;
};

utils.localeDateTime = function localeDateTime(day) {
  var date;
  if (typeof day === 'string') {
    date = new Date(day + ' 00:00:00');
  } else {
    date = day;
  }
  var ret = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  return ret;
};

utils.scaledTreatmentBG = function scaledTreatmentBG(treatment,data) {
  var client = Nightscout.client;

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
  } else {
    if (treatment.glucose && treatment.units && client.settings.units) {
      if (treatment.units !== client.settings.units) {
        console.info('found mismatched glucose units, converting ' + treatment.units + ' into ' + client.settings.units, treatment);
        if (treatment.units === 'mmol') {
          //BG is in mmol and display in mg/dl
          treatmentGlucose = Math.round(treatment.glucose * 18);
        } else {
          //BG is in mg/dl and display in mmol
          treatmentGlucose = client.utils.scaleMgdl(treatment.glucose);
        }
      } else {
        treatmentGlucose = treatment.glucose;
      }
    } else if (treatment.glucose) {
      //no units, assume everything is the same
      console.warn('found an glucose value with any units, maybe from an old version?', treatment);
      treatmentGlucose = treatment.glucose;
    }
  }

  return treatmentGlucose || client.utils.scaleMgdl(calcBGByTime(treatment.mills));
};
