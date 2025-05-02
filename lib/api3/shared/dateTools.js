'use strict';

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const customParseFormat = require('dayjs/plugin/customParseFormat');
const isBetween = require('dayjs/plugin/isBetween'); // Potentially useful for date comparisons
const duration = require('dayjs/plugin/duration'); // For duration calculations if needed later
const relativeTime = require('dayjs/plugin/relativeTime'); // For 'fromNow', 'ago' etc. if needed later

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);
dayjs.extend(isBetween);
dayjs.extend(duration);
dayjs.extend(relativeTime);

const stringTools = require('./stringTools');
const apiConst = require('../const.json');

/**
  * Floor date to whole seconds (cut off milliseconds)
  * @param {Date} date
  */
function floorSeconds (date) {
  let ms = date.getTime();
  ms -= ms % 1000;
  return new Date(ms);
}

/**
 * Parse date as dayjs object from value or array of values.
 * @param {any} value
 * @returns {dayjs.Dayjs | null}
 */
function parseToDayjs (value)
{
  if (!value)
    return null;

  if (Array.isArray(value)) {
    for (let item of value) {
      let d = parseToDayjs(item); // Recursive call

      if (d !== null)
        return d;
    }
  }
  else {

    if (typeof value === 'string' && stringTools.isNumberInString(value)) {
      value = parseFloat(value);
    }

    if (typeof value === 'number') {
      // Try parsing as milliseconds first
      let d = dayjs(value);

      if (!d.isValid())
        return null;

      // If timestamp is likely seconds (before MIN_TIMESTAMP which is likely a millisecond value)
      if (d.valueOf() < apiConst.MIN_TIMESTAMP) {
        d = dayjs.unix(value); // Try parsing as seconds
      }

      if (!d.isValid() || d.valueOf() < apiConst.MIN_TIMESTAMP)
        return null;

      return d;
    }

    if (typeof value === 'string') {
      // dayjs() is quite flexible and handles ISO 8601 by default.
      // dayjs.tz() attempts to parse with timezone information.
      let d = dayjs.tz(value); // Try parsing with timezone first (like moment.parseZone)

      // If timezone parsing fails, try RFC 2822 format explicitly
      if (!d.isValid()) {
         // Common RFC 2822 format, ZZ handles timezone offset like +0000 or Z
        d = dayjs(value, 'ddd, DD MMM YYYY HH:mm:ss ZZ', true); // Use strict parsing
      }

      // Fallback to default parsing if others fail
      if (!d.isValid()) {
        d = dayjs(value);
      }

      if (!d.isValid() || d.valueOf() < apiConst.MIN_TIMESTAMP)
        return null;

      return d;
    }
  }

  // no parsing option succeeded => failure
  return null;
}

module.exports = {
  floorSeconds,
  parseToDayjs
};
