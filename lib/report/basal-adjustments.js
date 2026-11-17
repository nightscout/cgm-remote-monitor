'use strict';

const HOUR = 60 * 60 * 1000;

function calculate (profile, day, moment, validFrom = -Infinity) {
  if (profile.hasData && !profile.hasData()) return null;
  const from = profile.parseInTimezone(day);
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
      const local = profile.applyTimezone(moment(cursor));
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

function prepare (profile, data, moment) {
  const records = data.profiles || [];
  const ready = records.length > 0;
  const validFrom = Math.min(...records.map(record => new Date(record.startDate || '1980-01-01').getTime()));
  const resetTreatments = () => profile.updateTreatments(data.profileSwitchTreatments || [], data.tempbasalTreatments || [], data.combobolusTreatments || []);
  if (ready) {
    // Legacy profile conversion deletes fields and preprocesses schedules.
    // Keep the report's source records intact across tab changes and refreshes.
    profile.loadData(JSON.parse(JSON.stringify(records)));
    resetTreatments();
  }
  return day => {
    if (!ready) return null;
    resetTreatments();
    try { return calculate(profile, day, moment, validFrom); }
    // Keep report-wide sampling from retaining every day's profile cache.
    finally { resetTreatments(); }
  };
}

module.exports = {calculate, prepare};
