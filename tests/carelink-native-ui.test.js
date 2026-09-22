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
      assert.ok(!html.includes('user-scalable=0') && !html.includes('maximum-scale=1'));
      for (const asset of ['/bundle/js/bundle.app.js', '/css/admin.css', '/admin/js/admin.js']) {
        assert.ok(html.includes(asset + '?v=' + revision));
        assert.ok(!html.includes('"' + asset + '"'));
      }
    }
  });
});

describe('dedicated data sources page', function () {
  it('renders only the source page, with versioned assets and accessible navigation', async function () {
    for (const revision of ['first-build', 'second-build']) {
      const html = await require('ejs').renderFile(require('node:path').join(__dirname, '../views/data-sources.html'),
        { locals: { bundle: '/bundle', cachebuster: revision } });
      assert.ok(html.includes('<h1>Data sources</h1>'));
      assert.ok(html.includes('Available data sources'));
      assert.ok(html.includes('id="data-sources-list"'));
      assert.ok(html.includes('id="authentication_placeholder"'));
      assert.ok(html.includes('Skip to data sources'));
      assert.ok(html.includes('Back to Nightscout'));
      assert.ok(!html.includes('admin_placeholder') && !html.includes('/admin/'));
      assert.ok(!html.includes('/css/admin.css') && !html.includes('/css/main.css'));
      assert.ok(!html.includes('user-scalable=0') && !html.includes('maximum-scale=1'));
      for (const asset of ['/bundle/js/bundle.app.js', '/css/data-sources.css', '/js/data-sources.js']) {
        assert.ok(html.includes(asset + '?v=' + revision));
      }
    }
  });
  it('mounts sources through the existing authentication flow, without initializing admin tools', function () {
    let ready, mounted = 0;
    const client = { init: callback => { ready = callback; } };
    const filename = require('node:path').join(__dirname, '../static/js/data-sources.js');
    const source = require('node:fs').readFileSync(filename, 'utf8');
    const context = { window: { Nightscout: { client, dataSources: { mount: (actualClient, container) => {
      assert.equal(actualClient, client); assert.equal(container, '#data-sources-list'); mounted++;
    } } } }, $: selector => {
      assert.equal(selector, '#data-sources-loading'); return { hide: () => {} };
    } };
    require('node:vm').runInNewContext(source, context, { filename });
    assert.equal(client.requiredPermission, '*');
    assert.equal(mounted, 0);
    ready();
    assert.equal(mounted, 1);
  });
  it('links the Nightscout menu directly to the standalone route', function () {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../views/index.html'), 'utf8');
    assert.ok(html.includes('id="datasourceslink" href="/data-sources"'));
    assert.ok(!html.includes('/admin#carelink'));
  });
});

