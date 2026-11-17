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

// Cut 3 replaced the jquery.tooltips plugin with one delegated native help
// tooltip (lib/client/help-tooltips.js). EXPECTATION CHANGED with that switch:
// this test used to read the plugin's per-link state ($(link).data('tooltip'),
// its options.offset and its mouseover handlers). It now asks the same
// questions of the native tooltip: after the theme replaces the dashboard, a
// toolbar link shows its own title on hover (desktop) and nothing on hover
// (touch), a second initTooltips() installs nothing new, and drawer help still
// opens on a tap on touch screens. Real-layout placement is covered by
// tests/browser/help-tooltips*.test.js.
describe('toolbar tooltips after theme selection', function () {
  ['modern', 'colors'].forEach(serverTheme => {
    [false, true].forEach(touch => {
      it('initializes the replacement ' + serverTheme + ' toolbar with touch=' + touch, async function () {
        const output = await ejs.renderFile(path.join(__dirname, '../views/index.html'), {
          settings: {theme: serverTheme}, locals: {bundle: '/bundle', cachebuster: 'test'}, type: 'index', title: ''
        });
        const env = createSecureDOM(output, {resources: new NoResources()});
        const state = domGlobals.installDomGlobals(env);
        let installed;
        try {
          const $ = env.window.$;
          const doc = env.document;
          doc.createEvent = () => {
            if (!touch) throw new Error('Desktop has no TouchEvent');
            return {};
          };
          const utils = require('../lib/client/browser-utils')($);
          const theme = serverTheme === 'modern' ? 'colors' : 'modern';
          require('../lib/client/dashboard-theme')(doc, theme);
          installed = utils.initTooltips();
          if (theme === 'modern') {
            require('../lib/client/modern-layout')({translate: value => value, browserUtils: utils}, $, () => {});
          }
          assert.strictEqual(utils.initTooltips(), installed, 'a second initTooltips() installs nothing new');
          assert.strictEqual(doc.querySelectorAll('.ns-help-tooltip').length, 1);
          const tip = doc.getElementById('ns-help-tooltip');
          const links = doc.querySelectorAll('#buttonbar .tip');
          assert.ok(links.length > 0);
          links.forEach(link => {
            const title = link.getAttribute('original-title') || link.getAttribute('title');
            assert.ok(title, 'toolbar link has a title');
            link.dispatchEvent(new env.window.Event('pointerover', {bubbles: true}));
            if (touch) {
              assert.strictEqual(tip.hidden, true, 'no toolbar hover tooltip on touch screens');
              return;
            }
            assert.strictEqual(tip.hidden, false);
            assert.strictEqual(tip.textContent, title);
            link.dispatchEvent(new env.window.Event('pointerout', {bubbles: true}));
            assert.strictEqual(tip.hidden, true);
          });
          const help = doc.querySelector('#drawer a.tip:not([href])');
          assert.ok(help, 'the drawer has help links');
          help.dispatchEvent(new env.window.MouseEvent('click', {bubbles: true, cancelable: true}));
          if (touch) {
            assert.strictEqual(tip.hidden, false, 'drawer help remains available on touch screens');
            assert.strictEqual(tip.textContent, help.getAttribute('original-title'));
          }
        } finally {
          if (installed) installed.destroy();
          domGlobals.restoreDomGlobals(state);
          env.cleanup();
        }
      });
    });
  });
});
