'use strict';

const assert = require('assert');
const {createSecureDOM} = require('./fixtures/secure-jsdom');
const domGlobals = require('./fixtures/dom-globals');

function setup (modern) {
  const env = createSecureDOM('<html' + (modern ? ' class="modern-ui"' : '') + '><body><button id="drawerToggle">Settings</button><button id="adminnotifies">Notifications</button><div id="drawer" style="display:none"></div><div id="adminNotifiesDrawer" style="display:none"></div></body></html>');
  const state = domGlobals.installDomGlobals(env);
  env.window.$.fn.tooltip = function () { return this; };
  return {env, state, $: env.window.$};
}

describe('modern side panels', function () {
  [true, false].forEach(modern => {
    it('preserves notification content, escaping and empty/unauthorized states in ' + (modern ? 'modern' : 'classic'), function () {
      const {env, state, $} = setup(modern);
      try {
        $.ajax = () => ({done () { return this; }, fail () { return this; }});
        let closed = 0;
        const client = {
          settings: {theme: modern ? 'modern' : 'colors'}, headers: () => ({}),
          translate: (text, ...values) => text.replace(/%([1-9])/g, (_, index) => values[Number(index) - 1]),
          browserUtils: {closeLastOpenedDrawer: () => { closed++; }}
        };
        const panel = require('../lib/client/adminnotifiesclient')(client, $);
        panel.notifies = [{title: '<img src=x>', message: '<script>alert(1)</script>', count: 3, lastRecorded: Date.now() - 7 * 60000}];
        panel.notifyCount = 1;
        panel.prepare();
        assert.ok(panel.drawer.text().includes('<img src=x>'));
        assert.ok(panel.drawer.text().includes('<script>alert(1)</script>'));
        assert.strictEqual(panel.drawer.find('img, script').length, 0);
        assert.ok(panel.drawer.text().includes('Event repeated 3 times.'));
        assert.ok(panel.drawer.text().includes('Last recorded 7 minutes ago.'));
        assert.strictEqual(panel.drawer.find('.modern-admin-message').length, modern ? 1 : 0);
        panel.notifies = [];
        panel.prepare();
        assert.ok(panel.drawer.text().includes('Please sign in using the API_SECRET'));
        panel.notifyCount = 0;
        panel.prepare();
        assert.ok(panel.drawer.text().includes('There are no admin messages in queue'));
        assert.strictEqual(panel.drawer.find('.modern-drawer-header').length, modern ? 1 : 0);
        if (modern) {
          panel.drawer.find('.modern-drawer-close').trigger('click');
          assert.strictEqual(closed, 1);
          assert.strictEqual(env.document.activeElement.id, 'adminnotifies');
        }
      } finally { domGlobals.restoreDomGlobals(state); }
    });
  });

  it('cancels interrupted slides, keeps reopened panels visible and hides only after closing finishes', function () {
    const {state, $} = setup(true);
    try {
      const animations = [];
      $('#drawer')[0].animate = (frames, options) => {
        const animation = {frames, options, cancel () { this.cancelled = true; }};
        animations.push(animation);
        return animation;
      };
      const utils = require('../lib/client/browser-utils')($);
      utils.toggleDrawer('#drawer');
      assert.strictEqual($('#drawer').css('display'), 'block');
      assert.strictEqual(animations.length, 1);
      utils.closeLastOpenedDrawer();
      assert.strictEqual(animations[0].cancelled, true);
      assert.strictEqual(animations[0].onfinish, null);
      assert.strictEqual($('#drawer').css('display'), 'block');
      utils.toggleDrawer('#drawer');
      assert.strictEqual(animations[1].cancelled, true);
      animations[2].onfinish();
      assert.strictEqual($('#drawer').css('display'), 'block');
      utils.closeLastOpenedDrawer();
      animations[3].onfinish();
      assert.strictEqual($('#drawer').css('display'), 'none');
      assert.strictEqual(utils.getLastOpenedDrawer(), null);
    } finally { domGlobals.restoreDomGlobals(state); }
  });

  [false, true].forEach(reduced => {
    it('uses immediate controls for ' + (reduced ? 'reduced motion' : 'classic themes'), function () {
      const {env, state, $} = setup(reduced);
      try {
        env.window.matchMedia = () => ({matches: reduced});
        $('#drawer')[0].animate = () => { throw new Error('Animation should be skipped'); };
        const utils = require('../lib/client/browser-utils')($);
        utils.toggleDrawer('#drawer');
        assert.strictEqual($('#drawer').css('display'), 'block');
        utils.closeLastOpenedDrawer();
        assert.strictEqual($('#drawer').css('display'), 'none');
      } finally { domGlobals.restoreDomGlobals(state); }
    });
  });
});
