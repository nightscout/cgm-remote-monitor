'use strict';

const assert = require('node:assert/strict');
const { createSecureDOM } = require('./fixtures/secure-jsdom');
const { installDomGlobals, restoreDomGlobals } = require('./fixtures/dom-globals');

describe('native CareLink admin asset freshness', function () {
  it('versions the admin bundle and styles so an old week-long cached bundle is not reused', async function () {
    const render = cachebuster => require('ejs').renderFile(require('node:path').join(__dirname, '../views/adminindex.html'),
      { locals: { bundle: '/bundle', cachebuster }, type: 'admin', title: 'Admin tools' });
    for (const revision of ['first-build', 'second-build']) {
      const html = await render(revision);
      for (const asset of ['/bundle/js/bundle.app.js', '/css/admin.css', '/admin/js/admin.js']) {
        assert.ok(html.includes(asset + '?v=' + revision));
        assert.ok(!html.includes('"' + asset + '"'));
      }
    }
  });
});

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
  it('replays the HAR transition without collapsing the login area or hiding the failure', async function () {
    state.session = { id: 'test', state: 'waiting', patients: [] }; state.busy = true;
    let frame;
    const original = $.ajax;
    $.ajax = options => options.url.includes('/frame?') ? new Promise(resolve => { frame = resolve; }) : original(options);
    await init();
    state.session = { id: 'test', state: 'failed', error: 'provider_unavailable', patients: [] }; state.busy = false;
    frame({ seq: 1, image: null, state: 'exchanging' });
    await new Promise(resolve => setImmediate(resolve));
    assert.notEqual($('.carelink-panel').css('display'), 'none');
    assert.equal($('.carelink-screen').css('display'), 'none');
    assert.equal($('.carelink-feedback').attr('data-state'), 'failed');
    assert.ok($('.carelink-feedback').text().includes('CareLink connection not completed'));
    const retry = $('button').filter((i, b) => b.textContent === 'Try signing in again');
    assert.notEqual(retry.css('display'), 'none'); assert.equal(retry.prop('disabled'), false);
    assert.equal(dom.window.document.activeElement, $('.carelink-feedback')[0]);
  });
  it('keeps progress visible while exchanging tokens and loading the account', async function () {
    state.session = { id: 'test', state: 'exchanging', phase: 'token_exchange', patients: [] };
    const plugin = await init();
    assert.ok($('.carelink-feedback').text().includes('Completing the secure connection'));
    assert.equal($('.carelink-feedback').attr('aria-busy'), 'true');
    state.session = { ...state.session, phase: 'account_lookup' };
    await plugin.actions[0].code();
    assert.ok($('.carelink-feedback').text().includes('Loading the accounts'));
    assert.notEqual($('.carelink-panel').css('display'), 'none');
  });
  it('shows only safe failure diagnostics and offers a working retry', async function () {
    state.session = { id: 'test', state: 'failed', error: 'provider_unavailable', phase: 'account_lookup', patients: [],
      diagnostic: { operation: 'account_profile', reason: 'invalid_json', httpStatus: 403, body: '<b>private-provider-body</b>' } };
    await init();
    assert.ok($('.carelink-diagnostic').text().includes('Account profile · HTTP 403 · unexpected response format'));
    assert.ok(!$('.carelink-feedback').text().includes('private-provider-body'));
    const original = $.ajax;
    $.ajax = options => {
      if (options.method === 'POST' && options.url.endsWith('/sessions')) {
        calls.push(options); state.session = { id: 'next', state: 'starting', patients: [] }; state.busy = true;
        return Promise.resolve(state.session);
      }
      return original(options);
    };
    $('#carelink-country').val('GB');
    $('button').filter((i, b) => b.textContent === 'Try signing in again').trigger('click');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.filter(c => c.method === 'POST' && c.url.endsWith('/sessions')).length, 1);
    assert.equal($('.carelink-feedback').attr('data-state'), 'starting');
    assert.equal($('.carelink-patients').children().length, 0);
  });
  it('does not leave a connected result card after disconnect', async function () {
    state.session = { id: 'test', state: 'connected', patients: [] }; await init();
    assert.equal($('.carelink-panel').css('display'), 'none');
    assert.ok($('[role=status]').first().text().includes('not connected'));
  });
});
