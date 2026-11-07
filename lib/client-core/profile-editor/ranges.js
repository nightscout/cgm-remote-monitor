'use strict';

function addRangeStop (arr, atIndex) {
  var pos = parseInt(atIndex, 10);
  if (isNaN(pos) || pos < 0) pos = 0;
  if (pos > arr.length) pos = arr.length;
  arr.splice(pos, 0, { time: '00:00', value: 0 });
  return arr;
}

function removeRangeStop (arr, atIndex) {
  if (arr.length <= 1) return arr;
  var pos = parseInt(atIndex, 10);
  if (isNaN(pos) || pos < 0 || pos >= arr.length) return arr;
  arr.splice(pos, 1);
  arr[0].time = '00:00';
  return arr;
}

function addTargetStop (lowArr, highArr, atIndex) {
  addRangeStop(lowArr, atIndex);
  addRangeStop(highArr, atIndex);
  return { target_low: lowArr, target_high: highArr };
}

function removeTargetStop (lowArr, highArr, atIndex) {
  removeRangeStop(lowArr, atIndex);
  removeRangeStop(highArr, atIndex);
  return { target_low: lowArr, target_high: highArr };
}

module.exports = {
  addRangeStop: addRangeStop,
  removeRangeStop: removeRangeStop,
  addTargetStop: addTargetStop,
  removeTargetStop: removeTargetStop
};
