'use strict';

// Comprehensive Glucose Pentagon, Vigersky et al. (2018), DOI 10.1177/1932296817718561.
// The axis scaling and intensity conventions follow Nightscout Reporter
// (zreptil/nightscout-reporter-angular, MIT, c21559a1): low AUC is the
// deficit below 70; high AUC uses glucose at or above 180. Unlike Reporter,
// irregular samples are time-weighted and missing intervals are not filled.
const MIN_COVERAGE = 70;
const DAY_MINUTES = 1440;
const LOW = 70;
const HIGH = 180;
const DEGREE = 2 * Math.PI / 5;
const REFERENCE = [0, 16.7, 0, 0, 90];

function lengths(values) {
  const [out, cv, low, high, mean] = values;
  return [
    Math.pow(out * 0.00614, 1.581) + 14,
    Math.max(0, cv - 17) * 0.92 + 14,
    Math.exp(low * 0.00057) + 13,
    Math.pow(high * 0.000115, 1.51) + 14,
    Math.pow(Math.max(0, mean - 90) * 0.0217, 2.63) + 14
  ];
}

function area(axes) {
  return axes.reduce((total, axis, index) => total + axis * axes[(index + 1) % axes.length] * Math.sin(DEGREE) / 2, 0);
}

function calculate(prepared, profile) {
  const result = {available: false, coverage: prepared.pctActive, count: prepared.data.length, days: prepared.days.length};
  if (!result.count || !result.days) return {...result, reason: 'empty'};
  if (result.coverage + 1e-9 < MIN_COVERAGE) return {...result, reason: 'coverage'};

  const byDay = new Map();
  const ends = new Map(prepared.days.map(day => [day, profile.parseInTimezone(day).clone().add(1, 'day').startOf('day').valueOf()]));
  let minutes = 0, sum = 0, squares = 0, outside = 0;
  prepared.data.forEach(record => {
    const end = ends.get(record.day);
    const duration = Math.max(0, Math.min(record.interval, end - record.mills)) / 60000;
    if (!duration) return;
    const bg = record.bgValue;
    const day = byDay.get(record.day) || {minutes: 0, lowAuc: 0, lowTime: 0, highAuc: 0, highTime: 0};
    day.minutes += duration;
    if (bg <= LOW) { day.lowAuc += (LOW - bg) * duration; day.lowTime += duration; }
    if (bg >= HIGH) { day.highAuc += bg * duration; day.highTime += duration; }
    if (bg < LOW || bg > HIGH) outside += duration;
    byDay.set(record.day, day);
    minutes += duration;
    sum += bg * duration;
    squares += bg * bg * duration;
  });
  if (!minutes) return {...result, reason: 'empty'};
  const mean = sum / minutes;
  const cv = 100 * Math.sqrt(Math.max(0, squares / minutes - mean * mean)) / mean;
  let low = 0, high = 0;
  byDay.forEach(day => {
    // Estimate each intensity per 24 hours of observed time, then weight days
    // by their observed duration. Unobserved intervals are never interpolated.
    const scale = DAY_MINUTES / day.minutes;
    low += Math.hypot(day.lowAuc * scale, day.lowTime * scale) * day.minutes / minutes;
    high += Math.hypot(day.highAuc * scale, day.highTime * scale) * day.minutes / minutes;
  });
  const values = [outside / minutes * DAY_MINUTES, cv, low, high, mean];
  const axes = lengths(values);
  const reference = lengths(REFERENCE);
  const score = area(axes) / area(reference);
  if (!Number.isFinite(score)) return {...result, reason: 'invalid'};
  return {...result, available: true, values, axes, reference, score};
}

module.exports = {calculate, lengths, area, MIN_COVERAGE};
