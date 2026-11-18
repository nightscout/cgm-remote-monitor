'use strict';

const consts = require('../constants');

const moment = window.moment;
const utils = {};

function dateLocale (client) {
  const language = client.settings && client.settings.language ? client.settings.language : 'en';
  const momentLocales = {
    br: 'pt-br'
    , dk: 'da'
    , zh_cn: 'zh-cn'
    , zh_tw: 'zh-tw'
  };
  return momentLocales[language] || language.replace('_', '-').toLowerCase();
}

function init () {
  return utils;
}

module.exports = init;

utils.localeDate = function localeDate (day) {
  const client = window.Nightscout.client;
  const translate = client.translate;
  const profile = client.sbx.data.profile;
  let date;
  if (typeof day === 'string') {
    date = profile.parseInTimezone(day + 'T00:00:00');
  } else {
    date = profile.applyTimezone(moment(day));
  }
  let ret = [translate('Sunday'), translate('Monday'), translate('Tuesday'), translate('Wednesday'), translate('Thursday'), translate('Friday'), translate('Saturday')][date.day()];
  ret += ' ';
  ret += date.locale(dateLocale(client)).format('L');
  return ret;
};

utils.localeDateTime = function localeDateTime (day) {
  const client = window.Nightscout.client;
  const profile = client.sbx.data.profile;
  let date;

  if (typeof day === 'string') {
    date = profile.parseInTimezone(day + 'T00:00:00');
  } else {
    date = profile.applyTimezone(moment(day));
  }

  return date.locale(dateLocale(client)).format('L LT');
};

utils.scaledTreatmentBG = function scaledTreatmentBG (treatment, data) {
  const client = window.Nightscout.client;

  const SIX_MINS_IN_MS = 360000;

  function calcBGByTime (time) {
    const closeBGs = data.filter(function(d) {
      if (!d.y) {
        return false;
      } else {
        return Math.abs((new Date(d.date)).getTime() - time) <= SIX_MINS_IN_MS;
      }
    });

    let totalBG = 0;
    closeBGs.forEach(function(d) {
      totalBG += Number(d.y);
    });

    return totalBG > 0 ? (totalBG / closeBGs.length) : 450;
  }

  let treatmentGlucose = null;

  if (treatment.glucose && isNaN(treatment.glucose)) {
    console.warn('found an invalid glucose value', treatment);
  } else {
    if (treatment.glucose && treatment.units && client.settings.units) {
      if (treatment.units !== client.settings.units) {
        console.info('found mismatched glucose units, converting ' + treatment.units + ' into ' + client.settings.units, treatment);
        if (treatment.units === 'mmol') {
          //BG is in mmol and display in mg/dl
          treatmentGlucose = Math.round(treatment.glucose * consts.MMOL_TO_MGDL);
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
