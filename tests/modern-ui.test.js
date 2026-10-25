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

  it('shows existing toolbar tooltips below their buttons and inside both viewport edges', function () {
    const env = createSecureDOM('<div id="buttonbar"><a class="tip" title="Left label"></a><a class="tip" title="Middle label"></a><a class="tip" title="Right label"></a></div><span class="tip" id="other-tip" title="Other label"></span>');
    const state = domGlobals.installDomGlobals(env);
    const pluginPath = require.resolve('jquery.tooltips/js/jquery.tooltips');
    delete require.cache[pluginPath];
    try {
      const $ = env.window.$;
      Object.defineProperty(env.document.documentElement, 'clientWidth', {value: 320});
      const links = $('#buttonbar .tip');
      links.each(function (index) {
        const left = [14, 220, 262][index];
        this.getBoundingClientRect = () => ({left, top: 2, width: 44, height: 44});
        this.getClientRects = () => [this.getBoundingClientRect()];
        Object.defineProperty(this, 'offsetWidth', {value: 44});
        Object.defineProperty(this, 'offsetHeight', {value: 44});
      });
      require(pluginPath);
      $('.tip').tooltip();
      const otherOptions = $('#other-tip').data('tooltip').options;
      const widths = [160, 220, 120];
      const original = links.map(function () { return $(this).data('tooltip'); }).get();
      original.forEach((tooltip, index) => {
        Object.defineProperty(tooltip.tip()[0], 'offsetWidth', {value: widths[index]});
        Object.defineProperty(tooltip.tip()[0], 'offsetHeight', {value: 24});
        tooltip.tip().css('width', widths[index] + 'px');
      });
      require('../lib/client/modern-layout')({}, $, () => {});
      assert.strictEqual($('#other-tip').data('tooltip').options, otherOptions);
      assert.strictEqual(otherOptions.gravity, 's');
      links.each(function (index) {
        assert.strictEqual($(this).data('tooltip'), original[index]);
        $(this).trigger('mouseenter');
        const tip = original[index].tip();
        assert.strictEqual(parseFloat(tip.css('top')), 52);
        assert.ok(parseFloat(tip.css('left')) >= 8);
        assert.ok(parseFloat(tip.css('left')) + widths[index] <= 312);
        assert.strictEqual(tip.find('.tooltip-inner').text(), ['Left label', 'Middle label', 'Right label'][index]);
        $(this).trigger('mouseleave');
        assert.strictEqual(env.document.querySelectorAll('body > .tooltip').length, 0);
      });
    } finally {
      delete require.cache[pluginPath];
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
