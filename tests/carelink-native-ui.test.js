'use strict';

const assert = require('node:assert/strict');
const { createSecureDOM } = require('./fixtures/secure-jsdom');
const { installDomGlobals, restoreDomGlobals } = require('./fixtures/dom-globals');

describe('native CareLink owner controls', function () {
  let dom, globals, $, state, calls;
  beforeEach(function () {
    dom = createSecureDOM('<!doctype html><body><fieldset><div id="admin_connect_0_html"></div></fieldset></body>');
    globals = installDomGlobals(dom); $ = dom.window.$; calls = [];
    state = { available: true, connected: false, configured: false, conflicts: [], session: null };
    $.ajax = options => {
      calls.push(options);
      return Promise.resolve(options.url.endsWith('/countries') ? [{ code: 'GB', name: 'United Kingdom' }] : state);
    };
  });
  afterEach(function () {
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    dom.window.close(); restoreDomGlobals(globals);
  });
  async function init() {
    const plugin = require('../lib/admin_plugins/connect')();
    plugin.actions[0].init({ headers: () => ({ 'api-secret': 'test-digest' }) });
    await new Promise(resolve => setImmediate(resolve)); return plugin;
  }
  it('loads countries and uses authenticated headers without URL secrets', async function () {
    await init();
    assert.equal($('#carelink-country option').length, 2);
    assert.ok(calls.every(c => c.headers['api-secret'] === 'test-digest' && !c.url.includes('secret')));
    assert.equal($('button').filter((i, b) => b.textContent === 'Connect Medtronic').prop('disabled'), false);
  });
  it('keeps Connect disabled when the packaged browser is unavailable', async function () {
    state.available = false; await init();
    assert.equal($('button').filter((i, b) => b.textContent === 'Connect Medtronic').prop('disabled'), true);
  });
  it('renders patient identity as text, never executable HTML', async function () {
    state.session = { id: 'test', state: 'selecting', patients: [{ username: '<img src=x onerror=alert(1)>', label: '<script>alert(1)</script>' }] };
    await init(); assert.equal($('.carelink-patients script, .carelink-patients img').length, 0);
    assert.ok($('.carelink-patients').text().includes('<script>'));
  });
  it('distinguishes authentication from receipt of readings', async function () {
    state.configured = true; state.connected = true; state.patient = 'Example'; await init();
    assert.ok($('[role=status]').text().includes('Waiting for CareLink readings'));
    assert.ok($('.carelink-details').text().includes('Example'));
  });
});
