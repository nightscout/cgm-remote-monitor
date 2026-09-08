'use strict';

const assert = require('node:assert/strict');
const moment = require('moment-timezone');
const profileFunctions = require('../lib/profilefunctions');
const dateTools = require('../lib/api3/shared/dateTools');

// Characterize existing application behavior before substituting a time library.
// These server fixtures do not establish browser timezone-data parity.
function profile(zone, units) {
  const ctx = require('./inithelper')().ctx;
  ctx.settings = Object.assign({}, ctx.settings, {units});
  return profileFunctions([{defaultProfile:'Default', startDate:'1980-01-01', store:{Default:{timezone:zone, dia:3, carbs_hr:30,
    carbratio:7, sens:35, target_low:95, target_high:120,
    basal:[{time:'00:00', timeAsSeconds:0, value:1},
      {time:'02:00', timeAsSeconds:7200, value:2},
      {time:'03:00', timeAsSeconds:10800, value:3}]}}}], ctx);
}

describe('Modernization date/time characterization', function () {
  for (const units of ['mg/dl', 'mmol']) {
    describe(units, function () {
      for (const group of require('./fixtures/timezone-2026c.json').groups) {
        for (const zone of group.zones) {
          it('applies updated timezone rules through the profile for ' + zone, function () {
            const p = profile(zone, units);
            try {
              for (let cycle = 0; cycle < 2; cycle++) {
                for (const [iso, expected, offset] of group.cases) {
                  const instant = moment.utc(iso);
                  const epoch = instant.valueOf();
                  const actual = p.applyTimezone(instant);
                  assert.equal(actual, instant);
                  assert.equal(actual.valueOf(), epoch);
                  assert.equal(actual.format('YYYY-MM-DD HH:mm:ss'), expected);
                  assert.equal(actual.utcOffset(), offset);
                }
              }
            } finally { p.clear(); }
          });
        }
      }
      for (const [zone, local, iso, offset] of [
        ['America/New_York', '2024-03-10T02:30:00', '2024-03-10T07:30:00.000Z', -240],
        ['America/New_York', '2024-11-03T01:30:00', '2024-11-03T05:30:00.000Z', -240],
        ['Australia/Lord_Howe', '2024-10-06T02:15:00', '2024-10-05T15:45:00.000Z', 660],
        ['Australia/Lord_Howe', '2024-04-07T01:45:00', '2024-04-06T14:45:00.000Z', 660],
        ['GMT+5:45', '2024-01-01', '2023-12-31T18:15:00.000Z', 345],
        ['GMT-3:30', '2024-01-01', '2024-01-01T03:30:00.000Z', -210]
      ]) {
        it('preserves profile parsing for ' + zone + ' / ' + local, function () {
          const p = profile(zone, units);
          const parsed = p.parseInTimezone(local);
          assert.equal(parsed.toISOString(), iso);
          assert.equal(parsed.utcOffset(), offset);
          p.clear();
        });
      }
      it('preserves instant identity and both occurrences of an overlapping local hour', function () {
        const p = profile('America/New_York', units);
        for (const [iso, offset] of [['2024-11-03T05:30:00Z', -240], ['2024-11-03T06:30:00Z', -300]]) {
          const input = moment.utc(iso);
          const instant = input.valueOf();
          assert.equal(p.applyTimezone(input), input, 'Existing API mutates and returns its argument');
          assert.equal(input.valueOf(), instant);
          assert.equal(input.format('HH:mm'), '01:30');
          assert.equal(input.utcOffset(), offset);
        }
        p.clear();
      });
      for (const [zone, local, next, hours] of [
        ['America/New_York', '2024-03-10', '2024-03-11T04:00:00.000Z', 23],
        ['America/New_York', '2024-11-03', '2024-11-04T05:00:00.000Z', 25],
        ['Australia/Lord_Howe', '2024-10-06', '2024-10-06T13:00:00.000Z', 23.5],
        ['Australia/Lord_Howe', '2024-04-07', '2024-04-07T13:30:00.000Z', 24.5]
      ]) {
        it('keeps report calendar-day bounds at midnight across ' + zone + ' / ' + local, function () {
          const p = profile(zone, units);
          try {
            const start = p.parseInTimezone(local + 'T00:00:00');
            const end = start.clone().add(1, 'day');
            assert.equal(end.toISOString(), next);
            assert.equal(end.format('HH:mm:ss'), '00:00:00');
            assert.equal(end.diff(start, 'hours', true), hours);
            assert.equal(start.format('YYYY-MM-DD HH:mm:ss'), local + ' 00:00:00');
          } finally {p.clear();}
        });
      }
      it('records existing elapsed-time basal selection at the spring gap (open discrepancy)', function () {
        const p = profile('America/New_York', units);
        for (let cycle = 0; cycle < 2; cycle++) {
          assert.equal(p.getBasal(Date.parse('2024-03-10T06:59:00Z')), 1);
          // Existing elapsed-time behavior selects 02:00 at civil 03:00.
          // Characterization only: see the open discrepancy in the M27 review.
          assert.equal(p.getBasal(Date.parse('2024-03-10T07:00:00Z')), 2);
        }
        p.clear();
      });
    });
  }

  it('retains API epoch-unit interpretation, parsed offset and first-valid array fallback', function () {
    const ms = Date.parse('2024-01-01T00:00:00Z');
    for (const value of [ms, ms / 1000, String(ms), String(ms / 1000)]) {
      assert.equal(dateTools.parseToMoment(value).valueOf(), ms);
    }
    const parsed = dateTools.parseToMoment([null, 'not-a-date', '2024-01-01T05:45:00+05:45']);
    assert.equal(parsed.valueOf(), ms);
    assert.equal(parsed.utcOffset(), 345);
    assert.equal(dateTools.parseToMoment('Mon, 01 Jan 2024 00:00:00 +0000').valueOf(), ms);
    for (const value of [null, 0, '', '2024-02-30', '2024-02-30 12:00:00',
      '2023-02-29', '2024-13-01', 'not-a-date', {}]) {
      assert.equal(dateTools.parseToMoment(value), null);
    }
  });
});
