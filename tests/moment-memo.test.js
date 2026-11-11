'use strict';

// lib/data/moment-memo.js (evaluator cost lane, D): a document date parsed
// once must be indistinguishable from moment's own parse of the same string,
// and every caller must get its own moment.
//
// The forms below are one synthetic example of every date-string shape the
// alignment corpora hold (tools/tenancy/eval-cost/date-forms.cjs lists the
// shapes and counts, not values), plus the ISO and fallback forms moment
// treats differently from Date. VIEWS_CORPUS_DIR=<dir> also runs every
// distinct date string found in that corpus, read where it is; only counts
// are reported.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const moment = require('moment-timezone');
const memo = require('../lib/data/moment-memo');

const FORMS = [
  // shapes found in the corpora
  '2026-11-10T07:08:09Z', '2026-11-10T07:08:09.123Z', '2026-11-10T07:08:09+01:00', '2026-11-10T07:08:09.123+0100',
  '2026-11-10T07:08:09.123456+05:30', '07:30', '1794373206107', '7', '5f0a1b2c3d', '1e2f3a4b5c',
  // ISO forms moment parses itself (local time where there is no offset)
  '2026-11-10', '2026-11-10T07:08', '2026-11-10T07:08:09', '2026-11-10 07:08:09', '2026-11-10T07:08:09-05:00',
  '2026-11-10T07:08:09.1Z', '2026-11-10T07:08:09,123Z', '2026-11-10T070809Z', '20261110T070809Z', '2026-W46-2',
  '2026-314', '2026-11-10T24:00:00Z', '2026-11-10T23:59:60Z', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z',
  '+002026-11-10T07:08:09Z', '2026-03-08T02:30:00', '2026-11-01T01:30:00', '2026-11-10t07:08:09z',
  // RFC 2822 and the Date fallback
  'Tue, 10 Nov 2026 07:08:09 GMT', 'Tue, 10 Nov 2026 07:08:09 +0100', 'Tue Nov 10 2026 07:08:09 GMT+0000 (Coordinated Universal Time)',
  'November 10, 2026', '11/10/2026', '', ' ', 'not a date', 'null', 'undefined', 'NaN'
];

function observe (m) {
  const valid = m.isValid();
  const data = m.creationData();
  return {
    valid, value: m.valueOf(), invalidAt: m.invalidAt(), offset: m.utcOffset(), isUTC: m.isUTC(),
    format: m.format(), formatL: m.format('LLLL ZZ x'), iso: m.toISOString(), json: JSON.stringify(m),
    creation: { input: data.input, format: data.format, isUTC: data.isUTC, strict: data.strict, locale: data.locale && data.locale._abbr },
    flags: JSON.stringify(m.parsingFlags()), zone: m._z === undefined ? 'undefined' : String(m._z),
    tz: valid ? m.clone().tz('America/New_York').format() : null, utc: valid ? m.clone().utc().format() : null,
    from: valid ? m.from(moment(Date.UTC(2026, 10, 11))) : null
  };
}

function compare (dates, text) {
  const fresh = observe(moment(text));
  const first = observe(dates.moment(text));
  const again = observe(dates.moment(text)); // from the cache
  assert.deepStrictEqual(first, fresh, JSON.stringify(text) + ' first parse');
  assert.deepStrictEqual(again, fresh, JSON.stringify(text) + ' cached parse');
}

