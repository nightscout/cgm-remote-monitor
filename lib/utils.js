'use strict';

var moment = require('moment-timezone');

var units = require('./units')();

function init(settings) {

  var utils = {
  };

  var MINUTE_IN_SECS = 60
    , HOUR_IN_SECS = 3600
    , DAY_IN_SECS = 86400;

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

  utils.timeAgo = function timeAgo(time) {

    var now = Date.now()
        , offset = time === -1 ? -1 : (now - time) / 1000
        , parts = {};

    if (offset < MINUTE_IN_SECS * -5) {
      parts = { value: 'in the future' };
    } else if (offset === -1) {
      parts = { label: 'time ago' };
    } else if (offset <= MINUTE_IN_SECS * 2) {
      parts = { value: 1, label: 'min ago' };
    } else if (offset < (MINUTE_IN_SECS * 60)) {
      parts = { value: Math.round(Math.abs(offset / MINUTE_IN_SECS)), label: 'mins ago' };
    } else if (offset < (HOUR_IN_SECS * 2)) {
      parts = { value: 1, label: 'hr ago' };
    } else if (offset < (HOUR_IN_SECS * 24)) {
      parts = { value: Math.round(Math.abs(offset / HOUR_IN_SECS)), label: 'hrs ago' };
    } else if (offset < DAY_IN_SECS) {
      parts = { value: 1, label: 'day ago' };
    } else if (offset <= (DAY_IN_SECS * 7)) {
      parts = { value: Math.round(Math.abs(offset / DAY_IN_SECS)), label: 'day ago' };
    } else {
      parts = { value: 'long ago' };
    }

    if (offset > DAY_IN_SECS * 7) {
      parts.status = 'warn';
    } else if (offset < MINUTE_IN_SECS * -5 || offset > (MINUTE_IN_SECS * settings.alarmTimeagoUrgentMins)) {
      parts.status = 'urgent';
    } else if (offset > (MINUTE_IN_SECS * settings.alarmTimeagoWarnMins)) {
      parts.status = 'warn';
    } else {
      parts.status = 'current';
    }

    return parts;

  };

  // some helpers for input "date"
  utils.mergeInputTime = function mergeInputTime(timestring, datestring) {
    return moment(datestring + ' ' + timestring, 'YYYY-MM-D HH:mm');
  };

 return utils;
}

module.exports = init;