'use strict';

// Owned synthetic workload: never connects to a Nightscout deployment/database.
const assert = require('node:assert/strict');
const acceptance = require('./page-resource-acceptance');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {createHash} = require('node:crypto');
const {chromium} = require('playwright-core');
const {createPageFixture, pages, hash} = require('../tests/fixtures/page-startup/server');

function buildIdentity(root) {
  const directory = path.join(root, 'node_modules/.cache/_ns_cache/public/js');
  const names = fs.readdirSync(directory).filter(name => name.endsWith('.js')).sort();
  return Object.fromEntries(names.map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')]));
}

function workload() {
  const now = Date.now();
  const sgvs = Array.from({length: 576}, (_, i) => ({
    _id: i.toString(16).padStart(24, '0'), type: 'sgv', mills: now - (575 - i) * 300000,
    mgdl: i === 575 ? 123 : 120 + Math.round(35 * Math.sin(i / 20)), direction: 'Flat'
  }));
  const treatments = Array.from({length: 48}, (_, i) => ({
    _id: (1000 + i).toString(16).padStart(24, '0'), eventType: 'Carb Correction', carbs: 10,
    mills: now - (48 - i) * 3600000, created_at: new Date(now - (48 - i) * 3600000).toISOString()
  }));
  const profiles = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../tests/fixtures/openaps-storage/ns-profile.json'), 'utf8'));
  const foods = Array.from({length: 300}, (_, i) => ({
    _id: (2000 + i).toString(16).padStart(24, '0'), type: 'food', category: 'Fixture',
    subcategory: 'Group ' + i % 10, name: 'Fixture food ' + i, carbs: 10, portion: 1, unit: 'g'
  }));
  return {now, payload: {sgvs, treatments, profiles, food: foods, devicestatus: []}, apiData: {
    '/api/v1/profile.json': profiles, '/api/v1/profiles': profiles,
    '/api/v1/food.json': foods, '/api/v1/food/regular.json': foods,
    '/api/v1/treatments.json': treatments,
    '/api/v1/entries.json': sgvs.map(sgv => ({...sgv, date: sgv.mills, sgv: sgv.mgdl})).reverse()
  }};
}

function ready(entry) {
  const ns = window.Nightscout;
  if (!ns || !ns.client || !ns.client.ddata || ns.client.ddata.sgvs.length !== 576 || window.$.active !== 0) return false;
  if (entry === 'app') return document.querySelector('.currentBG').textContent.trim() === '123';
  if (entry === 'reports') return Boolean(ns.report_plugins && document.querySelector('#rp_from').value);
  if (entry === 'admin') return document.querySelector('#admin_placeholder').children.length === 8 && document.querySelectorAll('#admin_placeholder button').length === 11;
  if (entry === 'profile') return document.querySelector('.pe_status').textContent === 'Values loaded.';
  return document.querySelector('#fe_status').textContent === 'Database loaded';
}

async function sample(fixture, data, entry, url, snapshotPath) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({serviceWorkers: 'block', viewport: {width: 1280, height: 900}, timezoneId: 'America/Los_Angeles'});
    const errors = [], external = [], responses = new Map(), completed = [];
    let websocketPayloadBytes = 0;
    context.on('request', request => {if (new URL(request.url()).origin !== fixture.origin) external.push(request.url());});
    const page = await context.newPage();
    page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.setFixedTime(new Date(data.now));
    await page.addInitScript(hash => localStorage.setItem('apisecrethash', hash), hash);
    const session = await context.newCDPSession(page);
    await session.send('Network.enable');
    session.on('Network.responseReceived', ({requestId, response}) => responses.set(requestId, {
      path: new URL(response.url).pathname, status: response.status,
      encoding: response.headers['Content-Encoding'] || response.headers['content-encoding'] || 'identity'
    }));
    session.on('Network.loadingFinished', ({requestId, encodedDataLength}) => {
      if (responses.has(requestId)) completed.push({...responses.get(requestId), responseTransferBytes: encodedDataLength});
    });
    session.on('Network.webSocketFrameReceived', ({response}) => {
      websocketPayloadBytes += Buffer.byteLength(response.payloadData, response.opcode === 2 ? 'base64' : 'utf8');
    });
    await page.goto(fixture.origin + url);
    try {await page.waitForFunction(ready, entry);}
    catch (error) {
      error.message += '\nStartup state: ' + JSON.stringify(await page.evaluate(() => ({
        sgvs: window.Nightscout?.client?.ddata?.sgvs?.length, ajax: window.$?.active,
        adminChildren: document.querySelector('#admin_placeholder')?.children.length,
        adminButtons: document.querySelectorAll('#admin_placeholder button').length,
        profile: document.querySelector('.pe_status')?.textContent,
        food: document.querySelector('#fe_status')?.textContent
      })));
      error.message += '\nBrowser errors: ' + JSON.stringify(errors);
      throw error;
    }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const startupMs = await page.evaluate(() => performance.now());
    const counts = await page.evaluate(() => ({sgvs: window.Nightscout.client.ddata.sgvs.length,
      treatments: window.Nightscout.client.ddata.treatments.length, food: window.Nightscout.client.ddata.food.length}));
    assert.deepEqual(counts, {sgvs: 576, treatments: 48, food: 300});
    await session.send('HeapProfiler.collectGarbage');
    const heap = await session.send('Runtime.getHeapUsage');
    const dom = await session.send('Memory.getDOMCounters');
    if (snapshotPath) {
      const descriptor = fs.openSync(snapshotPath, 'wx');
      const write = ({chunk}) => fs.writeSync(descriptor, chunk);
      session.on('HeapProfiler.addHeapSnapshotChunk', write);
      try {await session.send('HeapProfiler.takeHeapSnapshot', {reportProgress: false});}
      finally {session.off('HeapProfiler.addHeapSnapshotChunk', write); fs.closeSync(descriptor);}
    }
    assert.deepEqual(errors, [], 'Uncaught benchmark application errors');
    assert.deepEqual(external, [], 'External benchmark requests');
    const result = {entry, browser: browser.version(), startupMs, heap, dom, counts,
      completedResponses: completed.length, responseTransferBytes: completed.reduce((sum, response) => sum + response.responseTransferBytes, 0),
      websocketPayloadBytes, bundles: completed.filter(response => /\/bundle\/js\/bundle\..*\.js$/.test(response.path))};
    await context.close();
    return result;
  } finally {await browser.close();}
}

