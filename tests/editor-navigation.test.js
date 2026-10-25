'use strict';

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const {ResourceLoader} = require('jsdom');
const {createSecureDOM} = require('./fixtures/secure-jsdom');
const domGlobals = require('./fixtures/dom-globals');
const preserveToken = require('../lib/client/editor-navigation');

class NoResources extends ResourceLoader {
  fetch () { return null; }
}

describe('editor navigation authorization', function () {
  ['profile', 'food', 'admin', 'report'].forEach(type => {
    ['modern', 'colors'].forEach(theme => {
      it('retains only the URL token across ' + type + ' tool links in ' + theme, async function () {
        const token = 'viewer_name-a+b/c= &%';
        const output = await ejs.renderFile(path.join(__dirname, '../views/' + type + 'index.html'), {
          settings: {theme}, locals: {bundle: '/bundle', cachebuster: 'test'}, type, title: ''
        });
        const env = createSecureDOM(output, {
          resources: new NoResources(),
          url: 'https://nightscout.test/' + type + '?token=' + encodeURIComponent(token) + '&secret=unrelated&debug=true'
        });
        try {
          preserveToken(env.document, env.window.location);
          preserveToken(env.document, env.window.location);
          const links = [...env.document.querySelectorAll('.editor-navigation a')];
          assert.strictEqual(links.length, 4);
          links.forEach(link => {
            const destination = new URL(link.href);
            assert.strictEqual(destination.searchParams.get('token'), token);
            assert.deepStrictEqual([...destination.searchParams.keys()], ['token']);
            assert.strictEqual(destination.origin, 'https://nightscout.test');
          });
          // A second tool page must carry the credential on to a third page.
          const nextPage = new URL(links[0].href);
          preserveToken(env.document, nextPage);
          assert.strictEqual(new URL(links[3].href).searchParams.get('token'), token);
        } finally { env.cleanup(); }
      });
    });
  });

  ['', '?debug=true', '?token='].forEach(search => {
    it('leaves tool URLs unchanged without a nonempty token: ' + search, function () {
      const env = createSecureDOM('<nav class="editor-navigation"><a href="/food">Food</a></nav>', {
        url: 'https://nightscout.test/report' + search
      });
      try {
        preserveToken(env.document, env.window.location);
        assert.strictEqual(env.document.querySelector('a').getAttribute('href'), '/food');
      } finally { env.cleanup(); }
    });
  });
});

describe('toolbar tooltips after theme selection', function () {
  ['modern', 'colors'].forEach(serverTheme => {
    [false, true].forEach(touch => {
      it('initializes the replacement ' + serverTheme + ' toolbar with touch=' + touch, async function () {
        const output = await ejs.renderFile(path.join(__dirname, '../views/index.html'), {
          settings: {theme: serverTheme}, locals: {bundle: '/bundle', cachebuster: 'test'}, type: 'index', title: ''
        });
        const env = createSecureDOM(output, {resources: new NoResources()});
        const state = domGlobals.installDomGlobals(env);
        const pluginPath = require.resolve('jquery.tooltips/js/jquery.tooltips');
        delete require.cache[pluginPath];
        try {
          const $ = env.window.$;
          env.document.createEvent = () => {
            if (!touch) throw new Error('Desktop has no TouchEvent');
            return {};
          };
          require(pluginPath);
          const utils = require('../lib/client/browser-utils')($);
          const theme = serverTheme === 'modern' ? 'colors' : 'modern';
          require('../lib/client/dashboard-theme')(env.document, theme);
          utils.initTooltips();
          if (theme === 'modern') {
            require('../lib/client/modern-layout')({translate: value => value, browserUtils: utils}, $, () => {});
          }
          const links = $('#buttonbar .tip');
          assert.ok(links.length > 0);
          links.each(function () {
            const tooltip = $(this).data('tooltip');
            assert.strictEqual(!!tooltip, !touch);
            if (touch) return;
            const handlers = $._data(this, 'events').mouseover.length;
            utils.initTooltips();
            assert.strictEqual($(this).data('tooltip'), tooltip);
            assert.strictEqual($._data(this, 'events').mouseover.length, handlers);
            assert.strictEqual(tooltip.getTitle(), $(this).attr('original-title'));
            tooltip.options.fade = false;
            $(this).trigger('mouseenter');
            assert.strictEqual(tooltip.tip().find('.tooltip-inner').text(), tooltip.getTitle());
            assert.strictEqual(tooltip.options.offset, theme === 'modern' ? 6 : 0);
            $(this).trigger('mouseleave');
          });
          $('#drawer .tip').each(function () {
            assert.ok($(this).data('tooltip'), 'drawer help remains available on touch screens');
          });
        } finally {
          delete require.cache[pluginPath];
          domGlobals.restoreDomGlobals(state);
          env.cleanup();
        }
      });
    });
  });
});
