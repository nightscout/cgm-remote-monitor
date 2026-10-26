'use strict';

require('should');
const moment = require('moment-timezone');

const FIVE_MINUTES = 5 * 60 * 1000;
const DAY = '2026-10-01';
const NEXT_DAY = '2026-10-02';
const TIMEZONE = 'Europe/Oslo';

describe('loopalyzer SGV slots', function () {
  let loopalyzer;
  let profile;
  let previousWindow;

  before(function () {
    previousWindow = Object.getOwnPropertyDescriptor(global, 'window');
    global.window = { moment: moment };
    delete require.cache[require.resolve('../lib/report_plugins/loopalyzer')];
    loopalyzer = require('../lib/report_plugins/loopalyzer')();
    profile = require('../lib/profilefunctions')([{
      defaultProfile: 'Default'
      , startDate: '1980-01-01'
      , store: { Default: { timezone: TIMEZONE, dia: 3 } }
    }], { moment: moment });
  });

  after(function () {
    delete require.cache[require.resolve('../lib/report_plugins/loopalyzer')];
    if (previousWindow) {
      Object.defineProperty(global, 'window', previousWindow);
    } else {
      delete global.window;
    }
  });

  // One reading per offset (ms from local midnight of `day`), valued first, first + 1, ...
  function readings (day, offsets, first) {
    const midnight = moment.tz(day, TIMEZONE).valueOf();
    first = first || 100;
    return offsets.map(function (offset, index) {
      return { sgv: first + index, bgValue: first + index, displayTime: new Date(midnight + offset) };
    });
  }

  function slots (records, days) {
    return loopalyzer.getSGVs({ allstatsrecords: records }, days, profile);
  }

  function firstDay (bins) {
    return bins.map(function (bin) { return bin[1][0]; });
  }

  it('puts a reading that is exactly on a 5 minute mark in the slot that starts there', function () {
    const offsets = [];
    for (let i = 0; i < 288; i++) offsets.push(i * FIVE_MINUTES);

    const values = firstDay(slots(readings(DAY, offsets), [DAY]));

    values.forEach(function (value, i) {
      value.should.equal(100 + i);
    });
  });

  it('leaves no gap when readings land a fraction of a second either side of the marks', function () {
    // The odd-numbered offsets come from real uploaded entries. The others are a little late.
    const jitter = [-386.887, 200, -903.745, 300.5, -259.597, 100, -721.558, 450, -1056.345, 50, -669.6548, 499];
    const offsets = jitter.map(function (ms, i) { return (i + 1) * FIVE_MINUTES + ms; });

    const values = firstDay(slots(readings(DAY, offsets), [DAY]));

    isNaN(values[0]).should.be.true();
    values.slice(1, 13).should.eql([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);
    values.slice(13).every(isNaN).should.be.true();
  });

  it('keeps the gap where a reading is missing', function () {
    const midSlot = [0, 1, 2, 3, 5, 6, 7].map(function (i) { return i * FIVE_MINUTES + FIVE_MINUTES / 2; });
    const nearMark = [1, 2, 3, 4, 6, 7, 8].map(function (i) { return i * FIVE_MINUTES + (i % 2 ? -500 : 300); });

    const midSlotValues = firstDay(slots(readings(DAY, midSlot), [DAY])).slice(0, 8);
    const nearMarkValues = firstDay(slots(readings(DAY, nearMark), [DAY])).slice(0, 9);

    midSlotValues.slice(0, 4).should.eql([100, 101, 102, 103]);
    isNaN(midSlotValues[4]).should.be.true();
    midSlotValues.slice(5).should.eql([104, 105, 106]);
    isNaN(nearMarkValues[0]).should.be.true();
    nearMarkValues.slice(1, 5).should.eql([100, 101, 102, 103]);
    isNaN(nearMarkValues[5]).should.be.true();
    nearMarkValues.slice(6).should.eql([104, 105, 106]);
  });

  it('keeps an earlier reading in its slot when the next day comes first', function () {
    // With newest on top, the report passes the next day's readings before this day's.
    const records = readings(NEXT_DAY, [200], 200).concat(readings(DAY, [287 * FIVE_MINUTES + 2 * 60 * 1000]));

    const bins = slots(records, [NEXT_DAY, DAY]);

    bins[0][1][0].should.equal(200);
    bins[287][1][1].should.equal(100);
  });

  [0, -200, 200].forEach(function (jitter) {
    it('preserves the exact missing slot with timestamp jitter of ' + jitter + ' ms', function () {
      const offsets = [0, 1, 3, 4].map(function (slot) {
        return Math.max(0, slot * FIVE_MINUTES + jitter);
      });
      const values = firstDay(slots(readings(DAY, offsets), [DAY]));

      values.slice(0, 2).should.eql([100, 101]);
      isNaN(values[2]).should.be.true();
      values.slice(3, 5).should.eql([102, 103]);
      values.slice(5).every(isNaN).should.be.true();
    });
  });

  it('keeps readings on either side of midnight in their own day', function () {
    const records = readings(DAY, [288 * FIVE_MINUTES - 200], 80)
      .concat(readings(NEXT_DAY, [200], 200));

    [[DAY, NEXT_DAY], [NEXT_DAY, DAY]].forEach(function (days) {
      const bins = slots(records, days);
      bins[287][1][days.indexOf(DAY)].should.equal(80);
      bins[0][1][days.indexOf(NEXT_DAY)].should.equal(200);
    });
    firstDay(slots(records, [DAY]))[287].should.equal(80);
    firstDay(slots(records, [NEXT_DAY]))[0].should.equal(200);
  });

  it('does not fill a missing final sample with the next day\'s first reading', function () {
    const offsets = [];
    for (let i = 0; i < 287; i++) offsets.push(i * FIVE_MINUTES + 200);
    const records = readings(DAY, offsets).concat(readings(NEXT_DAY, [200], 240));

    const alone = firstDay(slots(records, [DAY]));
    const together = slots(records, [DAY, NEXT_DAY]);
    isNaN(alone[287]).should.be.true();
    isNaN(together[287][1][0]).should.be.true();
    alone.filter(function (value) { return !isNaN(value); }).should.have.length(287);
    together[0][1][1].should.equal(240);
  });

  it('places the actual issue #6236 timestamps at their nearest five-minute marks', function () {
    const uploaded = [
      [1602547500286.0908, 72], [1602547800601.2769, 81], [1602548100006.845, 82]
      , [1602548399978.8152, 77], [1602548700313.8928, 75], [1602549000395.83, 76]
      , [1602549300030.324, 77]
    ].map(function (entry) {
      return { displayTime: new Date(entry[0]), sgv: entry[1], bgValue: entry[1] };
    });

    const values = firstDay(slots(uploaded, ['2020-10-13']));
    // Europe/Oslo was UTC+2: these readings belong at local 02:05 through 02:35.
    values.slice(25, 32).should.eql([72, 81, 82, 77, 75, 76, 77]);
    values.filter(function (value) { return !isNaN(value); }).should.have.length(7);
  });

  it('keeps the earliest reading when two timestamps align to the same mark', function () {
    const records = readings(DAY, [FIVE_MINUTES - 200, FIVE_MINUTES + 200]);
    [records, records.slice().reverse()].forEach(function (ordered) {
      const values = firstDay(slots(ordered, [DAY]));
      values[1].should.equal(100);
      values.filter(function (value) { return !isNaN(value); }).should.have.length(1);
    });
  });

  it('only aligns timestamps within the 30-second tolerance', function () {
    const atLimit = firstDay(slots(readings(DAY, [FIVE_MINUTES - 30000]), [DAY]));
    const outsideLimit = firstDay(slots(readings(DAY, [FIVE_MINUTES - 30001]), [DAY]));
    atLimit[1].should.equal(100);
    isNaN(atLimit[0]).should.be.true();
    outsideLimit[0].should.equal(100);
    isNaN(outsideLimit[1]).should.be.true();
  });

  it('does not include the following day on a 23-hour local day', function () {
    const shortDay = '2026-03-29';
    const followingDay = '2026-03-30';
    const dayLength = moment.tz(followingDay, TIMEZONE).valueOf() - moment.tz(shortDay, TIMEZONE).valueOf();
    dayLength.should.equal(23 * 60 * 60 * 1000);
    const records = readings(shortDay, [dayLength - 200], 80)
      .concat(readings(followingDay, [200], 200));

    const bins = slots(records, [shortDay, followingDay]);
    bins[287][1][0].should.equal(80);
    bins.slice(24, 36).every(function (bin) { return isNaN(bin[1][0]); }).should.be.true();
    bins[0][1][1].should.equal(200);
  });

  it('keeps 288 bins on a 25-hour local day', function () {
    const longDay = '2026-10-25';
    const followingDay = '2026-10-26';
    const dayLength = moment.tz(followingDay, TIMEZONE).valueOf() - moment.tz(longDay, TIMEZONE).valueOf();
    dayLength.should.equal(25 * 60 * 60 * 1000);
    const records = readings(longDay, [0, 287 * FIVE_MINUTES, 299 * FIVE_MINUTES], 100)
      .concat(readings(followingDay, [200], 200));

    const bins = slots(records, [longDay, followingDay]);
    bins.should.have.length(288);
    bins[0][1][0].should.equal(100);
    bins[275][1][0].should.equal(101);
    bins[287][1][0].should.equal(102);
    bins[0][1][1].should.equal(200);
  });

  it('keeps the earliest available reading for a repeated clock time', function () {
    const day = '2026-10-25';
    const first = {displayTime: new Date('2026-10-25T02:15:00+02:00'), sgv: 100};
    const second = {displayTime: new Date('2026-10-25T02:15:00+01:00'), sgv: 200};
    firstDay(slots([second, first], [day]))[27].should.equal(100);
    firstDay(slots([second], [day]))[27].should.equal(200);
  });

  it('rounds timestamp jitter onto the real mark after a skipped hour', function () {
    const record = {displayTime: new Date('2026-03-29T01:59:59.800+01:00'), sgv: 123};
    const values = firstDay(slots([record], ['2026-03-29']));
    values[36].should.equal(123); // The next real five-minute mark is 03:00.
    values.slice(24, 36).every(isNaN).should.be.true();
  });

  it('preserves clock times and late data across half-hour DST changes', function () {
    const timezone = 'Australia/Lord_Howe';
    const otherProfile = require('../lib/profilefunctions')([{
      defaultProfile: 'Default', startDate: '1980-01-01', store: {Default: {timezone, dia: 3}}
    }], {moment});
    for (const day of ['2026-04-05', '2026-10-04']) {
      const records = ['08:00:00', '23:30:00'].map((time, index) => ({
        displayTime: moment.tz(day + 'T' + time, timezone).toDate(), sgv: 120 + index
      }));
      const bins = loopalyzer.getSGVs({allstatsrecords: records}, [day], otherProfile);
      bins[96][1][0].should.equal(120);
      bins[282][1][0].should.equal(121);
      if (day === '2026-10-04') bins.slice(24, 30).every(bin => isNaN(bin[1][0])).should.be.true();
    }
  });
});