describe('native CareLink owner controls', function () {
  let dom, globals, $, state, calls;
  beforeEach(function () {
    dom = createSecureDOM('<!doctype html><body><div id="data-sources-list"></div></body>');
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
    const [plugin] = require('../lib/data-sources').mount({ headers: () => ({ 'api-secret': 'test-digest' }) }, '#data-sources-list');
    await new Promise(resolve => setImmediate(resolve)); return plugin;
  }
  it('mounts only available source cards and does not duplicate them after a socket reconnect', async function () {
    const controller = await init();
    const callCount = calls.length;
    const again = require('../lib/data-sources').mount({ headers: () => ({}) }, '#data-sources-list');
    assert.equal(again[0], controller);
    assert.equal(calls.length, callCount);
    assert.equal($('#data-sources-list > section').length, 1);
    assert.equal($('#carelink').attr('aria-label'), 'Medtronic CareLink');
    assert.equal($('fieldset, .adminButton, #admin_placeholder').length, 0);
  });
  it('keeps CareLink out of the legacy admin registry while retaining its other tools', function () {
    const names = [];
    require('../lib/admin_plugins')({}).eachPlugin(plugin => names.push(plugin.name));
    assert.ok(names.includes('subjects') && names.includes('roles'));
    assert.equal(names.length, 8);
    assert.ok(!names.includes('connect'));
  });
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
    await plugin.refresh();
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
  it('shows a connected dashboard with separate account, reading and sync details', async function () {
    Object.assign(state, { configured: true, connected: true, country: 'GB', patient: 'Example account', lastReading: Date.now() - 120000, lastSync: Date.now() - 10000,
      session: { id: 'complete', state: 'connected', patients: [] } });
    await init();
    assert.equal($('.carelink-badge span').text(), 'Connected');
    assert.equal($('.carelink-badge').attr('data-tone'), 'success');
    assert.equal($('.carelink-account').text(), 'Example account');
    assert.equal($('.carelink-latest').text(), '2 min ago');
    assert.equal($('.carelink-last-sync').text(), 'Just now');
    assert.ok($('.carelink-latest').attr('title'));
    assert.equal($('.carelink-setup').css('display'), 'none');
    assert.equal($('.carelink-panel').css('display'), 'none');
    const settings = $('button').filter((i, b) => b.textContent === 'Connection settings');
    settings.trigger('click');
    assert.notEqual($('.carelink-setup').css('display'), 'none');
    assert.equal(settings.attr('aria-expanded'), 'true');
    assert.equal($('#carelink-country').val(), 'GB');
    assert.equal(dom.window.document.activeElement, $('#carelink-country')[0]);
    assert.equal(calls.filter(c => c.method !== 'GET').length, 0);
  });
  it('does not overwrite a changed country during automatic status refresh', async function () {
    Object.assign(state, { configured: true, connected: true, country: 'GB' });
    const plugin = await init();
    $('#carelink-country').append($('<option>').val('CA').text('Canada')).val('CA').trigger('change');
    await plugin.refresh();
    assert.equal($('#carelink-country').val(), 'CA');
  });
  it('does not imply fresh data just because the account is connected', async function () {
    Object.assign(state, { configured: true, connected: true, lastReading: Date.now() - 3600000 });
    const plugin = await init();
    assert.equal($('.carelink-badge span').text(), 'Older readings');
    assert.equal($('.carelink-latest').attr('data-stale'), 'true');
    state.lastReading = null; await plugin.refresh();
    assert.equal($('.carelink-badge span').text(), 'Waiting for data');
    assert.equal($('.carelink-latest').text(), 'Not yet');
    state.error = 'provider_unavailable'; await plugin.refresh();
    assert.equal($('.carelink-badge span').text(), 'Needs attention');
  });
  it('shows labelled setup steps and validates the country without starting a login', async function () {
    await init();
    assert.equal($('.carelink-steps li').length, 4);
    assert.ok($('.carelink-steps [aria-current=step]').text().includes('Choose country'));
    $('button').filter((i, b) => b.textContent === 'Connect Medtronic').trigger('click');
    await new Promise(resolve => setImmediate(resolve));
    assert.ok($('.carelink-request-error').text().includes('Choose your CareLink account country'));
    assert.equal(dom.window.document.activeElement, $('#carelink-country')[0]);
    assert.equal(calls.filter(c => c.method === 'POST').length, 0);
  });
  it('keeps error details collapsible while progress has a labelled current step', async function () {
    state.session = { id: 'test', state: 'failed', phase: 'token_exchange', error: 'provider_unavailable',
      diagnostic: { httpStatus: 403, operation: 'token_exchange', reason: 'invalid_json' }, patients: [] };
    await init();
    assert.equal($('.carelink-technical').prop('open'), false);
    assert.equal($('.carelink-technical summary').text(), 'Technical details');
    assert.ok($('.carelink-steps [aria-current=step]').attr('aria-label').includes('needs attention'));
    assert.equal($('.carelink-feedback-icon svg').attr('aria-hidden'), 'true');
    $('button').filter((i, b) => b.textContent === 'Dismiss').trigger('click');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal($('.carelink-panel').css('display'), 'none');
    assert.equal(calls.filter(c => c.method !== 'GET').length, 0);
  });
  it('shows a dismissible success state after account confirmation without implying readings arrived', async function () {
    state.session = { id: 'test', state: 'selecting', patients: [{ username: 'example', label: 'Example' }] };
    const plugin = await init();
    Object.assign(state, { configured: true, connected: true, session: { id: 'test', state: 'connected', patients: [] } });
    await plugin.refresh();
    assert.equal($('.carelink-feedback').attr('data-state'), 'connected');
    assert.ok($('.carelink-feedback').text().includes('Waiting for CareLink readings'));
    assert.equal($('.carelink-feedback-icon').hasClass('carelink-spinner'), false);
    $('button').filter((i, b) => b.textContent === 'Back to connection overview').trigger('click');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal($('.carelink-panel').css('display'), 'none');
    assert.notEqual($('.carelink-overview').css('display'), 'none');
  });
});
