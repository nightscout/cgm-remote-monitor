'use strict';

const assert = require('node:assert/strict');
const playwright = require('playwright');
let browser;

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
  }
};
