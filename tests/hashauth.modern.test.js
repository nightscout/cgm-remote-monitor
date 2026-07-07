'use strict';

/*
 * hashauth.modern.test.js
 *
 * Track 1, Phase 3.1 — modern jsdom replacement for hashauth.test.js.
 *
 * Differences from the legacy test:
 *   - No benv, no headless harness, no bundle. Boots a hermetic DOM
 *     via tests/fixtures/secure-jsdom and requires lib/client/hashauth
 *     directly with hand-rolled minimal stubs for `client` and `$`.
 *   - Uses jsdom's native window.localStorage instead of the
 *     tests/fixtures/localstorage in-memory shim, so js-storage binds
 *     to a real, spec-compliant Storage implementation.
 *
 * Same 5 behaviors covered as the legacy test:
 *   1. unauthorized state -> inlineCode says "Unauthorized"
 *   2. authorized state   -> inlineCode says "Admin authorized"
 *   3. processSecret(true)  stores sha1 in localStorage
 *   4. processSecret(false) does NOT store sha1
 *   5. short secret triggers window.alert
 */

const should = require('should');
const path = require('path');
const { createSecureDOM } = require('./fixtures/secure-jsdom');

const HASHAUTH_PATH = path.resolve(__dirname, '../lib/client/hashauth');
const JS_STORAGE_PATH = require.resolve('js-storage');

