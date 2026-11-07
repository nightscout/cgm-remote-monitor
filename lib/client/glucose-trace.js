'use strict';

var FIVE_MINUTES = 5 * 60 * 1000;

function valid (point, minimum) {
  return Number.isFinite(point.mills) && Number.isFinite(point.mgdl) &&
    point.mgdl >= (minimum || 39) && point.color !== 'transparent';
}

// Infer the sampling interval conservatively for both 1-minute and 5-minute
// sources. Never bridge an interval longer than 7.5 minutes. Error records
// remain in the sequence so that they break a line rather than being skipped.
function segments (points, minimum) {
  function isValid (point) { return valid(point, minimum); }
  var sorted = points.slice().sort(function (a, b) { return a.mills - b.mills; });
  var intervals = [];
  sorted.forEach(function (point, index) {
    if (!index) return;
    var previous = sorted[index - 1];
    var interval = point.mills - previous.mills;
    if (isValid(point) && isValid(previous) && interval > 0 && interval <= FIVE_MINUTES) intervals.push(interval);
  });
  intervals.sort(function (a, b) { return a - b; });
  var cadence = intervals.length ? intervals[Math.floor((intervals.length - 1) / 2)] : FIVE_MINUTES;
  var maxGap = Math.min(FIVE_MINUTES, cadence) * 1.5;
  var result = [];
  var run;
  sorted.forEach(function (point, index) {
    var previous = sorted[index - 1];
    if (!isValid(point) || !previous || !isValid(previous) || point.mills <= previous.mills || point.mills - previous.mills > maxGap) {
      run = null;
      return;
    }
    var color = point.color || 'grey';
    if (!run || run.color !== color) {
      run = { color: color, points: [previous, point] };
      result.push(run);
    } else {
      run.points.push(point);
    }
  });
  return result;
}

function forecasts (points) {
  var groups = new Map();
  points.forEach(function (point) {
    // AR2 supplies explicit cone branches; OpenAPS supplies forecastType.
    // Include provider and colour so unrelated predictions are never joined.
    var key = JSON.stringify([point.info && point.info.type, point.forecastType, point.forecastSeries, point.color]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(point);
  });
  var result = [];
  groups.forEach(function (group) { result = result.concat(segments(group, 13)); });
  return result;
}

module.exports = { segments: segments, forecasts: forecasts, valid: valid };
