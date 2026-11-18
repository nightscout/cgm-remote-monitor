'use strict';

// Dates and clock times in the reports follow the Nightscout display language
// (e.g. 25.10.2026 for German, 10/25/2026 for English) and the time format setting.
// moment's own locale data is not bundled, so this uses Intl instead.
//
// All functions take a moment that is already in the profile's time zone and show
// exactly its wall-clock fields, independent of the browser's time zone.
const DEFAULT_LOCALE = 'en-US';
const cache = new Map();

function formatter (locale, options) {
  const key = locale + JSON.stringify(options);
  let instance = cache.get(key);
  if (!instance) {
    instance = new Intl.DateTimeFormat(locale, Object.assign({timeZone: 'UTC'}, options));
    cache.set(key, instance);
  }
  return instance;
}

function wallClock (m) {
  return new Date(Date.UTC(m.year(), m.month(), m.date(), m.hour(), m.minute(), m.second()));
}

function localeOf (client) {
  const language = client && client.language;
  const code = (language && language.lang) || (client && client.settings && client.settings.language);
  const entry = language && language.get && code ? language.get(code) : null;
  const tag = entry && entry.file ? entry.file.replace('_', '-') : DEFAULT_LOCALE;
  return Intl.DateTimeFormat.supportedLocalesOf(tag).length ? tag : DEFAULT_LOCALE;
}

function init (client) {
  const timeOptions = () => Number(client && client.settings && client.settings.timeFormat) === 24
    ? {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}
    : {hour: 'numeric', minute: '2-digit', hour12: true};
  const format = options => m => formatter(localeOf(client), options).format(wallClock(m));
  const date = format({year: 'numeric', month: '2-digit', day: '2-digit'});
  const time = m => formatter(localeOf(client), timeOptions()).format(wallClock(m));
  return {
    date: date
    , time: time
    , dateTime: m => date(m) + ' ' + time(m)
    // "Sunday, 25 October 2026" and "Sun, 25 Oct" in the display language
    , longDate: format({weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'})
    , shortDate: format({weekday: 'short', month: 'short', day: 'numeric'})
  };
}

module.exports = init;
