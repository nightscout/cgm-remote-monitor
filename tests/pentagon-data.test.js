'use strict';
const assert = require('node:assert/strict');
const moment = require('moment-timezone');
const agp = require('../lib/report/agp-data');
const pentagon = require('../lib/report/pentagon');
const MIN = 60000;
const profile = zone => ({parseInTimezone: day => moment.tz(day, zone), applyTimezone: value => value.tz(zone)});
const record = (time, value) => ({displayTime: new Date(time), bgValue: value});
function fullDay(day, value, cadence = 5, zone = 'UTC') {
  const p = profile(zone), start = p.parseInTimezone(day), length = start.clone().add(1, 'day').diff(start, 'minutes');
  return Array.from({length: Math.ceil(length / cadence)}, (_, i) => record(start.valueOf() + i * cadence * MIN, typeof value === 'function' ? value(i, length / cadence) : value));
}
function calculate(records, days, zone = 'UTC', now = Date.UTC(2027, 0, 1)) {
  const p = profile(zone);
  return pentagon.calculate(agp.prepare(records, days, p, moment), p, now);
}
function close(actual, expected, tolerance = 1e-8) {assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);}

describe('Glucose pentagon calculations', function () {
  it('uses the published reference pentagon as PGR 1', function () {
    const axes = pentagon.lengths([0, 16.7, 0, 0, 90]);
    close(pentagon.area(axes), 5 * 14 * 14 * Math.sin(2 * Math.PI / 5) / 2);
    close(pentagon.area(axes) / pentagon.area(axes), 1);
  });
  it('uses independently calculated full-day low and high intensities', function () {
    const readings = fullDay('2026-10-01', i => i < 144 ? 60 : 200);
    const result = calculate(readings, ['2026-10-01']);
    assert.equal(result.available, true); close(result.coverage, 100);
    close(result.values[0], 1440); close(result.values[1], 7000 / 130);
    close(result.values[2], Math.hypot(10 * 720, 720));
    close(result.values[3], Math.hypot(200 * 720, 720));
    close(result.values[4], 130);
    // Independent hand-calculated area from the published five axis formulas.
    const axes = [Math.pow(1440 * 0.00614, 1.581) + 14, (7000 / 130 - 17) * 0.92 + 14,
      Math.exp(Math.hypot(7200, 720) * 0.00057) + 13,
      Math.pow(Math.hypot(144000, 720) * 0.000115, 1.51) + 14,
      Math.pow(40 * 0.0217, 2.63) + 14];
    const polygon = axes.reduce((sum, x, i) => sum + x * axes[(i + 1) % 5], 0);
    close(result.score, polygon / (5 * 14 * 14));
  });
  for (const cadence of [1, 2, 5]) {
    it('has equivalent results for a full day at ' + cadence + '-minute cadence', function () {
      const result = calculate(fullDay('2026-10-01', 100, cadence), ['2026-10-01']);
      assert.equal(result.available, true); close(result.coverage, 100);
      close(result.values[0], 0); close(result.values[1], 0); close(result.values[4], 100);
    });
  }
  it('does not produce NaN for glucose below the reference mean', function () {
    const result = calculate(fullDay('2026-10-01', 60), ['2026-10-01']);
    assert.equal(result.available, true); assert.ok(Number.isFinite(result.score));
    close(result.values[4], 60); assert.ok(result.values[2] > 0);
  });
  it('uses the same inclusive boundary convention as Reporter', function () {
    const result = calculate(fullDay('2026-10-01', i => i < 144 ? 70 : 180), ['2026-10-01']);
    close(result.values[0], 0);
    close(result.values[2], 720);
    close(result.values[3], Math.hypot(180 * 720, 720));
  });
  it('withholds the score for missing, sparse and less than 70% coverage', function () {
    assert.equal(calculate([], ['2026-10-01']).reason, 'empty');
    const start = Date.UTC(2026, 9, 1);
    const sparse = calculate([record(start, 100), record(start + 1435 * MIN, 100)], ['2026-10-01']);
    assert.equal(sparse.reason, 'coverage'); assert.equal(sparse.score, undefined);
    const low = calculate(fullDay('2026-10-01', 100).slice(0, 201), ['2026-10-01']);
    const enough = calculate(fullDay('2026-10-01', 100).slice(0, 202), ['2026-10-01']);
    assert.equal(low.available, false); assert.equal(enough.available, true);
  });
  it('unions interleaved five-minute streams from distinct devices without double counting', function () {
    const original = fullDay('2026-10-01', 100).map(r => ({...r, device: 'sensor-a'}));
    const interleaved = original.flatMap(r => [r, {...record(r.displayTime.valueOf() + MIN, 100), device: 'sensor-b'}]);
    const unique = require('../lib/report/uniqsgv')(interleaved.map(r => ({mills: r.displayTime.valueOf(), bgValue: r.bgValue, device: r.device})))
      .map(r => ({...record(r.mills, r.bgValue), device: r.device}));
    const result = calculate(unique, ['2026-10-01']);
    assert.equal(result.available, true); close(result.coverage, 100);
    close(result.score, calculate(original, ['2026-10-01']).score);
  });
  it('counts conflicting overlapping readings once, using the most recent', function () {
    const first = fullDay('2026-10-01', 100).map(r => ({...r, device: 'sensor-a'}));
    const second = first.map(r => ({...record(r.displayTime.valueOf() + MIN, 200), device: 'sensor-b'}));
    const result = calculate(first.concat(second), ['2026-10-01']);
    assert.equal(result.available, true); close(result.coverage, 100); close(result.values[4], 180);
  });
  it('withholds the score when overlapping uploads cannot be distinguished from missing readings', function () {
    const original = fullDay('2026-10-01', 100);
    const ambiguous = original.flatMap(r => [r, record(r.displayTime.valueOf() + MIN, 100)]);
    const result = calculate(ambiguous, ['2026-10-01']);
    assert.equal(result.available, false); assert.equal(result.reason, 'ambiguous'); close(result.coverage, 40);
  });
  it('uses only elapsed time today and excludes future readings', function () {
    const now = Date.UTC(2026, 9, 1, 12);
    const readings = fullDay('2026-10-01', 110).slice(0, 144);
    const result = calculate(readings, ['2026-10-01'], 'UTC', now);
    assert.equal(result.available, true); close(result.coverage, 100); assert.equal(result.count, 144);
    const withFuture = calculate(readings.concat(record(now + MIN, 600)), ['2026-10-01'], 'UTC', now);
    close(withFuture.coverage, result.coverage); close(withFuture.score, result.score); assert.equal(withFuture.count, 144);
    assert.equal(calculate([record(now + MIN, 100)], ['2026-10-01'], 'UTC', now).reason, 'empty');
  });
  it('uses elapsed local time on the current daylight-saving day', function () {
    const day = '2026-03-29', zone = 'Europe/Oslo';
    const now = moment.tz(day + ' 12:00', zone).valueOf();
    const readings = fullDay(day, 100, 5, zone).filter(r => r.displayTime.valueOf() < now);
    const result = calculate(readings, [day], zone, now);
    assert.equal(result.available, true); close(result.coverage, 100);
  });
  it('apportions readings that cross midnight to both selected days', function () {
    const first = fullDay('2026-10-01', 100).map(r => record(r.displayTime.valueOf() + MIN, 100));
    const second = fullDay('2026-10-02', 100).map(r => record(r.displayTime.valueOf() + MIN, 100));
    const result = calculate(first.concat(second), ['2026-10-01', '2026-10-02']);
    assert.equal(result.available, true); close(result.coverage, 100 * (2880 - 1) / 2880);
  });
  it('does not impute a long gap even when overall coverage is sufficient', function () {
    const readings = fullDay('2026-10-01', 100).filter((_, i) => i < 100 || i >= 148);
    const result = calculate(readings, ['2026-10-01']);
    assert.equal(result.available, true); close(result.coverage, 100 * 240 / 288);
    close(result.values[0], 0); close(result.values[4], 100);
  });
  it('includes entirely missing days in the coverage denominator', function () {
    const result = calculate(fullDay('2026-10-01', 100), ['2026-10-01', '2026-10-02']);
    close(result.coverage, 50); assert.equal(result.reason, 'coverage');
  });
  it('normalizes intensity to observed time rather than treating a gap as zero exposure', function () {
    const full = calculate(fullDay('2026-10-01', 200), ['2026-10-01']);
    const partial = calculate(fullDay('2026-10-01', 200).slice(0, 220), ['2026-10-01']);
    close(partial.values[3], full.values[3]); close(partial.score, full.score);
  });
  it('deduplicates timestamps, ignores invalid records and is invariant to sorting', function () {
    const entries = fullDay('2026-10-01', i => i < 144 ? 90 : 180);
    const baseline = calculate(entries, ['2026-10-01']);
    const other = calculate([...entries, entries[0], record('2026-10-01T12:00:00Z', 700), record('2026-10-01T12:00:00Z', 10)].reverse(), ['2026-10-01']);
    close(other.score, baseline.score); close(other.coverage, baseline.coverage);
  });
  for (const [day, hours] of [['2026-03-29', 23], ['2026-10-25', 25]]) {
    it('uses the full ' + hours + '-hour local day across a clock change', function () {
      const result = calculate(fullDay(day, 200, 5, 'Europe/Oslo'), [day], 'Europe/Oslo');
      assert.equal(result.available, true); close(result.coverage, 100);
      close(result.values[3], Math.hypot(200 * 1440, 1440));
    });
  }
});
