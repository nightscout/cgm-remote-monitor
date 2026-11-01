'use strict';

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const makeSettings = require('../lib/settings');
const {ResourceLoader} = require('jsdom');
const {createSecureDOM} = require('./fixtures/secure-jsdom');
const domGlobals = require('./fixtures/dom-globals');

class NoResources extends ResourceLoader {
  fetch () { return null; }
}

describe('opt-in modern dashboard', function () {
  it('adds one settings header while preserving settings values and Save handlers', function () {
    const env = createSecureDOM('<button id="drawerToggle">Settings</button><div id="drawer"><form id="settings-form"><input id="customTitle" value="Original title"><div class="actions"><button id="save">Save</button></div><div class="authentication-status">Existing status</div></form></div>');
    const state = domGlobals.installDomGlobals(env);
    try {
      const $ = env.window.$;
      let saved = 0;
      let closed = 0;
      $('#save').on('click', event => { event.preventDefault(); saved++; });
      const client = {translate: value => value, browserUtils: {closeLastOpenedDrawer: () => { closed++; }}};
      const originalSave = $('#save')[0];
      const layout = require('../lib/client/modern-layout');
      layout(client, $, () => {});
      layout(client, $, () => {});
      assert.strictEqual($('.modern-drawer-header').length, 1);
      assert.strictEqual($('#customTitle').val(), 'Original title');
      assert.strictEqual($('#save')[0], originalSave);
      assert.strictEqual($('#settings-form').children().last().attr('class'), 'actions');
      $('#save').trigger('click');
      assert.strictEqual(saved, 1);
      $('.modern-drawer-close').trigger('click');
      assert.strictEqual(closed, 1);
      assert.strictEqual(env.document.activeElement.id, 'drawerToggle');
    } finally {
      domGlobals.restoreDomGlobals(state);
      env.cleanup();
    }
  });

  it('keeps Care Portal Close separate from Submit and retains unsaved fields', function () {
    const env = createSecureDOM('<button id="treatmentDrawerToggle">Care Portal</button><div id="treatmentDrawer"><form id="treatment-form"><fieldset><input id="carbsGiven" value="15"><textarea id="notes">Unsent note</textarea><button id="treatment-submit" type="button">Submit Form</button></fieldset></form></div>');
    const state = domGlobals.installDomGlobals(env);
    try {
      const $ = env.window.$;
      let saved = 0;
      let closed = 0;
      const submit = $('#treatment-submit')[0];
      $('#treatment-submit').on('click', () => { saved++; });
      const client = {translate: value => value, browserUtils: {closeLastOpenedDrawer: () => { closed++; }}};
      const layout = require('../lib/client/modern-layout');
      layout(client, $, () => {});
      layout(client, $, () => {});
      assert.strictEqual($('#treatmentDrawer .modern-drawer-header').length, 1);
      assert.strictEqual($('.modern-treatment-actions').length, 1);
      $('#treatmentDrawer .modern-drawer-close').trigger('click');
      assert.strictEqual(saved, 0);
      assert.strictEqual(closed, 1);
      assert.strictEqual(env.document.activeElement.id, 'treatmentDrawerToggle');
      assert.strictEqual($('#carbsGiven').val(), '15');
      assert.strictEqual($('#notes').val(), 'Unsent note');
      assert.strictEqual($('#treatment-submit')[0], submit);
      $('#treatment-submit').trigger('click');
      assert.strictEqual(saved, 1);
    } finally {
      domGlobals.restoreDomGlobals(state);
      env.cleanup();
    }
  });

  it('does not observe a missing chart when a modern editor loads', function () {
    const env = createSecureDOM('<main class="editor-content"></main>');
    const state = domGlobals.installDomGlobals(env);
    try {
      let observed = 0;
      env.window.ResizeObserver = class { observe (node) { assert.ok(node); observed++; } };
      require('../lib/client/modern-layout')({}, env.window.$, () => {});
      assert.strictEqual(observed, 0);
    } finally { domGlobals.restoreDomGlobals(state); env.cleanup(); }
  });

  ['profile', 'food', 'admin', 'report'].forEach(type => {
    ['modern', 'colors'].forEach(serverTheme => {
      it('renders one working ' + type + ' editor shell and honours a browser override from ' + serverTheme, async function () {
        const output = await ejs.renderFile(path.join(__dirname, '../views/' + type + 'index.html'), {
          settings: settingsFor(serverTheme), locals: {bundle: '/bundle', cachebuster: 'test'}, type, title: type
        });
        const env = createSecureDOM(output, {resources: new NoResources()});
        try {
          const document = env.document;
          const root = document.querySelector('main.editor-content');
          const formId = {profile: 'pe_form', food: 'fe_form', admin: 'admin_placeholder', report: 'report-filters'}[type];
          assert.strictEqual(document.querySelectorAll('#' + formId).length, 1);
          assert.ok(root.contains(document.getElementById(formId)));
          assert.strictEqual(document.documentElement.classList.contains('modern-ui'), serverTheme === 'modern');
          assert.ok(document.querySelector('script[src="/bundle/js/bundle.app.js?v=test"]'));
          assert.ok(document.querySelector('link[href="/css/modern-editors.css?v=test"]'));
          if (type === 'profile' || type === 'food') {
            const status = document.querySelector('#buttonbar.editor-status');
            assert.ok(status);
            assert.ok(status.compareDocumentPosition(document.querySelector('.editor-navigation')) & env.window.Node.DOCUMENT_POSITION_FOLLOWING);
            assert.strictEqual(status.getAttribute('role'), 'status');
          }
          assert.strictEqual(document.querySelectorAll('.editor-navigation').length, 1);
          assert.ok(document.querySelector('#toolbar').contains(document.querySelector('.editor-navigation')));
          assert.strictEqual(document.querySelector('.editor-navigation [aria-current="page"]').getAttribute('href'), '/' + type);
          const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
          assert.strictEqual(new Set(ids).size, ids.length);
          const effective = serverTheme === 'modern' ? 'colors' : 'modern';
          require('../lib/client/dashboard-theme')(document, effective);
          assert.strictEqual(document.documentElement.classList.contains('modern-ui'), effective === 'modern');
          assert.strictEqual(document.getElementById(formId), root.querySelector('#' + formId));
        } finally { env.cleanup(); }
      });
    });
  });

  ['modern', 'colors'].forEach(theme => {
    it('preserves authentication submission, retry focus and remember-device opt-in with ' + theme, function () {
      const env = createSecureDOM('<div id="authentication_placeholder"></div>');
      const state = domGlobals.installDomGlobals(env);
      const authPath = require.resolve('../lib/client/hashauth');
      delete require.cache[authPath];
      try {
        const $ = env.window.$;
        $.ui = {keyCode: {ENTER: 13}};
        let options;
        let closed = false;
        $.fn.dialog = function (value) {
          if (value === 'close') { closed = true; return this; }
          options = value;
          this.show().append($('<button id="requestauthenticationdialog-btn"></button>')
            .on('click', () => options.buttons[0].click.call(this[0])));
          options.open();
          return this;
        };
        let authenticated = false;
        const auth = require(authPath).init({
          settings: {theme}, translate: value => value,
          afterAuth: value => { authenticated = value; }
        }, $);
        auth.requestAuthentication();
        assert.strictEqual(options.height, theme === 'modern' ? 'auto' : 270);
        assert.strictEqual(options.dialogClass, theme === 'modern' ? 'modern-auth-dialog' : '');
        assert.strictEqual(options.closeText, theme === 'modern' ? 'Close' : '');
        assert.strictEqual($('#apisecret').attr('type'), 'password');
        assert.strictEqual($('#storeapisecret').is(':checked'), false);
        assert.strictEqual(env.document.activeElement.id, 'apisecret');
        auth.processSecret = (secret, remember, done) => {
          assert.strictEqual(secret, 'synthetic-rejected-value');
          assert.strictEqual(remember, false);
          done(false);
        };
        $('#apisecret').val('synthetic-rejected-value');
        $('#requestauthenticationdialog-btn').trigger('click');
        assert.strictEqual($('#apisecret').val(), '');
        assert.strictEqual(env.document.activeElement.id, 'apisecret');
        assert.strictEqual(closed, false);
        auth.processSecret = (secret, remember, done) => {
          assert.strictEqual(secret, 'synthetic-accepted-value');
          assert.strictEqual(remember, true);
          done(true);
        };
        $('#storeapisecret').prop('checked', true);
        $('#apisecret').val('synthetic-accepted-value').trigger($.Event('keyup', {keyCode: 13}));
        assert.strictEqual(authenticated, true);
        assert.strictEqual(closed, true);
      } finally {
        delete require.cache[authPath];
        domGlobals.restoreDomGlobals(state);
      }
    });
  });

  // EXPECTATION CHANGED with cut 3's native help tooltip
  // (lib/client/help-tooltips.js), which replaced the jquery.tooltips plugin
  // that modern-layout used to re-aim per link. The question is the same: a
  // toolbar tooltip opens 6px below its button and stays 8px inside both
  // viewport edges, and leaving the button closes it.
  it('shows existing toolbar tooltips below their buttons and inside both viewport edges', function () {
    const env = createSecureDOM('<div id="buttonbar"><a class="tip" title="Left label"></a><a class="tip" title="Middle label"></a><a class="tip" title="Right label"></a></div><span class="tip" id="other-tip" title="Other label"></span>');
    const state = domGlobals.installDomGlobals(env);
    let installed;
    try {
      const $ = env.window.$;
      const doc = env.document;
      Object.defineProperty(env.window, 'innerWidth', {configurable: true, value: 320});
      Object.defineProperty(env.window, 'innerHeight', {configurable: true, value: 640});
      const links = doc.querySelectorAll('#buttonbar .tip');
      links.forEach((link, index) => {
        const left = [14, 220, 262][index];
        link.getBoundingClientRect = () => ({left, top: 2, width: 44, height: 44, right: left + 44, bottom: 46});
      });
      installed = require('../lib/client/help-tooltips')(doc, {touch: false});
      require('../lib/client/modern-layout')({}, $, () => {});
      const tip = doc.getElementById('ns-help-tooltip');
      const widths = {'Left label': 160, 'Middle label': 220, 'Right label': 120};
      tip.getBoundingClientRect = () => ({left: 0, top: 0, width: widths[tip.textContent], height: 24});
      links.forEach((link, index) => {
        link.dispatchEvent(new env.window.Event('pointerover', {bubbles: true}));
        const text = ['Left label', 'Middle label', 'Right label'][index];
        assert.strictEqual(tip.hidden, false);
        assert.strictEqual(tip.textContent, text);
        assert.strictEqual(parseFloat(tip.style.top), 52);
        assert.ok(parseFloat(tip.style.left) >= 8);
        assert.ok(parseFloat(tip.style.left) + widths[text] <= 312);
        link.dispatchEvent(new env.window.Event('pointerout', {bubbles: true}));
        assert.strictEqual(tip.hidden, true);
      });
      assert.strictEqual(doc.querySelectorAll('.ns-help-tooltip').length, 1);
    } finally {
      if (installed) installed.destroy();
      domGlobals.restoreDomGlobals(state);
    }
  });

  function settingsFor (value) {
    const settings = makeSettings();
    settings.eachSettingAsEnv(name => name === 'THEME' ? value : undefined);
    return settings;
  }

  it('keeps the default theme and layout unchanged', function () {
    assert.strictEqual(settingsFor(undefined).theme, 'default');
  });

  it('accepts THEME=modern without changing thresholds or alarm settings', function () {
    const settings = settingsFor('modern');
    assert.strictEqual(settings.theme, 'modern');
    assert.strictEqual(settings.thresholds.bgTargetTop, 180);
    assert.strictEqual(settings.alarmUrgentLow, true);
    assert.ok(!Object.hasOwn(settings, 'uiStyle'));
  });

  ['default', 'modern'].forEach(style => {
    it('renders the ' + style + ' main screen with one copy of every existing control', async function () {
      const output = await ejs.renderFile(path.join(__dirname, '../views/index.html'), {
        settings: settingsFor(style), locals: {bundle: '/bundle', cachebuster: 'test'}, type: 'index', title: ''
      });
      const env = createSecureDOM(output, {resources: new NoResources()});
      const document = env.document;
      ['container', 'chartContainer', 'currentTime', 'silenceBtn', 'viewMenu', 'drawer', 'treatmentDrawer', 'treatment-submit', 'drawerToggle'].forEach(id => {
        assert.strictEqual(document.querySelectorAll('#' + id).length, 1, id);
      });
      ['.statusPills', '.majorPills', '.minorPills', '.currentBG', '.focus-range'].forEach(selector => {
        assert.strictEqual(document.querySelectorAll(selector).length, 1, selector);
      });
      assert.strictEqual(document.documentElement.classList.contains('modern-ui'), style === 'modern');
      if (style === 'modern') {
        assert.ok(!document.querySelector('meta[name="viewport"]').content.includes('user-scalable=0'));
      }
      env.cleanup();
    });
  });

  it('honours the existing saved browser theme preference', function () {
    const env = createSecureDOM('<!doctype html><html><body></body></html>');
    const state = domGlobals.installDomGlobals(env);
    domGlobals.defineConfigurable(global, 'location', env.window.location);
    try {
      const storage = require('../lib/client/storage').localStorage;
      const browserSettings = require('../lib/client/browser-settings');
      const client = { browserUtils: {}, translate: value => value };
      ['modern', 'colors'].forEach(style => {
        storage.set('theme', style);
        const settings = browserSettings(client, {settings: {theme: style === 'modern' ? 'colors' : 'modern', enable: 'ar2'}, extendedSettings: {}}, env.window.$);
        assert.strictEqual(settings.theme, style);
      });
    } finally {
      delete global.location;
      domGlobals.restoreDomGlobals(state);
    }
  });

  it('keeps drawer and notification controls working after the dashboard is replaced', function () {
    const env = createSecureDOM('<button id="drawerToggle">Settings</button><div id="notification"><span></span></div><div id="drawer"></div>');
    const state = domGlobals.installDomGlobals(env);
    try {
      const $ = env.window.$;
      $.fn.tooltip = function () { return this; };
      const utils = require('../lib/client/browser-utils')($);
      $('#drawerToggle').replaceWith('<button id="drawerToggle">Settings</button>');
      $('#notification').replaceWith('<div id="notification"><span></span></div>');
      $('#drawerToggle').trigger('click');
      assert.strictEqual(utils.getLastOpenedDrawer(), '#drawer');
      utils.showNotification('synthetic notification');
      $('#notification').trigger('click');
      assert.strictEqual($('#notification')[0].style.display, 'none');
    } finally {
      domGlobals.restoreDomGlobals(state);
      env.cleanup();
    }
  });

  ['modern', 'colors'].forEach(serverTheme => {
    it('selects the matching layout before binding client events when ' + serverTheme + ' is overridden', async function () {
      const output = await ejs.renderFile(path.join(__dirname, '../views/index.html'), {
        settings: settingsFor(serverTheme), locals: {bundle: '/bundle', cachebuster: 'test'}, type: 'index', title: ''
      });
      const env = createSecureDOM(output, {resources: new NoResources()});
      const effective = serverTheme === 'modern' ? 'colors' : 'modern';
      const apply = require('../lib/client/dashboard-theme');
      apply(env.document, effective);
      apply(env.document, effective);
      assert.strictEqual(env.document.documentElement.classList.contains('modern-ui'), effective === 'modern');
      assert.strictEqual(!!env.document.querySelector('.modern-dashboard'), effective === 'modern');
      ['container', 'currentTime', 'chartContainer', 'silenceBtn', 'viewMenu', 'drawerToggle'].forEach(id => {
        assert.strictEqual(env.document.querySelectorAll('#' + id).length, 1, id);
      });
      env.cleanup();
    });
  });
});
