'use strict';

const assert = require('node:assert/strict');
const selectedWidgetsReady = require('./ui-widget-probe');
const path = require('node:path');
const {fork} = require('node:child_process');
const {once} = require('node:events');
const {getBrowser} = require('./hooks');

function compiled(worker) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Page HMR compiler timed out')), 60000);
    const onMessage = message => finish(message.error ? new Error(message.error) : null, message);
    const onExit = code => finish(new Error('Page HMR compiler exited: ' + code));
    function finish(error, value) {
      clearTimeout(timer); worker.off('message', onMessage); worker.off('exit', onExit);
      if (error) reject(error); else resolve(value);
    }
    worker.once('message', onMessage); worker.once('exit', onExit);
  });
}

describe('Actual page entries with development hot middleware', function () {
  let worker, origin, stderr = '';
  const exports = {app: 'client', reports: 'reportclient', admin: 'admin_plugins', profile: 'profileclient', food: 'foodclient'};
  before(async function () {
    this.timeout(65000);
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    worker = fork(path.join(__dirname, 'page-hmr-worker.js'), [], {env: {...env, NODE_ENV: 'development'}, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    worker.stderr.on('data', chunk => {stderr = (stderr + chunk).slice(-12000);});
    origin = (await compiled(worker)).origin;
  });
  afterEach(function () {if (this.currentTest.err) this.currentTest.err.message += '\nCompiler stderr: ' + stderr;});
  after(async function () {
    if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
    const exited = once(worker, 'exit'), timer = setTimeout(() => worker.kill('SIGKILL'), 5000);
    try {
      worker.send({close: true});
      const [code, signal] = await exited;
      assert.equal(signal, null, 'Compiler required forced shutdown');
      assert.equal(code, 0);
    } finally {clearTimeout(timer);}
  });

  it('applies two updates to each page entry and shared app without reloading or dropping page exports', async function () {
    this.timeout(120000);
    const context = await getBrowser().newContext({serviceWorkers: 'block', acceptDownloads: false});
    const external = [], errors = [], pages = new Map(), navigations = new Map();
    context.on('request', request => {if (new URL(request.url()).origin !== origin) external.push(request.url());});
    try {
      for (const entry of Object.keys(exports)) {
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        page.on('pageerror', error => errors.push(error.message));
        navigations.set(entry, 0);
        page.on('framenavigated', frame => {if (frame === page.mainFrame()) navigations.set(entry, navigations.get(entry) + 1);});
        await page.goto(origin + '/' + entry);
        await page.waitForFunction(entry => window.pageHotVersions && window.pageHotVersions[entry] === 0, entry);
        await page.locator('#draft').fill('Unsaved ' + entry);
        await page.evaluate(() => {window.initialClient = window.Nightscout.client;});
        pages.set(entry, page);
      }
      // Page-local changes first; shared updates must preserve every page's
      // public exports and draft rather than replacing the global namespace.
      for (const entry of ['reports', 'admin', 'profile', 'food', 'app']) {
        for (const version of [1, 2]) {
          const build = compiled(worker);
          worker.send({entry, version});
          await build;
          for (const [name, page] of pages) {
            if (name === entry || entry === 'app') await page.waitForFunction(({entry, version}) => window.pageHotVersions[entry] === version, {entry, version});
            const result = await page.evaluate(exportName => ({client: window.Nightscout.client === window.initialClient, type: typeof window.Nightscout[exportName]}), exports[name]);
            assert.deepEqual(result, {client: true, type: name === 'app' ? 'object' : 'function'}, name + ' after ' + entry + ' update');
            assert.equal(await page.locator('#draft').inputValue(), 'Unsaved ' + name);
            assert.equal(navigations.get(name), 1, name + ' unexpectedly reloaded');
            assert.equal(await page.evaluate(selectedWidgetsReady), true, name + ' lost UI widget functions or inline styles after HMR');
          }
        }
      }
      assert.deepEqual(errors, [], 'Uncaught HMR errors');
      assert.deepEqual(external, [], 'Unexpected external HMR request');
    } finally {await context.close();}
  });
});
