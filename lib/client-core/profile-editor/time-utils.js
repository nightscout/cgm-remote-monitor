'use strict';

function toMinutesFromMidnight (time) {
  if (typeof time !== 'string') return NaN;
  var split = time.split(':');
  return parseInt(split[0], 10) * 60 + parseInt(split[1], 10);
}

function pad2 (n) {
  n = String(n);
  return n.length === 1 ? '0' + n : n;
}

function toTimeString (minfrommidnight) {
  var m = parseInt(minfrommidnight, 10);
  if (isNaN(m)) return '00:00';
  m = ((m % 1440) + 1440) % 1440;
  return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
}

module.exports = {
  toMinutesFromMidnight: toMinutesFromMidnight,
  toTimeString: toTimeString
};
