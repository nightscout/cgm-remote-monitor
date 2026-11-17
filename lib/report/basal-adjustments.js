'use strict';

const HOUR = 60 * 60 * 1000;

function calculate (profile, day, moment, validFrom = -Infinity, calendar = profile) {
  if (profile.hasData && !profile.hasData()) return null;
  const from = calendar.parseInTimezone(day);
  const to = from.clone().add(1, 'day');
  if (!from.isValid() || !to.isValid()) return null;
  const start = from.valueOf(), end = to.valueOf();
  const boundaries = Array.from(new Set([start, end].concat(profile.getBasalRenderTimes(start, end, 5 * 60000))))
    .filter(time => Number.isFinite(time) && time >= start && time <= end).sort((a, b) => a - b);
  const positive = Array(24).fill(0), negative = Array(24).fill(0);
  const seen = Array(24).fill(false), unknown = Array(24).fill(false);
  let base = 0;
  for (let i = 0; i < boundaries.length - 1; i++) {
    const value = profile.getTempBasal(boundaries[i]);
    const valid = boundaries[i] >= validFrom && value && Number.isFinite(value.basal) && value.basal >= 0 &&
      Number.isFinite(value.tempbasal) && value.tempbasal >= 0;
    // Split intervals at local hour boundaries. Repeated DST hours share a bin;
    // skipped hours remain unavailable rather than looking like a zero dose.
    let cursor = boundaries[i];
    while (cursor < boundaries[i + 1]) {
      const local = calendar.applyTimezone(moment(cursor));
      const hour = local.hour();
      const nextHour = cursor + HOUR - local.minutes() * 60000 - local.seconds() * 1000 - local.milliseconds();
      if (!Number.isFinite(nextHour) || nextHour <= cursor) return null;
      const stop = Math.min(boundaries[i + 1], nextHour);
      const duration = (stop - cursor) / HOUR;
      seen[hour] = true;
      if (!valid) unknown[hour] = true;
      else {
        const adjustment = (value.tempbasal - value.basal) * duration;
        positive[hour] += Math.max(0, adjustment);
        negative[hour] += Math.min(0, adjustment);
        base += value.basal * duration;
      }
      cursor = stop;
    }
  }
  for (let hour = 0; hour < 24; hour++) {
    if (!seen[hour] || unknown[hour]) positive[hour] = negative[hour] = null;
  }
  const complete = !unknown.some(Boolean);
  return {positive, negative, base: complete ? base : NaN,
    positiveTotal: complete ? positive.reduce((sum, value) => sum + (value || 0), 0) : NaN,
    negativeTotal: complete ? negative.reduce((sum, value) => sum + (value || 0), 0) : NaN};
}

function prepare (calendar, data, moment) {
  const copy = value => JSON.parse(JSON.stringify(value || []));
  const records = data.profiles || [];
  const ready = records.length > 0;
  const validFrom = Math.min(...records.map(record => new Date(record.startDate || '1980-01-01').getTime()));
  // Profile conversion and embedded profile switches mutate their inputs. Keep
  // those mutations and caches local; the editor and other reports share data.
  const profile = calendar.createInstance(copy(records));
  const switches = copy(data.profileSwitchTreatments), temps = copy(data.tempbasalTreatments), combos = copy(data.combobolusTreatments);
  const reset = () => profile.updateTreatments(switches, temps, combos);
  reset();
  return {profile, reset, calculate (day) {
    if (!ready) return null;
    reset();
    // Calendar boundaries/bins match the timezone used to fetch the report.
    // Basal rates still come from the historical profiles and their schedules.
    try { return calculate(profile, day, moment, validFrom, calendar); }
    finally { reset(); }
  }};
}

module.exports = {calculate, prepare};