describe('moment-memo: document dates parsed once', function () {
  const silence = moment.suppressDeprecationWarnings;
  before(() => { moment.suppressDeprecationWarnings = true; });
  after(() => { moment.suppressDeprecationWarnings = silence; moment.locale('en'); });

  it('is moment\'s own parse on every corpus shape and ISO/fallback form', function () {
    const dates = memo(moment);
    for (const text of FORMS) compare(dates, text);
    assert.equal(dates.stats().parses, FORMS.length, 'one parse per distinct string');
  });

  it('gives each caller its own moment: changing one never changes the next', function () {
    const dates = memo(moment);
    for (const text of ['2026-11-10T07:08:09Z', '2026-11-10T07:08:09', 'not a date']) {
      const expected = observe(moment(text));
      const mine = dates.moment(text);
      mine.add(5, 'hours').startOf('day').utcOffset(120).locale('fr');
      if (mine.isValid()) mine.tz('Asia/Tokyo');
      mine.parsingFlags().userInvalidated = true; mine.parsingFlags().unusedTokens.push('changed');
      if (Array.isArray(mine._a)) mine._a[0] = -1;
      assert.deepStrictEqual(observe(dates.moment(text)), expected, text);
    }
  });

  it('passes every other call to moment unchanged', function () {
    const dates = memo(moment);
    const at = Date.UTC(2026, 10, 10);
    assert.equal(dates.moment(at).valueOf(), moment(at).valueOf());
    assert.equal(dates.moment('10/11/2026', 'DD/MM/YYYY').format(), moment('10/11/2026', 'DD/MM/YYYY').format());
    assert.equal(dates.moment.utc('2026-11-10T07:08:09').format(), moment.utc('2026-11-10T07:08:09').format());
    assert.equal(dates.moment.tz('2026-11-10T07:08:09', 'Europe/Paris').format(), moment.tz('2026-11-10T07:08:09', 'Europe/Paris').format());
    assert.equal(dates.moment.duration(90, 'minutes').humanize(), moment.duration(90, 'minutes').humanize());
    assert.ok(moment.isMoment(dates.moment('2026-11-10')));
    assert.ok(Math.abs(dates.moment().valueOf() - Date.now()) < 1000);
    assert.equal(dates.stats().parses, 1, 'only the single-string call is memoised');
  });

  it('drops the cache when moment\'s global locale changes', function () {
    const dates = memo(moment);
    const text = '2026-11-10T07:08:09Z';
    assert.equal(dates.moment(text).locale(), 'en');
    moment.locale('fr');
    try {
      assert.deepStrictEqual(observe(dates.moment(text)), observe(moment(text)));
      assert.equal(dates.moment(text).locale(), 'fr');
    } finally { moment.locale('en'); }
  });

  it('keeps an entry while it is used and drops it after two cycles unused', function () {
    const dates = memo(moment);
    dates.moment('2026-11-10T07:08:09Z'); dates.moment('2026-11-10T07:08:10Z');
    dates.cycle(); dates.moment('2026-11-10T07:08:09Z');
    dates.cycle(); dates.moment('2026-11-10T07:08:09Z');
    assert.equal(dates.stats().parses, 2);
    assert.equal(dates.stats().size, 1, 'the string unused for a cycle was dropped');
    dates.moment('2026-11-10T07:08:10Z');
    assert.equal(dates.stats().parses, 3);
  });

  const corpus = process.env.VIEWS_CORPUS_DIR;
  (corpus ? it : it.skip)('is moment\'s own parse on every date string of VIEWS_CORPUS_DIR (read in place)', function () {
    this.timeout(120000);
    const DATEISH = /(^|_)(created_at|timestamp|date|datestring|systime|clock|startdate|enddate|time|deliverat|mills|srvcreated|srvmodified)$/i;
    const strings = new Set();
    const visit = (value, field) => {
      if (Array.isArray(value)) return value.forEach(v => visit(v, field));
      if (value && typeof value === 'object') return Object.entries(value).forEach(([k, v]) => visit(v, k));
      if (typeof value === 'string' && field && DATEISH.test(field)) strings.add(value);
    };
    const files = fs.readdirSync(corpus).filter(n => /_(entries|treatments|devicestatus|profile)\.json$/.test(n));
    for (const name of files) visit(JSON.parse(fs.readFileSync(path.join(corpus, name), 'utf8')), null);
    const dates = memo(moment);
    for (const text of strings) compare(dates, text);
    process.stdout.write('      MOMENT_MEMO_CORPUS files=' + files.length + ' distinct date strings=' + strings.size + ' all equal\n');
  });
});
