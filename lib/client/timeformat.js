'use strict';

/**
 * Shared timezone formatting utilities for displaying device and browser times
 */

/**
 * Calculate timezone offset in seconds from a timezone string using moment-timezone
 * @param {string} timezone - Timezone string (e.g., "Etc/GMT-1")
 * @param {object} moment - moment-timezone instance
 * @returns {number|null} - Offset in seconds, or null if timezone is invalid
 */
function getTimezoneOffsetSeconds(timezone, moment) {
  if (!timezone || !moment || !moment.tz) {
    return null;
  }
  try {
    var deviceMoment = moment().tz(timezone);
    return deviceMoment.utcOffset() * 60; // Convert minutes to seconds
  } catch (err) {
    console.error('Error calculating timezone offset:', err);
    return null;
  }
}

/**
 * Get current time in a specific timezone
 * @param {string} timezone - Timezone string (e.g., "Etc/GMT-1")
 * @param {object} moment - moment-timezone instance
 * @returns {Date|null} - Date object in device timezone, or null if timezone is invalid
 */
function getDeviceTime(timezone, moment) {
  if (!timezone || !moment || !moment.tz) {
    return null;
  }
  try {
    return moment().tz(timezone).toDate();
  } catch (err) {
    console.error('Error getting device time:', err);
    return null;
  }
}

/**
 * Get browser timezone offset in seconds
 * @returns {number} - Browser timezone offset in seconds
 */
function getBrowserOffsetSeconds() {
  return -new Date().getTimezoneOffset() * 60;
}

/**
 * Check if device and browser timezones have different UTC offsets
 * @param {number|null} deviceOffsetSeconds - Device timezone offset in seconds
 * @returns {boolean} - True if offsets differ
 */
function shouldShowBothTimes(deviceOffsetSeconds) {
  if (deviceOffsetSeconds === null) {
    return false;
  }
  var browserOffsetSeconds = getBrowserOffsetSeconds();
  return deviceOffsetSeconds !== browserOffsetSeconds;
}

module.exports = {
  getTimezoneOffsetSeconds: getTimezoneOffsetSeconds,
  getDeviceTime: getDeviceTime,
  getBrowserOffsetSeconds: getBrowserOffsetSeconds,
  shouldShowBothTimes: shouldShowBothTimes
};
