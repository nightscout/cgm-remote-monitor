'use strict';
// Install Luxon in a disposable directory and pass its absolute module path.
// It is deliberately absent from Nightscout's dependency manifest.
const assert = require('node:assert/strict');
const {DateTime, Settings, VERSION} = require(require('node:path').resolve(process.argv[2]));
assert.equal(VERSION, '3.7.2', 'Review a new version before changing the comparison');
const moment = require('moment-timezone');
const {zones, instants} = require('./intl-editor-format-probe.cjs');
const {performance} = require('node:perf_hooks');
const rows=[];
for(const zone of zones) for(const locale of ['en','de','fr','ar','fa']) for(const instant of instants) {
 const m=moment.tz(instant,zone).locale(locale), l=DateTime.fromMillis(instant,{zone,locale});
 const previous={date:m.format('YYYY-MM-DD'),time:m.format('HH:mm')};
 const candidate={date:l.toFormat('yyyy-MM-dd'),time:l.toFormat('HH:mm')};
 rows.push({zone,locale,instant:new Date(instant).toISOString(),previous,candidate,equal:JSON.stringify(previous)===JSON.stringify(candidate)});
}
const parsing=[];
for(const now of ['2024-01-15T00:00:00Z','2024-07-15T00:00:00Z']) {
 Settings.now=()=>Date.parse(now);Settings.resetCaches();
 for(const [zone,local] of [['America/New_York','2024-03-10T02:30:00'],['America/New_York','2024-11-03T01:30:00'],['Australia/Lord_Howe','2024-10-06T02:15:00'],['Australia/Lord_Howe','2024-04-07T01:45:00']]) {
  const m=moment.tz(local,zone),l=DateTime.fromISO(local,{zone});
  parsing.push({now,zone,local,moment:m.toISOString(),luxon:l.toUTC().toISO(),possibleLuxonInstants:l.getPossibleOffsets().map(d=>d.toUTC().toISO()).sort(),earliestLuxon:l.getPossibleOffsets().sort((a,b)=>a.toMillis()-b.toMillis())[0].toUTC().toISO()});
 }
}
Settings.now=()=>Date.now();Settings.resetCaches();
const m=moment.utc('2024-01-01'), l=DateTime.fromISO('2024-01-01',{zone:'UTC'});
const mutation={momentReturnsSameObject:m.add(1,'hour')===m,luxonReturnsSameObject:l.plus({hours:1})===l};
const cases={moment:instant=>{const d=moment.tz(instant,'America/New_York').locale('en');return d.format('YYYY-MM-DD')+d.format('HH:mm');},luxon:instant=>{const d=DateTime.fromMillis(instant,{zone:'America/New_York',locale:'en'});return d.toFormat('yyyy-MM-dd')+d.toFormat('HH:mm');}};
for(const fn of Object.values(cases)) for(let n=0;n<100;n++)fn(instants[n%instants.length]);
const timings=[];
for(let round=0;round<5;round++) {
 const order=Object.keys(cases);if(round%2)order.reverse();
 for(const name of order){let checksum=0;const start=performance.now();for(let n=0;n<5000;n++)checksum+=cases[name](instants[n%instants.length]).length;timings.push({round,name,iterations:5000,milliseconds:performance.now()-start,checksum});}
}
console.log(JSON.stringify({node:process.version,icu:process.versions.icu,tz:process.versions.tz,luxon:VERSION,moment:moment.version,momentTimezone:moment.tz.version,cases:rows.length,mismatches:rows.filter(r=>!r.equal),parsing,mutation,timings},null,2));
