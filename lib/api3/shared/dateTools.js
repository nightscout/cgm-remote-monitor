'use strict';
const dayjs = require('../../utils/dayjs');
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
 * Parse date as moment object from value or array of values.
 * @param {any} value
 */
function parseToDayjs (value)
{
  // Helper function to validate parsed date matches input
  function validateParsedDate(parsed, originalValue, format) {
    if (!parsed.isValid()) {
      return false;
    }

    // For strict validation, check if re-formatting matches the original
    // This catches cases where Day.js auto-corrects invalid dates
    if (format) {
      const reformatted = parsed.format(format);
      // For ISO format, normalize the input for comparison
      if (format === 'YYYY-MM-DDTHH:mm:ss.SSSZ') {
        const normalized = originalValue.replace(/T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/g, (match, h, m, s, ms) => {
          return `T${h}:${m}:${s}.${ms ? ms.padEnd(3, '0') : '000'}`;
        });
        return reformatted === normalized || reformatted === originalValue;
      }
      return reformatted === originalValue;
    }

    return true;
  }

  if (!value)
    return null;

  if (Array.isArray(value)) {
    for (let item of value) {
      let d = parseToDayjs(item);

      if (d !== null)
        return d;
    }
  }
  else {

    if (typeof value === 'string' && stringTools.isNumberInString(value)) {
      value = parseFloat(value);
    }    if (typeof value === 'number') {
      let d = dayjs(value);

      if (!d.isValid())
        return null;

      // If the timestamp is too small, it might be Unix time (seconds), try converting
      if (d.valueOf() < apiConst.MIN_TIMESTAMP) {
        // Only try unix conversion if the value looks like it could be seconds (not milliseconds)
        // Unix timestamps are typically 10 digits (seconds since 1970)
        if (value < 10000000000) { // Less than ~2286 year in seconds, likely unix seconds
          d = dayjs.unix(value);
        }
      }

      if (!d.isValid() || d.valueOf() < apiConst.MIN_TIMESTAMP)
        return null;

      return d;
    }    if (typeof value === 'string') {
      // Normalize comma decimal separator to dot for ISO 8601 compatibility
      let normalizedValue = value;
      if (value.includes(',') && value.match(/T\d{2}:\d{2}:\d{2},\d{3}/)) {
        normalizedValue = value.replace(/,(\d{3})/, '.$1');
      }

      let d = null;

      // Check if it looks like RFC 2822 format first (to avoid false positive ISO parsing)
      const rfc2822Pattern = /^[A-Za-z]{3},\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+[+-]\d{4}$/;
      if (normalizedValue.match(rfc2822Pattern)) {
        // Convert RFC 2822 timezone format from ±HHMM to ±HH:MM for parseZone compatibility
        const rfc2822WithColon = normalizedValue.replace(/([+-])(\d{2})(\d{2})$/, '$1$2:$3');
        d = dayjs.parseZone(rfc2822WithColon);
        if (d.isValid()) {
          // Validate it's actually correct by checking if the conversion worked
          const originalHour = parseInt(normalizedValue.match(/\s(\d{2}):/)[1]);
          if (d.hour() === originalHour) {
            // RFC 2822 parsing successful
            if (d.valueOf() < apiConst.MIN_TIMESTAMP) {
              return null;
            }
            return d;
          }
        }
        d = null; // Reset for other attempts
      }

      // Try parsing as ISO 8601 format
      if (!d) {
        d = dayjs.parseZone(normalizedValue);

        // If auto-parsing succeeded, validate it's not auto-corrected
        if (d.isValid()) {
          // Check for common invalid patterns that Day.js might auto-correct
          const isoPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/;
          const isoMatch = normalizedValue.match(isoPattern);
          if (isoMatch) {
            const [, year, month, day, hour, minute, second] = isoMatch;
            // Check for obviously invalid values
            if (parseInt(month) > 12 || parseInt(day) > 31 ||
                parseInt(hour) > 23 || parseInt(minute) > 59 || parseInt(second) > 59) {
              return null;
            }

            // Additional check: ensure the parsed date components match input
            if (d.year() !== parseInt(year) ||
                d.month() + 1 !== parseInt(month) ||
                d.date() !== parseInt(day) ||
                d.hour() !== parseInt(hour) ||
                d.minute() !== parseInt(minute) ||
                d.second() !== parseInt(second)) {
              return null;
            }
          }
        }
      }

      // If that fails, try with explicit ISO format
      if (!d || !d.isValid()) {
        d = dayjs.parseZone(normalizedValue, 'YYYY-MM-DDTHH:mm:ss.SSSZ', true);
        if (!validateParsedDate(d, normalizedValue, 'YYYY-MM-DDTHH:mm:ss.SSSZ')) {
          d = dayjs('invalid');
        }
      }

      // Try other common formats
      if (!d || !d.isValid()) {
        d = dayjs.parseZone(normalizedValue, 'YYYY-MM-DD HH:mm:ss', true);
        if (!validateParsedDate(d, normalizedValue)) {
          d = dayjs('invalid');
        }
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