describe('hashauth (modern jsdom)', function () {

  let env, hashauth, client, $stub, alerts;

  beforeEach(function () {
    env = createSecureDOM('<!DOCTYPE html><html><body>'
      + '<div id="authentication_placeholder"></div>'
      + '<div class="needsadminaccess"></div>'
      + '</body></html>');

    // Propagate the few globals lib/client/hashauth + js-storage need.
    // Object.defineProperty for navigator (Node 21+ getter-only).
    Object.defineProperty(global, 'window', {
      configurable: true, writable: true, value: env.window
    });
    Object.defineProperty(global, 'document', {
      configurable: true, writable: true, value: env.document
    });
    Object.defineProperty(global, 'navigator', {
      configurable: true, writable: true, value: env.window.navigator
    });

    // Capture window.alert calls instead of throwing.
    alerts = [];
    env.window.alert = function (msg) { alerts.push(msg); };

    // Force fresh modules so js-storage re-detects the (new) window
    // and hashauth picks up our stubs.
    delete require.cache[require.resolve('js-storage')];
    delete require.cache[require.resolve('../lib/client/hashauth')];

    // Minimal $ stub: only the surface hashauth touches in these tests.
    function $stubFactory (selector) {
      return {
        html: function () { return $stubFactory(selector); },
        hide: function () { return $stubFactory(selector); },
        show: function () { return $stubFactory(selector); },
        val: function () { return ''; },
        is: function () { return false; },
        focus: function () { return $stubFactory(selector); },
        on: function () { return $stubFactory(selector); },
        off: function () { return $stubFactory(selector); },
        trigger: function () { return $stubFactory(selector); },
        dialog: function () { return $stubFactory(selector); }
      };
    }
    $stub = $stubFactory;
    $stub.ajax = function () {
      return { done: function () { return $stub.ajax(); }, fail: function () { return $stub.ajax(); } };
    };

    // Minimal client stub.
    client = {
      headers: function () { return {}; },
      translate: function (s) { return s; },
      browserUtils: { reload: function () {} },
      init: function () {
        // Real client.init() (lib/client/index.js) calls
        // hashauth.initAuthentication() which invokes verifyAuthentication.
        // Reproduce that single side-effect here so per-test mocks fire.
        if (hashauth && typeof hashauth.initAuthentication === 'function') {
          hashauth.initAuthentication(function () {});
        }
      }
    };

    hashauth = require(HASHAUTH_PATH);
  });

  afterEach(function () {
    delete require.cache[require.resolve('js-storage')];
    delete require.cache[require.resolve('../lib/client/hashauth')];
    if (env) env.cleanup();
    delete global.window;
    delete global.document;
    // navigator: leave alone; Node >= 21 owns it.
  });

  it('reports Unauthorized in inlineCode when not authenticated', function () {
    hashauth.init(client, $stub);
    hashauth.verifyAuthentication = function (next) {
      hashauth.authenticated = false;
      next(true);
    };
    client.init();

    hashauth.inlineCode().indexOf('Unauthorized').should.be.greaterThan(-1);
    hashauth.isAuthenticated().should.equal(false);
    should(hashauth.hash()).equal(null);
  });

  it('reports Admin authorized when authenticated', function () {
    hashauth.init(client, $stub);
    hashauth.verifyAuthentication = function (next) {
      hashauth.authenticated = true;
      next(true);
    };
    client.init();

    hashauth.inlineCode().indexOf('Admin authorized').should.be.greaterThan(-1);
    hashauth.isAuthenticated().should.equal(true);
  });

  it('stores sha1 in localStorage when storeapisecret=true, then clears on remove', function (done) {
    env.window.localStorage.removeItem('apisecrethash');

    hashauth.init(client, $stub);
    hashauth.verifyAuthentication = function (next) {
      hashauth.authenticated = true;
      next(true);
    };
    hashauth.updateSocketAuth = function () {};

    client.init();
    hashauth.processSecret('this is my long pass phrase', true, function (success) {
      try {
        success.should.equal(true);
        hashauth.hash().should.equal('b723e97aa97846eb92d5264f084b2823f57c4aa1');
        env.window.localStorage.getItem('apisecrethash')
          .should.equal('b723e97aa97846eb92d5264f084b2823f57c4aa1');
        hashauth.isAuthenticated().should.equal(true);

        hashauth.removeAuthentication();
        hashauth.isAuthenticated().should.equal(false);
        done();
      } catch (err) {
        done(err);
      }
    });
  });

  it('does not store sha1 when storeapisecret=false', function (done) {
    env.window.localStorage.removeItem('apisecrethash');

    hashauth.init(client, $stub);
    hashauth.verifyAuthentication = function (next) {
      hashauth.authenticated = true;
      next(true);
    };

    client.init();
    hashauth.processSecret('this is my long pass phrase', false, function (success) {
      try {
        success.should.equal(true);
        hashauth.hash().should.equal('b723e97aa97846eb92d5264f084b2823f57c4aa1');
        should(env.window.localStorage.getItem('apisecrethash')).equal(null);
        hashauth.isAuthenticated().should.equal(true);
        done();
      } catch (err) {
        done(err);
      }
    });
  });

  it('alerts on short API secret', function () {
    env.window.localStorage.removeItem('apisecrethash');

    hashauth.init(client, $stub);
    client.init();
    hashauth.processSecret('short passp', false);

    alerts.length.should.be.greaterThan(0);
    alerts[0].should.match(/Too short API secret/);
  });

  it('hashes via JS fallback when subtle crypto and TextEncoder are absent', function (done) {
    env.window.localStorage.removeItem('apisecrethash');

    var originalSubtle = env.window.crypto.subtle;
    var originalTextEncoder = global.TextEncoder;
    var originalWindowTextEncoder = env.window.TextEncoder;

    function restore () {
      env.window.crypto.subtle = originalSubtle;
      global.TextEncoder = originalTextEncoder;
      env.window.TextEncoder = originalWindowTextEncoder;
    }

    env.window.crypto.subtle = null;
    global.TextEncoder = undefined;
    env.window.TextEncoder = undefined;

    hashauth.init(client, $stub);
    hashauth.verifyAuthentication = function (next) {
      hashauth.authenticated = true;
      next(true);
    };

    client.init();

    hashauth.processSecret('this is my long pass phrase', false, function (success) {
      try {
        restore();
        success.should.equal(true);
        hashauth.hash().should.equal('b723e97aa97846eb92d5264f084b2823f57c4aa1');
        should(env.window.localStorage.getItem('apisecrethash')).equal(null);
        hashauth.isAuthenticated().should.equal(true);
        done();
      } catch (err) {
        done(err);
      }
    });
  });

});
