'use strict';

/*
 * dom-globals.js
 *
 * Shared helper for Phase 3.x modern jsdom tests. Wires up:
 *   - global.window / global.document / global.navigator (configurable)
 *   - jQuery bound to the supplied jsdom window
 *
 * Why a helper:
 *   1. Modern Node (>= 21) makes some globals (notably navigator)
 *      getter-only. Use Object.defineProperty(configurable:true).
 *   2. The `jquery` package's CommonJS entry inspects global.document
 *      AT FIRST require to decide whether to return a callable $ or a
 *      `factory(window)`. We need the factory form, so we must require
 *      jquery BEFORE installing global.document. That ordering quirk
 *      tripped up the first conversion; centralizing it here keeps
 *      every Phase 3.x test consistent.
 *
 * Usage:
 *   const { installDomGlobals, restoreDomGlobals } = require('./dom-globals');
 *   beforeEach(() => { state = installDomGlobals(env); });
 *   afterEach(()  => { restoreDomGlobals(state); });
 */

function defineConfigurable (obj, name, value) {
  try {
    Object.defineProperty(obj, name, {
      configurable: true, writable: true, enumerable: true, value: value
    });
  } catch (e) {
    obj[name] = value;
  }
}

/**
 * @param {{window: Window, document: Document}} env
 *   The result of createSecureDOM().
 * @param {object} [opts]
 * @param {boolean} [opts.jquery=true]  Install jQuery onto env.window and global.
 * @returns {object} Snapshot used by restoreDomGlobals().
 */
function installDomGlobals (env, opts) {
  const options = Object.assign({ jquery: true }, opts || {});

  if (options.jquery) {
    delete require.cache[require.resolve('jquery')];
    const priorDocument = global.document;
    delete global.document;
    const jqueryFactory = require('jquery');
    if (priorDocument !== undefined) global.document = priorDocument;
    jqueryFactory(env.window);
  }

  defineConfigurable(global, 'window', env.window);
  defineConfigurable(global, 'document', env.document);
  defineConfigurable(global, 'navigator', env.window.navigator);

  if (options.jquery) {
    defineConfigurable(global, '$', env.window.$);
    defineConfigurable(global, 'jQuery', env.window.jQuery);
  }

  return { env: env, jquery: options.jquery };
}

function restoreDomGlobals (state) {
  if (!state) return;
  if (state.jquery) {
    try { delete global.$; } catch (e) { /* ignore */ }
    try { delete global.jQuery; } catch (e) { /* ignore */ }
    delete require.cache[require.resolve('jquery')];
  }
  try { delete global.window; } catch (e) { /* ignore */ }
  try { delete global.document; } catch (e) { /* ignore */ }
  // Leave navigator alone — Node >= 21 may own it.
  if (state.env && state.env.cleanup) state.env.cleanup();
}

module.exports = {
  installDomGlobals: installDomGlobals,
  restoreDomGlobals: restoreDomGlobals,
  defineConfigurable: defineConfigurable
};
