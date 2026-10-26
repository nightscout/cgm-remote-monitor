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

function calculate(prepared, profile, now = Date.now()) {
  // Coverage ends at the current time: future hours are not missing data.
  // Keep this calculation separate from AGP, whose coverage is unchanged.
  const bounds = new Map(prepared.days.map(day => {
    const start = profile.parseInTimezone(day).startOf('day');
    const next = start.clone().add(1, 'day').startOf('day');
    return [day, {start: start.valueOf(), end: Math.min(now, next.valueOf()), nextDay: next.format('YYYY-MM-DD')}];
  }));
  const data = prepared.data.filter(record => {
    const day = bounds.get(record.day);
    return day && record.mills >= day.start && record.mills < day.end;
  });
  const result = {available: false, coverage: 0, count: data.length, days: prepared.days.length};
  if (!result.count || !result.days) return {...result, reason: 'empty'};

  let elapsed = 0, minutes = 0, sum = 0, squares = 0, outside = 0;
  bounds.forEach(day => { elapsed += Math.max(0, day.end - day.start); });
  const byDay = new Map();
  function addObservation(dayKey, bg, duration) {
    if (duration <= 0) return;
    const day = byDay.get(dayKey) || {minutes: 0, lowAuc: 0, lowTime: 0, highAuc: 0, highTime: 0};
    day.minutes += duration;
    if (bg <= LOW) { day.lowAuc += (LOW - bg) * duration; day.lowTime += duration; }
    if (bg >= HIGH) { day.highAuc += bg * duration; day.highTime += duration; }
    if (bg < LOW || bg > HIGH) outside += duration;
    byDay.set(dayKey, day);
    minutes += duration;
    sum += bg * duration;
    squares += bg * bg * duration;
  }
  const maxInterval = 5 * 60000;
  const sources = new Map();
  data.forEach(record => {
    const source = typeof record.device === 'string' && record.device ? record.device : '';
    if (!sources.has(source)) sources.set(source, []);
    sources.get(source).push(record);
  });
  const events = [];
  let ambiguous = false;
  sources.forEach(readings => {
    let alternating = 0;
    for (let i = 2; i < readings.length; i++) {
      const first = readings[i - 1].mills - readings[i - 2].mills;
      const second = readings[i].mills - readings[i - 1].mills;
      if ((first <= 60000 && second >= 180000 && second <= maxInterval) ||
          (second <= 60000 && first >= 180000 && first <= maxInterval)) alternating++;
    }
    // Without distinct source identities, alternating short/long gaps can be
    // either duplicate uploads or a faster sensor with missing readings.
    if (alternating >= 3 && alternating >= (readings.length - 2) / 2) ambiguous = true;
    readings.forEach((record, index) => {
      const before = index ? record.mills - readings[index - 1].mills : maxInterval;
      const after = index + 1 < readings.length ? readings[index + 1].mills - record.mills : maxInterval;
      const end = Math.min(now, record.mills + maxInterval, record.mills + before, record.mills + after);
      if (end > record.mills) {
        events.push({time: record.mills, start: true, record});
        events.push({time: end, start: false, record});
      }
    });
  });
  // Union each source's observed intervals. During overlaps, use the most
  // recent observation once; adding intervals would inflate coverage and bias
  // the statistics. Process end events before starts at the same timestamp.
  events.sort((a, b) => a.time - b.time || Number(a.start) - Number(b.start));
  const active = new Set();
  let previousTime = events.length ? events[0].time : 0;
  events.forEach(event => {
    if (event.time > previousTime && active.size) {
      let latest;
      active.forEach(record => { if (!latest || record.mills > latest.mills) latest = record; });
      const day = bounds.get(latest.day);
      addObservation(latest.day, latest.bgValue, Math.max(0, Math.min(event.time, day.end) - Math.max(previousTime, day.start)) / 60000);
      const next = bounds.get(day.nextDay);
      if (next) addObservation(day.nextDay, latest.bgValue, Math.max(0, Math.min(event.time, next.end) - Math.max(previousTime, next.start)) / 60000);
    }
    if (event.start) active.add(event.record); else active.delete(event.record);
    previousTime = event.time;
  });
  result.coverage = elapsed ? 100 * minutes * 60000 / elapsed : 0;
  if (ambiguous) return {...result, reason: 'ambiguous'};
  if (result.coverage + 1e-9 < MIN_COVERAGE) return {...result, reason: 'coverage'};
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
