'use strict';
const assert = require('node:assert/strict');
const moment = require('moment-timezone');
const model = require('../lib/report/agp-data');
const profile = timezone => ({parseInTimezone: value => moment.tz(value, timezone), applyTimezone: value => value.tz(timezone)});
const record = (date, bgValue = 120) => ({displayTime: new Date(date), bgValue});
const minute = 60000;

describe('AGP calendar data and coverage', function () {
  for (const cadence of [1, 2, 5]) {
    it('estimates one hour of ' + cadence + '-minute readings as the same fraction of a day', function () {
      const data = Array.from({length: 60 / cadence}, (_, i) => record(Date.UTC(2026, 9, 1) + i * cadence * minute));
      const before = JSON.stringify(data);
      const result = model.prepare(data.slice().reverse(), ['2026-10-01'], profile('UTC'), moment);
      assert.ok(Math.abs(result.pctActive - 100 / 24) < 1e-10);
      assert.equal(JSON.stringify(data), before);
    });
  }
  for (const [day, hours] of [['2026-03-29', 23], ['2026-10-25', 25]]) {
    it('uses the actual ' + hours + '-hour calendar denominator on ' + day, function () {
      const zone = profile('Europe/Oslo');
      const start = zone.parseInTimezone(day).valueOf();
      const data = Array.from({length: hours * 12}, (_, i) => record(start + i * 5 * minute));
      const result = model.prepare(data, [day, day], zone, moment);
      assert.equal(result.pctActive, 100);
      assert.equal(result.data.length, hours * 12);
    });
  }
  it('handles midnight jumps without attributing the next day to the selected day', function () {
    const zone = profile('America/Santiago'), day = '2026-09-06';
    const start = zone.parseInTimezone(day).valueOf();
    const data = Array.from({length: 23 * 12}, (_, i) => record(start + i * 5 * minute));
    data.push(record(start + 23 * 60 * minute));
    const result = model.prepare(data, [day], zone, moment);
    assert.equal(result.pctActive, 100);
    assert.equal(result.data[0].minute, 60);
    assert.equal(result.data.length, 276);
  });
  it('retains simultaneous readings only when explicitly requested', function () {
    const at = Date.UTC(2026, 9, 1);
    const data = [record(at, 100), record(at, 200)];
    const normal = model.prepare(data, ['2026-10-01'], profile('UTC'), moment);
    const simultaneous = model.prepare(data, ['2026-10-01'], profile('UTC'), moment, {preserveSimultaneous: true});
    assert.equal(normal.data.length, 1);
    assert.deepEqual(simultaneous.data.map(row => row.bgValue), [100, 200]);
  });
  it('does not count a twelve-hour absence as CGM coverage', function () {
    const start = Date.UTC(2026, 9, 1);
    const result = model.prepare([record(start), record(start + 12 * 60 * minute)], ['2026-10-01'], profile('UTC'), moment);
    assert.ok(Math.abs(result.pctActive - 100 * 10 / 1440) < 1e-10);
    assert.equal(model.dailyPoints(result.data, value => value).filter(point => point.v === null).length, 1);
  });
  it('uses profile clock/date keys, deduplicates timestamps and rejects invalid or unselected data', function () {
    const at = '2026-10-24T23:00:00Z';
    const result = model.prepare([record(at), record(at), record(at, NaN), record('bad'), record(at, Infinity), record(at, 20),
      record('2026-10-23T23:00:00Z')], ['2026-10-25'], profile('Europe/Oslo'), moment);
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].day, '2026-10-25');
    assert.equal(result.data[0].minute, 60);
  });
  it('keeps empty selected days in the coverage denominator', function () {
    const result = model.prepare([record('2026-10-01T12:00:00Z')], ['2026-10-02', '2026-10-01'], profile('UTC'), moment);
    assert.deepEqual(result.days, ['2026-10-01', '2026-10-02']);
    assert.ok(Math.abs(result.pctActive - 100 * 5 / 2880) < 1e-10);
    assert.equal(model.prepare([], [], profile('UTC'), moment).pctActive, 0);
  });
  it('breaks a daily trace when the local clock moves backwards', function () {
    const result = model.prepare([record('2026-10-25T02:55:00+02:00'), record('2026-10-25T02:00:00+01:00')],
      ['2026-10-25'], profile('Europe/Oslo'), moment);
    const points = model.dailyPoints(result.data, value => value);
    assert.deepEqual(points.map(point => point.v), [120, null, 120]);
    assert.equal(points[2].t, 120);
  });
});
