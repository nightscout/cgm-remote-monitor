'use strict';

var _ = require('lodash');

var units = require('./units')();

function init(ctx) {
  var moment = ctx.moment;
  var settings = ctx.settings;
  var translate = ctx.language.translate;
  var timeago = require('./plugins/timeago')(ctx);

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
    if (!value) {
      return '0';
    } else {
      var fixed = value.toFixed(2);
      return fixed === '-0.00' ? '0.00' : fixed;
    }
  };

  /**
   * Round the number to maxDigits places, return a string
   * that truncates trailing zeros
   */
  utils.toRoundedStr = function toRoundedStr (value, maxDigits) {
    if (!value) {
      return '0';
    }
    const mult = Math.pow(10, maxDigits);
    const fixed = Math.sign(value) * Math.round(Math.abs(value)*mult) / mult;
    if (isNaN(fixed)) return '0';
    return String(fixed);
  };

  // some helpers for input "date"
  utils.mergeInputTime = function mergeInputTime(timestring, datestring) {
    return moment(datestring + ' ' + timestring, 'YYYY-MM-D HH:mm');
  };


  utils.deviceName = function deviceName (device) {
    var last = device ? _.last(device.split('://')) : 'unknown';
    return _.first(last.split('/'));
  };

  utils.timeFormat = function timeFormat (m, sbx) {
    var when;
    if (m && sbx.data.inRetroMode) {
      when = m.format('LT');
    } else if (m) {
      when = utils.formatAgo(m, sbx.time);
    } else {
      when = 'unknown';
    }

    return when;
  };

  utils.formatAgo = function formatAgo (m, nowMills) {
    var ago = timeago.calcDisplay({mills: m.valueOf()}, nowMills);
    return translate('%1' + ago.shortLabel + (ago.shortLabel.length === 1 ? ' ago' : ''), { params: [(ago.value ? ago.value : '')]});
  };

  utils.timeAt = function timeAt (prefix, sbx) {
    return sbx.data.inRetroMode ? (prefix ? ' ' : '') + '@ ' : (prefix ? ', ' : '');
  };

  return utils;
}

module.exports = init;
