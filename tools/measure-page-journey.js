'use strict';

const assert = require('node:assert/strict');
const acceptance = require('./page-resource-acceptance');
const path = require('node:path');
const {chromium} = require('playwright-core');
const {workload, ready, buildIdentity} = require('./measure-page-startup');
const {createPageFixture, pages, hash} = require('../tests/fixtures/page-startup/server');

async function journey(fixture, data) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({serviceWorkers: 'allow', viewport: {width: 1280, height: 900}, timezoneId: 'America/Los_Angeles'});
    const errors = [], external = [], steps = [];
    context.on('request', request => {if (new URL(request.url()).origin !== fixture.origin) external.push(request.url());});
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(10000);
    await page.clock.setFixedTime(new Date(data.now));
    await page.addInitScript(hash => localStorage.setItem('apisecrethash', hash), hash);
    fixture.state.traffic = [];
    let from = 0, navigations = 0;
    page.on('framenavigated', frame => {if (frame === page.mainFrame()) navigations++;});
    const visits = [['initial', pages[0]], ...pages.slice(1).map(page => ['firstVisit', page]), ...pages.map(page => ['cachedVisit', page])];
    for (const [phase, [url, , , entry]] of visits) {
      process.stderr.write('  ' + phase + ' ' + entry + '\n');
      // The parent automatically reloads during its first worker install.
      await page.goto(fixture.origin + url, {waitUntil: 'commit'});
      await page.waitForFunction(ready, entry);
      if (phase !== 'initial') await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      else await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.ready).active));
      await page.waitForFunction(async () => {
        const urls = [...document.querySelectorAll('script[src]')].map(script => script.src).filter(url => /\/bundle\/js\/bundle\..*\.js/.test(url));
        const cached = await Promise.all(urls.map(url => caches.match(url)));
        return cached.length > 0 && cached.every(response => response && response.status === 200);
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const requests = fixture.state.traffic.slice(from);
      const bundleRequests = requests.filter(request => /\/bundle\/js\/bundle\..*\.js$/.test(request.path));
      if (phase === 'cachedVisit') assert.equal(bundleRequests.length, 0, 'A cached page must not redownload a bundle: ' + entry);
      steps.push({phase, entry, navigations, requests: requests.length, nonPollingRequests: requests.filter(request => request.path !== '/socket.io/').length, completedResponses: requests.filter(request => request.completed).length,
        responseBodyBytes: requests.filter(request => request.completed).reduce((sum, request) => sum + request.bodyBytes, 0), bundleRequests: bundleRequests.map(request => ({...request}))});
      from = fixture.state.traffic.length;
    }
    assert.deepEqual(errors, [], 'Uncaught journey errors'); assert.deepEqual(external, [], 'External journey request');
    return {browser: browser.version(), steps,
      totalRequests: fixture.state.traffic.length,
      nonPollingRequests: fixture.state.traffic.filter(request => request.path !== '/socket.io/').length,
      unfinishedBodyBytes: fixture.state.traffic.filter(request => !request.completed).reduce((sum, request) => sum + request.bodyBytes, 0),
      totalResponseBodyBytes: fixture.state.traffic.filter(request => request.completed).reduce((sum, request) => sum + request.bodyBytes, 0)};
  } finally {await browser.close();}
}

async function main() {
  if (!process.argv[2]) throw new Error('Usage: node tools/measure-page-journey.js PARENT_CHECKOUT [SAMPLES=7]');
  const samples = Number(process.argv[3] || 7);
  assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 20);
  const roots = {parent: path.resolve(process.argv[2]), candidate: path.resolve(__dirname, '..')};
  const data = workload(), fixtures = new Map(), rows = [];
  let complete = false, assessment;
  try {
    for (const [label, root] of Object.entries(roots)) fixtures.set(label, await createPageFixture({root, ...data, legacyStatusQuery: true, compress: true, measureTraffic: true}));
    for (let run = 0; run < samples; run++) for (const label of run % 2 ? ['candidate', 'parent'] : ['parent', 'candidate']) {
      process.stderr.write('Journey ' + run + ' ' + label + '\n');
      rows.push({run, label, ...await journey(fixtures.get(label), data)});
    }
    complete = true;
    assessment = acceptance.journey(rows, samples);
    if (assessment.assessed && !assessment.pass) throw new Error('Page resource acceptance failed; inspect the JSON assessment');
  } finally {
    await Promise.all([...fixtures.values()].map(fixture => new Promise(resolve => fixture.io.close(resolve))));
    console.log(JSON.stringify({complete, assessment, node: process.versions.node, samples,
      builds: Object.fromEntries(Object.entries(roots).map(([label, root]) => [label, buildIdentity(root)])),
      scenario: 'worker-enabled initial dashboard, every secondary page, then every page revisited', rows}, null, 2));
  }
}

if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1;});
