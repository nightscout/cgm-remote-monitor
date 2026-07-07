'use strict';

/*
 * secure-jsdom.js
 *
 * Modern (jsdom >= 24) replacement for the benv-driven harness.
 * Provides a hermetic DOM:
 *   - blocks ALL network resource loads via NoNetworkLoader
 *   - replaces window.fetch with a thrower
 *   - replaces window.XMLHttpRequest.send with a thrower
 *
 * Tests that need to simulate AJAX must inject mocks explicitly
 * (e.g. window.$.ajax = sinon.stub()) AFTER calling createSecureDOM.
 *
 * See docs/proposals/testing-modernization-proposal.md
 * § Track 1 / Network Isolation.
 */

const { JSDOM, ResourceLoader } = require('jsdom');

class NoNetworkLoader extends ResourceLoader {
  fetch (url /*, options */) {
    return Promise.reject(new Error(
      'secure-jsdom: network access blocked (' + url + ')'
    ));
  }
}

function disableNetworkAPIs (window) {
  const blocked = function blockedNetwork (kind) {
    return function () {
      throw new Error('secure-jsdom: ' + kind + ' is disabled in tests');
    };
  };

  // fetch
  Object.defineProperty(window, 'fetch', {
    configurable: true,
    writable: true,
    value: blocked('fetch')
  });

  // XMLHttpRequest: keep the constructor (some libs feature-detect it),
  // but make .send() throw. This surfaces unmocked AJAX immediately.
  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR && OriginalXHR.prototype) {
    OriginalXHR.prototype.send = blocked('XMLHttpRequest.send');
    OriginalXHR.prototype.open = function noopOpen () { /* swallowed */ };
  }
}

/**
 * Create a hermetic JSDOM window for a test.
 *
 * @param {string} [html] Initial HTML document. Defaults to an empty body.
 * @param {object} [options] Forwarded to JSDOM constructor (url, runScripts, ...).
 *                           Caller-supplied `resources` is honored; otherwise we
 *                           install NoNetworkLoader.
 * @returns {{ dom: JSDOM, window: Window, document: Document, cleanup: function }}
 */
function createSecureDOM (html, options) {
  const opts = Object.assign({
    url: 'http://localhost/',
    pretendToBeVisual: true,
    resources: new NoNetworkLoader()
  }, options || {});

  const dom = new JSDOM(html || '<!DOCTYPE html><html><body></body></html>', opts);
  disableNetworkAPIs(dom.window);

  function cleanup () {
    try { dom.window.close(); } catch (e) { /* idempotent */ }
  }

  return {
    dom: dom,
    window: dom.window,
    document: dom.window.document,
    cleanup: cleanup
  };
}

module.exports = {
  createSecureDOM: createSecureDOM,
  NoNetworkLoader: NoNetworkLoader,
  disableNetworkAPIs: disableNetworkAPIs
};
