'use strict';

const assert = require('node:assert/strict');
const playwright = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
let browser;
let fixtureHosts;
let fixtureRuntime;
function verifyFixtureRuntime (runtime) {
  assert(runtime && typeof runtime === 'object' && !Array.isArray(runtime) && Object.keys(runtime).length === 3 &&
    runtime.browser === 'chromium' && typeof runtime.executablePath === 'string' && path.isAbsolute(runtime.executablePath) &&
    typeof runtime.sha256 === 'string' && /^[a-f0-9]{64}$/.test(runtime.sha256), 'Explicit pinned Chromium fixture runtime required');
  assert.equal(fs.realpathSync(runtime.executablePath), runtime.executablePath, 'Pinned browser path must be canonical');
  const stat = fs.statSync(runtime.executablePath);
  assert(stat.isFile(), 'Pinned browser must be a regular file'); fs.accessSync(runtime.executablePath, fs.constants.X_OK);
  assert.equal(createHash('sha256').update(fs.readFileSync(runtime.executablePath)).digest('hex'), runtime.sha256, 'Pinned browser executable hash mismatch');
  return Object.freeze({...runtime, dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777});
}
exports.verifyFixtureRuntime = verifyFixtureRuntime;
exports.getFixtureRuntime = () => fixtureRuntime;
function validateFixtureHosts (hosts) {
  assert(Array.isArray(hosts) && hosts.length === 2 && new Set(hosts).size === 2 &&
    hosts.every(host => typeof host === 'string' && /^[a-z0-9-]+\.example\.test$/.test(host)), 'Explicit two synthetic fixture hosts required');
  return Object.freeze([...hosts]);
}
exports.validateFixtureHosts = validateFixtureHosts;
exports.getFixtureHosts = () => fixtureHosts;
exports.launchNamedFixtureBrowser = async (hosts, runtime) => {
  assert(!browser, 'Browser already started');
  const selected = validateFixtureHosts(hosts), checked = verifyFixtureRuntime(runtime);
  assert.equal(process.env.NIGHTSCOUT_TEST_BROWSER || 'chromium', 'chromium', 'Named fixture resolution requires Chromium');
  browser = await playwright.chromium.launch({executablePath: checked.executablePath, args: ['--no-proxy-server', '--host-resolver-rules=' + selected.map(host => 'MAP ' + host + ' 127.0.0.1').join(',')]});
  fixtureHosts = selected;
  fixtureRuntime = Object.freeze({...checked, version: browser.version()});
};

exports.getBrowser = () => {
  assert.ok(browser, 'Run browser tests with --require ./tests/browser/hooks.js');
  return browser;
};

exports.mochaHooks = {
  async beforeAll() {
    const name = process.env.NIGHTSCOUT_TEST_BROWSER || 'chromium';
    assert.ok(['chromium', 'firefox', 'webkit'].includes(name), 'Unsupported NIGHTSCOUT_TEST_BROWSER: ' + name);
    browser = await playwright[name].launch();
    console.log('Browser fixture:', name, browser.version());
  },
  async afterEach() {
    if (!browser) return;
    const leaked = browser.contexts();
    await Promise.all(leaked.map(context => context.close()));
    assert.equal(leaked.length, 0, 'Test leaked a browser context');
  },
  async afterAll() {
    if (browser) await browser.close();
    browser = undefined;
    fixtureHosts = undefined;
    fixtureRuntime = undefined;
  }
};
