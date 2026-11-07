'use strict';

// Compare every offset/abbreviation interval in a bounded calendar window,
// including transitions that occur in only one version; not monthly sampling.
const assert = require('node:assert/strict');
const path = require('node:path');
assert.ok(process.argv[2], 'Pass the absolute old moment-timezone module directory');
const old = require(path.resolve(process.argv[2]));
const current = require('moment-timezone');
assert.notEqual(old, current, 'Use separately installed dependencies');
const start = Date.UTC(1900, 0, 1), end = Date.UTC(2100, 0, 1);
const oldNames = old.tz.names(), names = current.tz.names();
const changed = [];
let intervals = 0;
for (const name of oldNames.filter(name => names.includes(name))) {
  const before = old.tz.zone(name), after = current.tz.zone(name);
  const boundaries = [...new Set([start, end, ...before.untils, ...after.untils]
    .filter(time => Number.isFinite(time) && time >= start && time <= end))].sort((a,b) => a-b);
  const spans = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const time = boundaries[i];
    const previous = {offsetMinutes: before.utcOffset(time), abbreviation: before.abbr(time)};
    const candidate = {offsetMinutes: after.utcOffset(time), abbreviation: after.abbr(time)};
    intervals++;
    if (JSON.stringify(previous) !== JSON.stringify(candidate)) {
      spans.push({from: new Date(time).toISOString(), until: new Date(boundaries[i+1]).toISOString(), previous, candidate});
    }
  }
  if (spans.length) changed.push({zone: name, spans});
}
console.log(JSON.stringify({before: {version: old.tz.version, data: old.tz.dataVersion},
  after: {version: current.tz.version, data: current.tz.dataVersion},
  window: {from: new Date(start).toISOString(), until: new Date(end).toISOString()},
  addedZones: names.filter(name => !oldNames.includes(name)), removedZones: oldNames.filter(name => !names.includes(name)),
  comparedIntervals: intervals, changedZones: changed.length, changes: changed,
  scope: 'Full server data offsets and abbreviations only. Alias metadata, country mappings, parsing, profile selection and clipped browser behavior require separate checks.'}, null, 2));
