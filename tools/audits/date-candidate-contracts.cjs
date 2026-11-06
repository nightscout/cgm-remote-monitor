'use strict';

// Research adapters only: native candidate APIs, never a Moment-compatible shim.
// This factory is also evaluated in an isolated browser with the same inputs.
function createCandidates({moment, dayjs, luxon, Temporal}) {
  const pad = n => String(n).padStart(2, '0');
  const temporalLocal = (local, zone) => Temporal.PlainDateTime.from(local)
    .toZonedDateTime(zone, {disambiguation: 'compatible'});
  const epoch = value => new Date(value).toISOString();
  const temporalInstant = value => ({iso: epoch(value.epochMilliseconds), offset: value.offsetNanoseconds / 6e10});
  const momentInstant = value => ({iso: value.toISOString(), offset: value.utcOffset()});
  const luxonInstant = value => ({iso: epoch(value.toMillis()), offset: value.offset});
  const formatters = new Map();
  function intlFormat(instant, zone, locale) {
    const key = zone + '/' + locale;
    if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat(locale, {
      timeZone: zone, calendar: 'gregory', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }));
    const parts = Object.fromEntries(formatters.get(key).formatToParts(instant).map(p => [p.type, p.value]));
    return {date: parts.year + '-' + parts.month + '-' + parts.day, time: parts.hour + ':' + parts.minute};
  }
  return {
    moment: {
      format: (instant, zone, locale) => {
        const d = moment.tz(instant, zone).locale(locale);
        return {date: d.format('YYYY-MM-DD'), time: d.format('HH:mm')};
      },
      local: (local, zone) => momentInstant(moment.tz(local, zone)),
      offsetLocal: (local, offset) => momentInstant(moment.parseZone(local + offset)),
      calendarDay: (local, zone) => momentInstant(moment.tz(local, zone).add(1, 'day')),
      validDate: local => moment(local, moment.ISO_8601, true).isValid(),
      elapsedHours: hours => moment.duration(hours, 'hours').asMilliseconds(),
      immutable: () => {const d = moment.utc('2024-01-01'); return d.add(1, 'hour') !== d;}
    },
    intl: {
      format: intlFormat,
      // Intl provides formatting, not local-time parsing or calendar arithmetic.
      local: null, offsetLocal: null, calendarDay: null, validDate: null, elapsedHours: null, immutable: null
    },
    dayjs: {
      format: (instant, zone, locale) => {
        const d = dayjs(instant).tz(zone).locale(locale);
        return {date: d.format('YYYY-MM-DD'), time: d.format('HH:mm')};
      },
      local: (local, zone) => momentInstant(dayjs.tz(local, zone)),
      offsetLocal: (local, offset) => momentInstant(dayjs.utc(local).utcOffset(offset, true)),
      calendarDay: (local, zone) => momentInstant(dayjs.tz(local, zone).add(1, 'day')),
      validDate: local => dayjs(local).isValid(),
      elapsedHours: hours => dayjs.duration(hours, 'hours').asMilliseconds(),
      immutable: () => {const d = dayjs.utc('2024-01-01'); return d.add(1, 'hour') !== d;}
    },
    luxon: {
      format: (instant, zone, locale) => {
        const d = luxon.DateTime.fromMillis(instant, {zone, locale});
        return {date: d.toFormat('yyyy-MM-dd'), time: d.toFormat('HH:mm')};
      },
      local: (local, zone) => luxonInstant(luxon.DateTime.fromISO(local, {zone})),
      offsetLocal: (local, offset) => luxonInstant(luxon.DateTime.fromISO(local + offset, {setZone: true})),
      calendarDay: (local, zone) => luxonInstant(luxon.DateTime.fromISO(local, {zone}).plus({days: 1})),
      validDate: local => luxon.DateTime.fromISO(local).isValid,
      elapsedHours: hours => luxon.Duration.fromObject({hours}).as('milliseconds'),
      immutable: () => {const d = luxon.DateTime.utc(2024, 1, 1); return d.plus({hours: 1}) !== d;}
    },
    temporal: {
      // Temporal machine-readable fields have no Moment locale postformat hook.
      // Localized display needs Intl, evaluated separately above.
      format: (instant, zone) => {
        const d = Temporal.Instant.fromEpochMilliseconds(instant).toZonedDateTimeISO(zone);
        return {date: d.toPlainDate().toString(), time: pad(d.hour) + ':' + pad(d.minute)};
      },
      local: (local, zone) => temporalInstant(temporalLocal(local, zone)),
      offsetLocal: (local, offset) => temporalInstant(temporalLocal(local, offset)),
      calendarDay: (local, zone) => temporalInstant(temporalLocal(local, zone).add({days: 1})),
      validDate: local => {try {Temporal.PlainDate.from(local); return true;} catch {return false;}},
      elapsedHours: hours => Temporal.Duration.from({hours}).total({unit: 'milliseconds'}),
      immutable: () => {const d = Temporal.PlainDateTime.from('2024-01-01'); return d.add({hours: 1}) !== d;}
    }
  };
}

function runContracts(candidates, corpus) {
  const rows = [];
  function compare(kind, args) {
    const results = {};
    for (const [name, candidate] of Object.entries(candidates)) {
      if (!candidate[kind]) {results[name] = {unsupported: true}; continue;}
      try {results[name] = {value: candidate[kind](...args)};}
      catch (error) {results[name] = {error: error.name + ': ' + error.message};}
    }
    const baseline = JSON.stringify(results.moment);
    rows.push({kind, args, results, different: Object.keys(results).filter(name => JSON.stringify(results[name]) !== baseline)});
  }
  for (const zone of corpus.zones) for (const locale of corpus.locales) for (const instant of corpus.instants) compare('format', [instant, zone, locale]);
  for (const args of corpus.localTimes) compare('local', args);
  for (const args of corpus.offsetTimes) compare('offsetLocal', args);
  for (const args of corpus.calendarDays) compare('calendarDay', args);
  for (const date of corpus.dates) compare('validDate', [date]);
  for (const hours of corpus.hours) compare('elapsedHours', [hours]);
  compare('immutable', []);
  return rows;
}

function runSeasons(candidates, corpus, luxon, runContracts) {
  const OriginalDate = globalThis.Date;
  const originalNow = luxon.Settings.now;
  const seasons = [];
  try {
    for (const now of ['2024-01-15T00:00:00Z', '2024-07-15T00:00:00Z']) {
      const epoch = OriginalDate.parse(now);
      globalThis.Date = class extends OriginalDate {
        constructor(...args) {super(...(args.length ? args : [epoch]));}
        static now() {return epoch;}
      };
      luxon.Settings.now = () => epoch;
      luxon.Settings.resetCaches();
      seasons.push({now, rows: runContracts(candidates, corpus)});
    }
  } finally {
    globalThis.Date = OriginalDate;
    luxon.Settings.now = originalNow;
    luxon.Settings.resetCaches();
  }
  return seasons;
}

module.exports = {createCandidates, runContracts, runSeasons};
