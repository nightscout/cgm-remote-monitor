'use strict';

const assert = require('node:assert/strict');
const moment = require('moment-timezone');
const adjustments = require('../lib/report/basal-adjustments');
const createProfile = require('../lib/profilefunctions');
const HOUR = 3600000;
const DAY = '2026-10-21';
const START = Date.parse(DAY + 'T00:00:00Z');
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, actual + ' != ' + expected);

function record (startDate = '2020-01-01T00:00:00Z', rate = 1) {
  return {startDate, defaultProfile: 'Default', store: {Default: {timezone: 'UTC', units: 'mg/dl', basal: [{time: '00:00', value: rate}]}}};
}
function calculator (temps = [], records = [record()]) {
  const profile = createProfile(null, {moment});
  return adjustments.prepare(profile, {profiles: records, tempbasalTreatments: temps}, moment).calculate;
}

describe('Chart-independent basal adjustments', function () {
  it('integrates absolute, suspended and percentage temporary basals with the real profile model', function () {
    const calculate = calculator([
      {mills: START, duration: 30, absolute: 0},
      {mills: START + 75 * 60000, duration: 30, absolute: 2},
      {mills: START + 210 * 60000, duration: 30, percent: 50}
    ]);
    const result = calculate(DAY);
    close(result.negative[0], -.5); close(result.positive[1], .5); close(result.positive[3], .25);
    close(result.base, 24); close(result.positiveTotal, .75); close(result.negativeTotal, -.5);
  });

  it('uses historical profiles when the scheduled basal changes within the day', function () {
    const calculate = calculator([{mills: START + 13 * HOUR, duration: 30, percent: 50}],
      [record(DAY + 'T12:00:00Z', 2), record()]);
    const result = calculate(DAY);
    close(result.base, 36); close(result.positive[13], .5);
  });

  it('includes a temporary basal carried over from the previous day', function () {
    const result = calculator([{mills: START - 30 * 60000, duration: 120, absolute: 2}])(DAY);
    close(result.positive[0], 1); close(result.positive[1], .5); close(result.positiveTotal, 1.5);
  });

  it('keeps genuine zero basal and zero adjustments available', function () {
    const result = calculator([], [record('2020-01-01T00:00:00Z', 0)])(DAY);
    assert.equal(result.base, 0);
    assert.deepEqual(result.positive, Array(24).fill(0));
    assert.deepEqual(result.negative, Array(24).fill(0));
  });

  it('does not use a stale client profile when loaded report profiles are missing', function () {
    const profile = createProfile([record()], {moment});
    assert.equal(adjustments.prepare(profile, {profiles: []}, moment).calculate(DAY), null);
  });

  it('marks dates before the first loaded profile unavailable', function () {
    const result = calculator([], [record('2026-10-22T00:00:00Z')])(DAY);
    assert.deepEqual(result.positive, Array(24).fill(null));
    assert.ok(Number.isNaN(result.base));
  });

  it('preserves legacy profile history across repeated preparation', function () {
    const data = {profiles: [{startDate: '2026-10-22T00:00:00Z', timezone: 'UTC', basal: [{time: '00:00', value: 1}]}]};
    const original = JSON.stringify(data);
    const profile = createProfile(null, {moment});
    for (let i = 0; i < 2; i++) {
      const result = adjustments.prepare(profile, data, moment).calculate(DAY);
      assert.deepEqual(result.positive, Array(24).fill(null));
      assert.equal(JSON.stringify(data), original);
    }
  });

  it('isolates embedded profile switches, temp basal records and caches from the client and source data', function () {
    const profile = createProfile([record()], {moment});
    const data = {profiles: [record()], profileSwitchTreatments: [{mills: START + 6 * HOUR,
      profile: 'Exercise', duration: 60, profileJson: JSON.stringify({timezone: 'UTC', basal: [{time: '00:00', value: .5}]})}],
    tempbasalTreatments: [{mills: START + 6 * HOUR, duration: 30, absolute: 1}], combobolusTreatments: []};
    const original = JSON.stringify(data), originalClient = JSON.stringify(profile.data);
    const prepared = adjustments.prepare(profile, data, moment);
    assert.notEqual(prepared.profile, profile);
    for (const day of [DAY, '2026-10-22', DAY]) {
      const result = prepared.calculate(day);
      if (day === DAY) { close(result.base, 23.5); close(result.positive[6], .25); }
      assert.equal(JSON.stringify(data), original);
      assert.equal(JSON.stringify(profile.data), originalClient);
      assert.equal(profile.getBasal(START + 6 * HOUR), 1);
      assert.equal(profile.tempbasaltreatments.length, 0);
      assert.equal(profile.profiletreatments.length, 0);
    }
  });

  it('uses report calendar hours with historical schedule timezones without changing the client timezone', function () {
    const profile = createProfile([record()], {moment});
    const historical = record();
    historical.store.Default.timezone = 'America/New_York';
    historical.store.Default.basal.push({time: '12:00', value: 2});
    const data = {profiles: [historical], tempbasalTreatments: [{mills: START + HOUR, duration: 60, absolute: 3}]};
    const result = adjustments.prepare(profile, data, moment).calculate(DAY);
    // Report midnight is UTC; the New York schedule changes at 16:00 UTC.
    // The preceding New York evening contributes four hours at 2 U/h.
    close(result.base, 36); close(result.positive[1], 1);
    close(result.positiveTotal, 1);
    assert.equal(profile.getTimezone(), 'UTC');
    assert.equal(profile.parseInTimezone(DAY).valueOf(), START);
  });

  function fixedProfile (zone, invalidHour) {
    return {
      parseInTimezone: value => moment.tz(value, zone), applyTimezone: value => value.tz(zone),
      getBasalRenderTimes: (start, end) => Array.from({length: (end - start) / HOUR + 1}, (_, i) => Math.min(end, start + i * HOUR)),
      getTempBasal: at => moment.tz(at, zone).hour() === invalidHour ? {basal: undefined, tempbasal: undefined} : {basal: 1, tempbasal: 2}
    };
  }

  it('keeps incomplete profile hours unavailable and out of complete daily totals', function () {
    const result = adjustments.calculate(fixedProfile('UTC', 2), DAY, moment);
    assert.equal(result.positive[2], null); assert.equal(result.positive[1], 1);
    assert.ok(Number.isNaN(result.base));
  });

  for (const [zone, day, hours, specialHour, expected] of [
    ['Europe/London', '2026-03-29', 23, 1, null],
    ['Europe/London', '2026-10-25', 25, 1, 2],
    ['America/New_York', '2026-03-08', 23, 2, null],
    ['America/New_York', '2026-11-01', 25, 1, 2],
    ['Australia/Lord_Howe', '2026-10-04', 23.5, 2, .5],
    ['Australia/Lord_Howe', '2026-04-05', 24.5, 1, 1.5]
  ]) {
    it('accounts for ' + hours + ' elapsed hours on ' + day + ' in ' + zone, function () {
      const profile = fixedProfile(zone);
      // Deliberately span the entire day with one rate interval to exercise
      // local-hour splitting, including half-hour DST changes.
      profile.getBasalRenderTimes = (start, end) => [start, end];
      const result = adjustments.calculate(profile, day, moment);
      close(result.base, hours); close(result.positiveTotal, hours);
      assert.equal(result.positive[specialHour], expected);
    });
  }

  it('assigns hours in a quarter-hour-offset timezone', function () {
    const profile = fixedProfile('Asia/Kathmandu');
    profile.getBasalRenderTimes = (start, end) => [start, end];
    const result = adjustments.calculate(profile, DAY, moment);
    assert.deepEqual(result.positive, Array(24).fill(1));
  });
});
