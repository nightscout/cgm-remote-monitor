'use strict';

var moment = require('moment-timezone');

var units = require('./units')();

function init(settings) {

  var utils = { };

  utils.scaleMgdl = function scaleMgdl (mgdl) {
    if (settings.units === 'mmol' && mgdl) {
      return Number(units.mgdlToMMOL(mgdl));
    } else {
      return Number(mgdl);
    }
  };

  utils.roundBGForDisplay = function roundBGForDisplay (bg) {
    return settings.units === 'mmol' ? Math.round(bg * 10) / 10 : Math.round(bg);
  };

  utils.toFixed = function toFixed(value) {
    if (value === 0) {
      return '0';
    } else {
      var fixed = value.toFixed(2);
      return fixed === '-0.00' ? '0.00' : fixed;
    }
  };

  // some helpers for input "date"
  utils.mergeInputTime = function mergeInputTime(timestring, datestring) {
    return moment(datestring + ' ' + timestring, 'YYYY-MM-D HH:mm');
  };

 return utils;
}

module.exports = init;