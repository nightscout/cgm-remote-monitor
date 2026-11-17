'use strict';

const FIVE_MINUTES = 5 * 60 * 1000;

// A report day is a calendar day in the profile zone, including DST changes.
function prepare(records, selectedDays, profile, moment, options = {}) {
  const days = Array.from(new Set(selectedDays)).sort();
  const bounds = new Map(days.map(day => {
    const start = profile.parseInTimezone(day);
    return [day, [start.valueOf(), start.clone().add(1, 'day').startOf('day').valueOf()]];
  }));
  const seen = new Set();
  const data = [];
  records.forEach(record => {
    if (!record || record.displayTime == null || !Number.isFinite(record.bgValue) || record.bgValue < 39 || record.bgValue > 600) return;
    const mills = new Date(record.displayTime).getTime();
    if (!Number.isFinite(mills) || (!options.preserveSimultaneous && seen.has(mills))) return;
    const local = profile.applyTimezone(moment(mills));
    const day = local.format('YYYY-MM-DD');
    if (!bounds.has(day)) return;
    seen.add(mills);
    data.push({mills, bgValue: record.bgValue, day, minute: local.hour() * 60 + local.minute() + local.second() / 60, device: record.device});
  });
  data.sort((a, b) => a.mills - b.mills);
  let covered = 0;
  data.forEach((record, index) => {
    // Nearby sample intervals estimate 1-, 2- or 5-minute cadence. A long gap
    // contributes at most one sample interval, never the whole missing span.
    const before = index ? record.mills - data[index - 1].mills : FIVE_MINUTES;
    const after = index + 1 < data.length ? data[index + 1].mills - record.mills : FIVE_MINUTES;
    record.interval = Math.min(FIVE_MINUTES, before, after);
    covered += Math.max(0, Math.min(record.mills + record.interval, bounds.get(record.day)[1]) - record.mills);
  });
  const elapsed = Array.from(bounds.values()).reduce((total, [start, end]) => total + end - start, 0);
  return {data, days, pctActive: elapsed ? 100 * covered / elapsed : 0};
}

// Retain elapsed order across a repeated hour and break at missing samples or
// clock reversal instead of drawing a line backwards across the daily overlay.
function dailyPoints(records, toDisplay) {
  const points = [];
  records.forEach((record, index) => {
    const previous = records[index - 1];
    if (previous && (record.mills - previous.mills > 1.5 * Math.min(previous.interval, record.interval) || record.minute <= previous.minute)) {
      points.push({t: record.minute, v: null});
    }
    points.push({t: record.minute, v: toDisplay(record.bgValue)});
  });
  return points;
}

module.exports = {prepare, dailyPoints};
