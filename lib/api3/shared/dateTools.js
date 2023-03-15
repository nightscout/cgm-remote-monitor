'use strict';

const moment = require('moment')
  , stringTools = require('./stringTools')
  , apiConst = require('../const.json')
  ;


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
function parseToMoment (value)
{
  if (!value)
    return null;

  if (Array.isArray(value)) {
    for (let item of value) {
      let m = parseToMoment(item);

      if (m !== null)
        return m;
    }
  }
  else {

    if (typeof value === 'string' && stringTools.isNumberInString(value)) {
      value = parseFloat(value);
    }

    if (typeof value === 'number') {
      let m = moment(value);

      if (!m.isValid())
        return null;

      if (m.valueOf() < apiConst.MIN_TIMESTAMP)
        m = moment.unix(m);

      if (!m.isValid() || m.valueOf() < apiConst.MIN_TIMESTAMP)
        return null;

      return m;
    }

    if (typeof value === 'string') {
      let m = moment.parseZone(value, moment.ISO_8601);

      if (!m.isValid())
        m = moment.parseZone(value, moment.RFC_2822);

      if (!m.isValid() || m.valueOf() < apiConst.MIN_TIMESTAMP)
        return null;

      return m;
    }
  }

  // no parsing option succeeded => failure
  return null;
}

module.exports = {
  floorSeconds,
  parseToMoment
};
