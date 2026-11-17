'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const {execFileSync} = require('node:child_process');
const {gzipSync} = require('node:zlib');
const {createHash} = require('node:crypto');
const webpack = require('webpack');
const playwright = require('playwright-core');
const {createPageFixture, hash} = require('../../tests/fixtures/page-startup/server');
const {createCandidates, runContracts, runSeasons} = require('./date-candidate-contracts.cjs');
const {corpus} = require('./date-candidate-probe.cjs');

async function bundles(directory, output) {
  const external = createRequire(path.resolve(directory, 'package.json'));
  const specs = {
    dayjs: [
      'const dayjs = require(' + JSON.stringify(external.resolve('dayjs')) + ');',
      ...['utc', 'timezone', 'duration'].map(name => 'dayjs.extend(require(' + JSON.stringify(external.resolve('dayjs/plugin/' + name)) + '));'),
      ...corpus.locales.slice(1).map(name => 'require(' + JSON.stringify(external.resolve('dayjs/locale/' + name)) + ');'),
      'globalThis.dateCandidateLibraries.dayjs = dayjs;'
    ].join('\n'),
    luxon: 'globalThis.dateCandidateLibraries.luxon = require(' + JSON.stringify(external.resolve('luxon')) + ');',
    temporal: 'globalThis.dateCandidateLibraries.Temporal = require(' + JSON.stringify(external.resolve('@js-temporal/polyfill')) + ').Temporal;'
  };
  const evidence = {};
  for (const [name, code] of Object.entries(specs)) {
    const entry = path.join(output, name + '-entry.cjs');
    fs.writeFileSync(entry, code);
    const compiler = webpack({mode: 'production', context: process.cwd(), entry,
      output: {path: output, filename: name + '.js'},
      module: {rules: [{test: /\.[cm]?js$/, include: [fs.realpathSync(directory)],
        use: {loader: require.resolve('babel-loader'), options: {babelrc: false, configFile: false,
          presets: [require.resolve('@babel/preset-env')]}}}]}
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(closeError => {
      if (error || closeError) return reject(error || closeError);
      if (stats.hasErrors()) return reject(new Error(stats.toString({all: false, errors: true})));
      resolve();
    })));
    const bytes = fs.readFileSync(path.join(output, name + '.js'));
    evidence[name] = {bytes: bytes.length, gzipBytes: gzipSync(bytes, {level: 9}).length,
      sha256: createHash('sha256').update(bytes).digest('hex')};
  }
  return evidence;
}

async function run() {
  const directory = path.resolve(process.argv[2]);
  const engine = process.argv[3] || 'chromium';
  assert.ok(['chromium', 'firefox', 'webkit'].includes(engine));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'nightscout-date-candidates-'));
  let browser, context, fixture;
  try {
    const bundleEvidence = await bundles(directory, output);
    fixture = await createPageFixture();
    browser = await playwright[engine].launch();
    context = await browser.newContext({serviceWorkers: 'block'});
    const blocked = [], errors = [];
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin !== fixture.origin) {blocked.push(route.request().url()); return route.abort();}
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(hash => localStorage.setItem('apisecrethash', hash), hash);
    await page.goto(fixture.origin);
    await page.waitForFunction(() => window.Nightscout?.client?.latestSGV?.mgdl === 123);
    const support = await page.evaluate(() => ({Temporal: typeof globalThis.Temporal, Intl: typeof globalThis.Intl,
      timeZone: typeof Intl.DateTimeFormat, locales: moment.locales()}));
    await page.evaluate(() => {globalThis.dateCandidateLibraries = {moment: globalThis.moment};});
    for (const name of ['dayjs', 'luxon', 'temporal']) await page.addScriptTag({path: path.join(output, name + '.js')});
    await page.evaluate('globalThis.createDateCandidates = ' + createCandidates.toString());
    await page.evaluate('globalThis.runDateContracts = ' + runContracts.toString());
    await page.evaluate('globalThis.runDateSeasons = ' + runSeasons.toString());
    const result = await page.evaluate(corpus => {
      // Compare only locales actually exposed by Nightscout's production bundle.
      corpus.locales = moment.locales();
      const libraries = globalThis.dateCandidateLibraries;
      const candidates = globalThis.createDateCandidates(libraries);
      if (globalThis.Temporal) candidates.nativeTemporal = globalThis.createDateCandidates({...libraries, Temporal: globalThis.Temporal}).temporal;
      const seasons = globalThis.runDateSeasons(candidates, corpus, libraries.luxon, globalThis.runDateContracts);
      return {corpus, seasons, moment: moment.version, momentTimezone: moment.tz.version, momentTzData: moment.tz.dataVersion};
    }, corpus);
    for (const season of result.seasons) for (const row of season.rows) for (const [name, observation] of Object.entries(row.results)) {
      assert.equal(observation.error, undefined, name + ' could not execute ' + row.kind + ': ' + JSON.stringify(row.args));
    }
    // Remove Intl before loading each candidate in a fresh realm: the Temporal
    // polyfill captures Intl constructors at module initialization.
    const withoutIntl = {moment: await page.evaluate(() => {
      const original = globalThis.Intl;
      try {
        globalThis.Intl = undefined;
        const d = moment.tz(1704067200000, 'Pacific/Chatham').locale('en');
        return {value: {date: d.format('YYYY-MM-DD'), time: d.format('HH:mm')}};
      } finally {globalThis.Intl = original;}
    })};
    for (const name of ['dayjs', 'luxon', 'temporal']) {
      const isolated = await context.newPage();
      const initializationErrors = [];
      isolated.on('pageerror', error => initializationErrors.push(error.message));
      try {
        await isolated.evaluate(() => {globalThis.Intl = undefined; globalThis.dateCandidateLibraries = {};});
        await isolated.addScriptTag({path: path.join(output, name + '.js')});
        await isolated.evaluate('globalThis.createDateCandidates = ' + createCandidates.toString());
        const observation = await isolated.evaluate(name => {
          try {return {value: globalThis.createDateCandidates(globalThis.dateCandidateLibraries)[name].format(1704067200000, 'Pacific/Chatham', 'en')};}
          catch (error) {return {error: error.name + ': ' + error.message};}
        }, name);
        withoutIntl[name] = {...observation, initializationErrors};
      } finally {await isolated.close();}
    }
    await page.evaluate(() => {window.Nightscout.client.socket.disconnect(); window.Nightscout.client.alarmSocket.disconnect();});
    assert.deepEqual(blocked, []); assert.deepEqual(errors, []);
    console.log(JSON.stringify({baseline: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
      sources: Object.fromEntries(['browser-date-candidate-probe.cjs', 'date-candidate-contracts.cjs', 'date-candidate-probe.cjs'].map(name =>
        [name, createHash('sha256').update(fs.readFileSync(path.join(__dirname, name))).digest('hex')])),
      engine, browserVersion: browser.version(), node: process.version, support, bundleEvidence, withoutIntl,
      appBundleSha256: createHash('sha256').update(fs.readFileSync('node_modules/.cache/_ns_cache/public/js/bundle.app.js')).digest('hex'),
      scope: 'Candidate APIs against actual production Moment global; clipped browser timezone data. Standalone candidate bundle bytes are not an app replacement delta. No therapy or UI migration.', ...result}, null, 2));
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    if (fixture) await new Promise(resolve => fixture.io.close(resolve));
    fs.rmSync(output, {recursive: true, force: true});
  }
}

run().catch(error => {console.error(error); process.exitCode = 1;});
