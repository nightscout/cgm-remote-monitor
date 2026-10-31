'use strict';

// Isolated candidate costs only: neither a full Nightscout server nor an estimate
// of savings from replacing Moment. Each sample loads exactly one candidate.
const path = require('node:path');
const {createRequire} = require('node:module');
const {execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createHash} = require('node:crypto');

async function sample(name, directory) {
  assert.equal(typeof global.gc, 'function', 'Run with --expose-gc');
  const external = createRequire(path.resolve(directory, 'package.json'));
  async function collect() {
    for (let n = 0; n < 3; n++) {global.gc(); await new Promise(resolve => setImmediate(resolve));}
    return {...process.memoryUsage(), modules: Object.keys(require.cache).length};
  }
  const before = await collect();
  const start = performance.now();
  let make;
  if (name === 'moment') {
    const moment = require('moment-timezone');
    make = instant => moment.tz(instant, 'America/New_York');
  } else if (name === 'dayjs') {
    const dayjs = external('dayjs');
    dayjs.extend(external('dayjs/plugin/utc')); dayjs.extend(external('dayjs/plugin/timezone'));
    make = instant => dayjs(instant).tz('America/New_York');
  } else if (name === 'luxon') {
    const {DateTime} = external('luxon');
    make = instant => DateTime.fromMillis(instant, {zone: 'America/New_York'});
  } else if (name === 'temporal') {
    const {Temporal} = external('@js-temporal/polyfill');
    make = instant => Temporal.Instant.fromEpochMilliseconds(instant).toZonedDateTimeISO('America/New_York');
  } else {throw new Error('Unknown candidate');}
  const loadMilliseconds = performance.now() - start;
  // Warm the zone formatter/cache before comparing populated and released values.
  for (let n = 0; n < 100; n++) make(1704067200000 + n * 60000);
  const loaded = await collect();
  const cycles = [];
  for (let cycle = 0; cycle < 5; cycle++) {
    const started = performance.now();
    let values = Array.from({length: 5000}, (_, n) => make(1704067200000 + n * 60000));
    const milliseconds = performance.now() - started;
    const instant = d => name === 'temporal' ? d.epochMilliseconds : Number(d);
    assert.equal(instant(values[0]), 1704067200000); assert.equal(instant(values[values.length - 1]), 1704367140000);
    const populated = await collect();
    values = null;
    cycles.push({cycle, milliseconds, populated, released: await collect()});
  }
  return {name, node: process.version, icu: process.versions.icu, tz: process.versions.tz,
    before, loaded, loadMilliseconds, cycles, resources: process.getActiveResourcesInfo()};
}

async function run() {
  const directory = path.resolve(process.argv[2]);
  if (process.argv[3] === '--sample') {
    console.log(JSON.stringify(await sample(process.argv[4], directory))); return;
  }
  const results = [];
  for (let round = 0; round < 7; round++) {
    const names = ['moment', 'dayjs', 'luxon', 'temporal']; if (round % 2) names.reverse();
    for (const name of names) {
      results.push({round, ...JSON.parse(execFileSync(process.execPath,
        ['--expose-gc', __filename, directory, '--sample', name], {encoding: 'utf8'}))});
    }
  }
  console.log(JSON.stringify({
    baseline: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
    probeSha256: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    scope: 'Seven alternating fresh processes per candidate; five cycles of 5000 zoned values. Full server Moment timezone data. No Intl-only date type, application throughput, or server RAM-saving claim.',
    results
  }, null, 2));
}
run().catch(error => {console.error(error); process.exitCode = 1;});
