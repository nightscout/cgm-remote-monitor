'use strict';

const assert = require('node:assert/strict');
const moment = require('moment-timezone');
const dateFormat = require('../lib/report/date-format');
const language = require('../lib/language');

describe('report date and time formats', function () {
  // 2026-10-25 is the day Europe/Oslo leaves daylight saving time; 14:05:09 local.
  const at = moment.tz('2026-10-25T14:05:09', 'Europe/Oslo');
  const plain = text => text.replace(/\s/g, ' ');

  function clientFor (code, timeFormat) {
    const lang = language();
    lang.set(code);
    return {language: lang, settings: {language: code, timeFormat: timeFormat || 12}};
  }

  const expectedDates = {
    en: '10/25/2026', de: '25.10.2026', dk: '25.10.2026', sv: '2026-10-25', nb: '25.10.2026',
    ja: '2026/10/25', fr: '25/10/2026', hu: '2026. 10. 25.', br: '25/10/2026'
  };
  for (const [code, expected] of Object.entries(expectedDates)) {
    it('shows dates in the ' + code + ' display language as ' + expected, function () {
      assert.equal(plain(dateFormat(clientFor(code)).date(at)), expected);
    });
  }

  it('does not use the English month/day order for other languages', function () {
    assert.notEqual(dateFormat(clientFor('de')).date(at), dateFormat(clientFor('en')).date(at));
  });

  it('follows the 12 or 24 hour setting', function () {
    assert.equal(plain(dateFormat(clientFor('en', 24)).time(at)), '14:05');
    assert.equal(plain(dateFormat(clientFor('en', 12)).time(at)), '2:05 PM');
    assert.equal(plain(dateFormat(clientFor('de', 24)).time(at)), '14:05');
    assert.equal(plain(dateFormat(clientFor('de', 24)).dateTime(at)), '25.10.2026 14:05');
  });

  it('shows weekday and month names in the display language', function () {
    assert.match(dateFormat(clientFor('de')).longDate(at), /Sonntag.*25.*Oktober.*2026/);
    assert.match(dateFormat(clientFor('en')).longDate(at), /Sunday.*October 25.*2026|Sunday, October 25, 2026/);
    assert.match(dateFormat(clientFor('de')).shortDate(at), /So.*25.*Okt/);
  });

  it('shows the wall-clock time of the profile time zone, not the browser time zone', function () {
    const tokyo = moment.tz('2026-03-29T02:30:00', 'Asia/Tokyo');
    assert.equal(plain(dateFormat(clientFor('en', 24)).time(tokyo)), '02:30');
    // A time that does not exist in many browser zones (spring forward) is kept as is.
    const gap = moment.tz('2026-03-29T02:30:00', 'UTC');
    assert.equal(plain(dateFormat(clientFor('en', 24)).dateTime(gap)), '03/29/2026 02:30');
  });

  it('falls back to English formats without a language or with an unknown one', function () {
    assert.equal(dateFormat({}).date(at), '10/25/2026');
    assert.equal(dateFormat(undefined).date(at), '10/25/2026');
    assert.equal(dateFormat({settings: {language: 'xx'}, language: language()}).date(at), '10/25/2026');
  });
});
