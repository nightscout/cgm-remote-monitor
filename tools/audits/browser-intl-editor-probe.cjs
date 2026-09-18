'use strict';

const assert = require('node:assert/strict');
const playwright = require('playwright-core');
const {createPageFixture, hash} = require('../../tests/fixtures/page-startup/server');
const {createFormatter, zones, instants} = require('./intl-editor-format-probe.cjs');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {readFileSync} = require('node:fs');

async function run() {
  const engine = process.argv[2] || 'chromium';
  assert.ok(['chromium', 'firefox', 'webkit'].includes(engine));
  const {io, origin} = await createPageFixture();
  let browser, context;
  try {
    browser = await playwright[engine].launch();
    context = await browser.newContext({serviceWorkers: 'block'});
    const blocked = [], errors = [];
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) {
        blocked.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    await context.routeWebSocket(url => new URL(url).origin.replace(/^ws:/, 'http:') !== origin, socket => {
      blocked.push(socket.url()); socket.close();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(hash => localStorage.setItem('apisecrethash', hash), hash);
    await page.goto(origin);
    await page.waitForFunction(() => window.Nightscout?.client?.latestSGV?.mgdl === 123);
    await page.evaluate('globalThis.formatEditorPrototype = ' + createFormatter.toString());
    const result = await page.evaluate(({zones, instants}) => {
      const rows = [];
      for (const zone of zones) {
        const format = globalThis.formatEditorPrototype(zone);
        for (const locale of moment.locales()) {
          for (const instant of instants) {
            const date = moment.tz(instant, zone).locale(locale);
            const previous = {date: date.format('YYYY-MM-DD'), time: date.format('HH:mm')};
            const candidate = format(instant);
            rows.push({zone, locale, instant: new Date(instant).toISOString(), previous, candidate,
              equal: previous.date === candidate.date && previous.time === candidate.time});
          }
        }
      }
      return {bundledLocales: moment.locales(), requestedLocalesNotBundled: ['en', 'de', 'fr', 'ar', 'fa'].filter(locale => !moment.locales().includes(locale)), moment: moment.version, momentTimezone: moment.tz.version, momentTzData: moment.tz.dataVersion,
        cases: rows.length, mismatches: rows.filter(row => !row.equal)};
    }, {zones, instants});
    await page.evaluate(() => {
      window.Nightscout.client.socket.disconnect();
      window.Nightscout.client.alarmSocket.disconnect();
    });
    assert.deepEqual(blocked, []);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({engine, browserVersion: browser.version(), node: process.version,
      baseline: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
      appBundleSha256: createHash('sha256').update(readFileSync('node_modules/.cache/_ns_cache/public/js/bundle.app.js')).digest('hex'),
      scope: 'Actual production app bundle and its clipped timezone data; editor formatting shapes only, not editor interaction or therapy calculations.',
      ...result}, null, 2));
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    await new Promise(resolve => io.close(resolve));
  }
}
run().catch(error => {console.error(error); process.exitCode = 1;});