async function main() {
  const parent = process.argv[2];
  if (!parent) throw new Error('Usage: node tools/measure-page-startup.js PARENT_CHECKOUT [SAMPLES=7] [ENTRY=all] [HEAP_DIRECTORY]');
  const samples = Number(process.argv[3] || 7);
  assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 20, 'Samples must be 1..20');
  const selection = process.argv[4] || 'all';
  assert.ok(selection === 'all' || pages.some(page => page[3] === selection), 'Unknown entry');
  const selectedPages = pages.filter(page => selection === 'all' || page[3] === selection);
  const snapshotDirectory = process.argv[5];
  if (snapshotDirectory) fs.mkdirSync(snapshotDirectory, {recursive: true});
  const data = workload();
  const roots = {parent: path.resolve(parent), candidate: path.resolve(__dirname, '..')};
  const fixtures = new Map(), rows = [];
  let complete = false, assessment;
  try {
    for (const [label, root] of Object.entries(roots)) fixtures.set(label, await createPageFixture({root, ...data, compress: true}));
    for (let run = 0; run < samples; run++) {
      for (const [url, , , entry] of selectedPages) {
        for (const label of run % 2 ? ['candidate', 'parent'] : ['parent', 'candidate']) {
          process.stderr.write('Measuring ' + run + ' ' + label + ' ' + entry + '\n');
          rows.push({run, label, ...await sample(fixtures.get(label), data, entry, url, snapshotDirectory && path.join(snapshotDirectory, label + '-' + entry + '-' + run + '.heapsnapshot'))});
        }
      }
    }
    complete = true;
    assessment = acceptance.startup(rows, samples);
    if (assessment.assessed && !assessment.pass) throw new Error('Page resource acceptance failed; inspect the JSON assessment');
  } finally {
    await Promise.all([...fixtures.values()].map(fixture => new Promise(resolve => fixture.io.close(resolve))));
    console.log(JSON.stringify({complete, assessment, node: process.versions.node, zlib: process.versions.zlib,
      machine: {platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model},
      samples, entries: selectedPages.map(page => page[3]), builds: Object.fromEntries(Object.entries(roots).map(([label, root]) => [label, buildIdentity(root)])),
      workload: {sgvs: 576, treatments: 48, foods: 300, profiles: data.payload.profiles.length, fixedTime: new Date(data.now).toISOString()},
      scenario: 'cold direct pages, service workers blocked, fresh browser per sample', rows}, null, 2));
  }
}

module.exports = {workload, ready, buildIdentity};

if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1;});
