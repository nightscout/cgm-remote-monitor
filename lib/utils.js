'use strict';

var units = require('./units.js')();
const cloneDeep = require('./utils/clone.js');
const cloneShallow = require('./utils/cloneShallow.js'); // Corrected casing

/**
 * Initialize utils module
 * @param {Object} ctx - The context object
 * @param {Object} ctx.moment - Moment.js instance
 * @param {Object} ctx.settings - Application settings
 * @param {Object} ctx.language - Language module
 * @param {Function} ctx.language.translate - Translation function
 * @returns {Object} Utils object with utility functions
 */
function init(ctx) {
  var moment = ctx.moment;
  var settings = ctx.settings;
  var translate = ctx.language.translate;
  var timeago = require('./plugins/timeago')(ctx);

  var utils = { };
  /**
   * Scale blood glucose value according to settings units
   * @param {number} mgdl - Blood glucose value in mg/dl
   * @returns {number} - Scaled blood glucose value
   */
  utils.scaleMgdl = function scaleMgdl (mgdl) {
    if (settings.units === 'mmol' && mgdl) {
      return Number(units.mgdlToMMOL(mgdl));
    } else {
      return Number(mgdl);
    }
  };
  /**
   * Round blood glucose value for display
   * @param {number} bg - Blood glucose value
   * @returns {number} - Rounded blood glucose value
   */
  utils.roundBGForDisplay = function roundBGForDisplay (bg) {
    return settings.units === 'mmol' ? Math.round(bg * 10) / 10 : Math.round(bg);
  };
  /**
   * Format a number to a fixed precision string
   * @param {number} value - The number to format
   * @returns {string} - Formatted string representation
   */
  utils.toFixed = function toFixed(value) {
    if (!value) {
      return '0';
    } else {
      var fixed = value.toFixed(2);
      return fixed === '-0.00' ? '0.00' : fixed;
    }
  };

  /**
   *
   * @param {Object|Array} obj
   * @returns {boolean} - true if the object is empty
   */
  utils.isEmpty = obj => [Object, Array].includes((obj || {}).constructor) && !Object.entries((obj || {})).length;


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


  utils.deepMerge = require('./utils/deepMerge')

  // some helpers for input "date"
  utils.mergeInputTime = function mergeInputTime(timestring, datestring) {
    return moment(datestring + ' ' + timestring, 'YYYY-MM-D HH:mm');
  };

  utils.pick = require('./utils/pick');

  /**
   * Extract device name from device string
   * @param {string} device - The device string to parse
   * @returns {string} - The device name
   */
  utils.deviceName = function deviceName (device) {
    var parts = device ? device.split('://') : [];
    var last = parts.length ? parts[parts.length - 1] : 'unknown';
    var firstParts = last.split('/');
    return firstParts.length ? firstParts[0] : last;
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

  utils.cloneDeep = cloneDeep;
  utils.cloneShallow = cloneShallow; // Added this line

  return utils;
}

module.exports = init;
