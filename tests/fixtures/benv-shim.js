'use strict';

/*
 * benv-shim.js
 *
 * Drop-in replacement for the four `benv` API surfaces actually used
 * across this repo's test suite:
 *   benv.setup(callback)
 *   benv.expose(globals)
 *   benv.require(absolutePath)
 *   benv.teardown(clearDOM?)
 *
 * Implementation rests on `tests/fixtures/secure-jsdom.js` so we get
 * modern jsdom AND no-network resource isolation for free.
 *
 * Activation:
 *   `tests/fixtures/benv-loader.js` unconditionally exports this shim.
 *   The legacy `benv` package was removed after the Phase 1 parity work.
 *
 * Notes:
 *   - Browser modules are reloaded through Node's CommonJS loader after
 *     wiring the active jsdom window onto the Node global object.
 *   - All existing call sites pass absolute paths via `__dirname + '...'`,
 *     so we drop benv's deprecated `module.parent.filename` resolution magic.
 */

const fs = require('fs');
const path = require('path');
const { createSecureDOM } = require('./secure-jsdom');

// Globals we mirror onto the Node `global` object so legacy code can
// reference `window`, `document`, etc. without an import.
const DOM_GLOBALS = [
  'navigator',
  'document',
  'location',
  'getComputedStyle',
  'btoa',
  'atob',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'CustomEvent'
];

let activeEnv = null;        // { dom, window, cleanup } from createSecureDOM
let exposedKeys = new Set(); // tracked for teardown
const originalGlobals = new Map();

function setGlobal (name, value) {
  if (!originalGlobals.has(name)) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(global, name));
  }
  // Node >= 21 makes some globals (notably `navigator`) getter-only on the
  // global object. Use defineProperty with configurable:true so we can both
  // override now and restore the original descriptor during teardown.
  try {
    Object.defineProperty(global, name, {
      configurable: true,
      writable: true,
      enumerable: true,
      value: value
    });
  } catch (e) {
    global[name] = value;
  }
}

function restoreGlobal (name) {
  if (!originalGlobals.has(name)) return;
  const descriptor = originalGlobals.get(name);
  if (descriptor) Object.defineProperty(global, name, descriptor);
  else delete global[name];
  originalGlobals.delete(name);
}

function setup (callback, options) {
  // Each setup owns a fresh window so callers cannot inherit DOM or global
  // state left behind by another browser-oriented suite.
  if (activeEnv) {
    activeEnv.cleanup();
    activeEnv = null;
  }

  const html = (options && options.html) || '<!DOCTYPE html><html><body></body></html>';
  activeEnv = createSecureDOM(html, options);

  setGlobal('window', activeEnv.window);
  DOM_GLOBALS.forEach(function (name) {
    setGlobal(name, activeEnv.window[name] || function noop () {});
  });

  if (callback) callback();
}

function setOnWindow (win, name, value) {
  // Modern jsdom mirrors browser semantics for some properties
  // (notably `localStorage`, `sessionStorage`) — they're getter-only on
  // Window. Direct assignment throws TypeError. defineProperty replaces
  // the descriptor wholesale, which is exactly the override semantics
  // tests expect from benv.
  try {
    Object.defineProperty(win, name, {
      configurable: true,
      writable: true,
      enumerable: true,
      value: value
    });
  } catch (e) {
    win[name] = value;
  }
}

function expose (globals) {
  if (!activeEnv) {
    throw new Error('benv-shim: expose() called before setup()');
  }
  Object.keys(globals).forEach(function (key) {
    setOnWindow(activeEnv.window, key, globals[key]);
    setGlobal(key, globals[key]);
    exposedKeys.add(key);
  });
}


function shimRequire (filename /*, globalVarName */) {
  if (!path.isAbsolute(filename)) {
    // Real benv resolved relative to module.parent.filename. Modern Node
    // deprecated module.parent and the entire test suite already passes
    // absolute paths, so refuse relative paths to surface mistakes loudly.
    throw new Error('benv-shim.require requires an absolute path: ' + filename);
  }
  if (!fs.existsSync(filename)) {
    throw new Error('benv-shim.require: file not found: ' + filename);
  }
  // Bust Node's CommonJS cache so each setup() can re-evaluate browser
  // modules against the (potentially fresh) jsdom window.
  delete require.cache[filename];
  // The bundle can assign these globals before setGlobal sees them.
  ['$', 'jQuery'].forEach(function (key) {
    if (!originalGlobals.has(key)) originalGlobals.set(key, Object.getOwnPropertyDescriptor(global, key));
  });
  const result = require(filename);

  // Webpack UMD bundles attach `$`, `jQuery`, etc. to `window` at module
  // load. The previous benv (and its `rewire` execution wrapper) used to
  // also surface those onto the Node `global` object as a side effect.
  // headless.js relies on that — `self.$ = $` immediately after a bundle
  // require — so mirror the common UI globals here. Idempotent.
  if (activeEnv && activeEnv.window) {
    ['$', 'jQuery'].forEach(function (key) {
      if (typeof activeEnv.window[key] !== 'undefined') {
        setGlobal(key, activeEnv.window[key]);
        exposedKeys.add(key);
      }
    });
  }

  // The webpack bundle also writes some identifiers (`$`, `jQuery`) to
  // `globalThis` directly via its `n.g` accessor. Mirror those into our
  // exposed-keys tracker so teardown unwinds cleanly.
  ['$', 'jQuery'].forEach(function (key) {
    if (typeof global[key] !== 'undefined') exposedKeys.add(key);
  });

  return result;
}

function teardown (clearDOM) {
  exposedKeys.forEach(function (key) {
    restoreGlobal(key);
  });
  exposedKeys = new Set();

  if (clearDOM === true) {
    Array.from(originalGlobals.keys()).forEach(restoreGlobal);
    if (activeEnv) {
      activeEnv.cleanup();
      activeEnv = null;
    }
  } else if (typeof global.document !== 'undefined' && global.document.body) {
    global.document.body.innerHTML = '';
  }
}

module.exports = {
  setup: setup,
  expose: expose,
  require: shimRequire,
  teardown: teardown
};
