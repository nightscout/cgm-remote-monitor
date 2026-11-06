'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const assert = require('node:assert/strict');
const {createCandidates, runContracts, runSeasons} = require('./date-candidate-contracts.cjs');
const {zones, instants} = require('./intl-editor-format-probe.cjs');

const corpus = {
  zones, instants, locales: ['en', 'de', 'fr', 'ar', 'fa'],
  localTimes: [
    ['2024-03-10T02:30:00', 'America/New_York'], ['2024-11-03T01:30:00', 'America/New_York'],
    ['2024-10-06T02:15:00', 'Australia/Lord_Howe'], ['2024-04-07T01:45:00', 'Australia/Lord_Howe'],
    ['2024-01-01T00:00:00', 'Asia/Kathmandu'], ['1900-01-01T00:00:00', 'Asia/Gaza']
  ],
  calendarDays: [
    ['2024-03-10T00:00:00', 'America/New_York'], ['2024-11-03T00:00:00', 'America/New_York'],
    ['2024-10-06T00:00:00', 'Australia/Lord_Howe'], ['2024-04-07T00:00:00', 'Australia/Lord_Howe'],
    ['2024-01-01T00:00:00', 'Asia/Kathmandu']
  ],
  offsetTimes: ['+05:30', '+05:45', '-03:30'].map(offset => ['2024-01-01T00:00:00', offset]),
  dates: ['2024-02-29', '2024-02-30', '2023-02-29', '2024-13-01', '2024-00-01', '2024-01-00', 'not-a-date'],
  hours: [-25, -1, 0, 1, 25, 10000]
};

function load(candidateDirectory) {
  const external = createRequire(path.resolve(candidateDirectory, 'package.json'));
  const dayjs = external('dayjs');
  for (const plugin of ['utc', 'timezone', 'duration']) dayjs.extend(external('dayjs/plugin/' + plugin));
  for (const locale of corpus.locales.slice(1)) external('dayjs/locale/' + locale);
  return {moment: require('moment-timezone'), dayjs, luxon: external('luxon'), Temporal: external('@js-temporal/polyfill').Temporal};
}

async function run() {
  const directory = path.resolve(process.argv[2]);
  const libraries = load(directory);
  const lock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json')));
  for (const [name, version] of Object.entries({'@js-temporal/polyfill': '0.5.1', luxon: '3.7.2', dayjs: '1.11.23'})) {
    assert.equal(lock.packages['node_modules/' + name].version, version, 'Review changed candidate versions');
  }
  const candidates = createCandidates(libraries);
  const seasons = runSeasons(candidates, corpus, libraries.luxon, runContracts);
  for (const season of seasons) for (const row of season.rows) for (const [name, observation] of Object.entries(row.results)) {
    assert.equal(observation.error, undefined, name + ' could not execute ' + row.kind + ': ' + JSON.stringify(row.args));
  }
  const timings = [];
  for (const c of Object.values(candidates)) for (let n = 0; n < 200; n++) c.format(instants[n % instants.length], 'America/New_York', 'en');
  for (let round = 0; round < 7; round++) {
    const names = Object.keys(candidates); if (round % 2) names.reverse();
    for (const name of names) {
      let checksum = 0;
      const start = performance.now();
      for (let n = 0; n < 5000; n++) {
        const result = candidates[name].format(instants[n % instants.length], 'America/New_York', 'en');
        checksum += result.date.length + result.time.length;
      }
      timings.push({round, name, iterations: 5000, milliseconds: performance.now() - start, checksum});
    }
  }
  const sourceHash = name => createHash('sha256').update(fs.readFileSync(path.join(__dirname, name))).digest('hex');
  console.log(JSON.stringify({
    baseline: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
    node: process.version, icu: process.versions.icu, tz: process.versions.tz,
    nativeTemporal: typeof globalThis.Temporal, moment: libraries.moment.version,
    momentTimezone: libraries.moment.tz.version, momentTzData: libraries.moment.tz.dataVersion,
    sources: Object.fromEntries(['date-candidate-probe.cjs', 'date-candidate-contracts.cjs'].map(name => [name, sourceHash(name)])),
    candidatePackages: Object.fromEntries(Object.entries(lock.packages).filter(([key]) => key).map(([key, value]) => [key, {version: value.version, integrity: value.integrity}])),
    scope: 'Native candidate operations and explicit formatting adapters; not a production migration or proof of all application contracts. Full server Moment timezone data.',
    corpus, seasons, timings
  }, null, 2));
}

module.exports = {corpus, load};
if (require.main === module) run().catch(error => {console.error(error); process.exitCode = 1;});
