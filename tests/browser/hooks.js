'use strict';

const assert = require('node:assert/strict');
const playwright = require('playwright-core');
let browser;
let fixtureHosts;
function validateFixtureHosts (hosts) {
  assert(Array.isArray(hosts) && hosts.length === 2 && new Set(hosts).size === 2 &&
    hosts.every(host => typeof host === 'string' && /^[a-z0-9-]+\.example\.test$/.test(host)), 'Explicit two synthetic fixture hosts required');
  return Object.freeze([...hosts]);
}
exports.validateFixtureHosts = validateFixtureHosts;
exports.getFixtureHosts = () => fixtureHosts;
exports.launchNamedFixtureBrowser = async hosts => {
  assert(!browser, 'Browser already started');
  const selected = validateFixtureHosts(hosts);
  assert.equal(process.env.NIGHTSCOUT_TEST_BROWSER || 'chromium', 'chromium', 'Named fixture resolution requires Chromium');
  browser = await playwright.chromium.launch({args: ['--no-proxy-server', '--host-resolver-rules=' + selected.map(host => 'MAP ' + host + ' 127.0.0.1').join(',')]});
  fixtureHosts = selected;
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
  }
};
