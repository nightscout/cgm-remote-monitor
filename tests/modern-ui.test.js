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
      ['container', 'chartContainer', 'currentTime', 'silenceBtn', 'viewMenu', 'drawer', 'treatmentDrawer', 'drawerToggle'].forEach(id => {
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
      const storage = require('js-storage').localStorage;
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
