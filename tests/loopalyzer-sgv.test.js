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

    values.slice(0, 12).should.eql([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);
    values.slice(12).every(isNaN).should.be.true();
  });

  it('keeps the gap where a reading is missing', function () {
    const midSlot = [0, 1, 2, 3, 5, 6, 7].map(function (i) { return i * FIVE_MINUTES + FIVE_MINUTES / 2; });
    const nearMark = [1, 2, 3, 4, 6, 7, 8].map(function (i) { return i * FIVE_MINUTES + (i % 2 ? -500 : 300); });

    const midSlotValues = firstDay(slots(readings(DAY, midSlot), [DAY])).slice(0, 8);
    const nearMarkValues = firstDay(slots(readings(DAY, nearMark), [DAY])).slice(0, 8);

    midSlotValues.slice(0, 4).should.eql([100, 101, 102, 103]);
    isNaN(midSlotValues[4]).should.be.true();
    midSlotValues.slice(5).should.eql([104, 105, 106]);
    nearMarkValues.filter(isNaN).should.have.length(1);
    nearMarkValues.filter(function (value) { return !isNaN(value); }).should.eql([100, 101, 102, 103, 104, 105, 106]);
  });

  it('keeps an earlier reading in its slot when the next day comes first', function () {
    // With newest on top, the report passes the next day's readings before this day's.
    const records = readings(NEXT_DAY, [200], 200).concat(readings(DAY, [287 * FIVE_MINUTES + 2 * 60 * 1000]));

    const bins = slots(records, [NEXT_DAY, DAY]);

    bins[0][1][0].should.equal(200);
    bins[287][1][1].should.equal(100);
  });
});
