'use strict';

// Exploratory M27 probe only. Not imported by application code.
const moment = require('moment-timezone');
const {performance} = require('node:perf_hooks');
const {execFileSync} = require('node:child_process');
const {gzipSync} = require('node:zlib');
for (const locale of ['de', 'fr', 'ar', 'fa']) require('moment/locale/' + locale);
moment.locale('en');

function createFormatter(zone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  return instant => {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
    return {date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`};
  };
}

const zones = ['UTC', 'America/New_York', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'Asia/Gaza'];
const instants = [
  '1900-01-01T00:00:00Z', '2014-12-31T23:59:00Z', '2015-01-01T00:00:00Z',
  '2024-03-10T06:59:00Z', '2024-03-10T07:00:00Z',
  '2024-11-03T05:30:00Z', '2024-11-03T06:30:00Z',
  '2024-04-06T14:45:00Z', '2024-04-06T15:15:00Z',
  '2024-10-05T15:29:00Z', '2024-10-05T15:30:00Z',
  '2035-12-31T23:59:00Z', '2036-01-01T00:00:00Z'
].map(value => Date.parse(value));
const rows = [];
for (const zone of zones) {
  const format = createFormatter(zone);
  for (const locale of ['en', 'de', 'fr', 'ar', 'fa']) {
    for (const instant of instants) {
      const date = moment.tz(instant, zone).locale(locale);
      const previous = {date: date.format('YYYY-MM-DD'), time: date.format('HH:mm')};
      const candidate = format(instant);
      rows.push({zone, locale, instant: new Date(instant).toISOString(), previous, candidate,
        equal: previous.date === candidate.date && previous.time === candidate.time});
    }
  }
}

// Alternate order to expose warmup effects. Retain checksums so work is consumed.
const cached = createFormatter('America/New_York');
const cases = {
  moment: instant => { const date = moment.tz(instant, 'America/New_York').locale('en'); return date.format('YYYY-MM-DD') + date.format('HH:mm'); },
  intlCached: instant => { const result = cached(instant); return result.date + result.time; },
  intlConstructEachTime: instant => { const result = createFormatter('America/New_York')(instant); return result.date + result.time; }
};
for (const fn of Object.values(cases)) for (let n = 0; n < 100; n++) fn(instants[n % instants.length]);
const timings = [];
for (let round = 0; round < 5; round++) {
  const order = Object.keys(cases); if (round % 2) order.reverse();
  for (const name of order) {
    let checksum = 0;
    const start = performance.now();
    for (let n = 0; n < 5000; n++) checksum += cases[name](instants[n % instants.length]).length;
    timings.push({round, name, iterations: 5000, milliseconds: performance.now() - start, checksum});
  }
}
console.log(JSON.stringify({
  baseline: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
  node: process.version, icu: process.versions.icu, intlTz: process.versions.tz,
  moment: moment.version, momentTimezone: moment.tz.version, momentTzData: moment.tz.dataVersion,
  scope: 'Editor YYYY-MM-DD and HH:mm formatting shapes; full server timezone data, not the clipped browser bundle. No parsing, invalid-input, fixed-offset profile, therapy, report-label or application wiring coverage.',
  formatterSourceBytes: Buffer.byteLength(createFormatter.toString()),
  formatterSourceGzipBytes: gzipSync(createFormatter.toString()).length,
  cases: rows.length, mismatches: rows.filter(row => !row.equal), timings,
  caveats: 'Formatter size is standalone source, not a bundled delta. Both libraries remain loaded in this process. No retained heap, allocation or server RSS saving is established.'
}, null, 2));
