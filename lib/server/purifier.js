'use strict';

/**
 * lib/server/purifier.js
 *
 * Server-side scrubber applied to free-text fields on inbound API writes
 * (treatments, profiles, devicestatus, entries) before they're persisted.
 *
 * Implementation: sanitize-html (pure JS, no DOM dependency).
 *
 * Background:
 *   Previously this module loaded `dompurify` and instantiated a full
 *   `jsdom` window per process, purely to give DOMPurify a DOM to operate
 *   on. jsdom is a complete browser polyfill (HTML/CSS/URL/Fetch/XHR/vm)
 *   and every CVE in any of its subsystems became a Nightscout runtime
 *   CVE. Nightscout's use case is "strip dangerous markup from user
 *   strings"; sanitize-html does exactly that with a pure-JS HTML
 *   tokenizer and no JS execution surface.
 *
 *   Behavior is preserved within the bounds verified by:
 *     - tests/security.test.js (`describe('purifier')` — PR #8517)
 *     - tests/sanitizer-differential.test.js (full corpus comparison
 *       across DOMPurify v3, xss, and sanitize-html)
 *
 *   See "Phase A" of the jsdom-elimination plan for the rationale and
 *   the output-encoding audit that complements this change.
 *
 * Defense-in-depth note:
 *   This sanitizer is NOT the sole barrier. EJS `<%= %>` and jQuery
 *   `.text()`/`textContent` paths render any string inert at output time.
 *   Phase B audits for `<%- %>`, `.html()`, `innerHTML`, etc., to ensure
 *   no path bypasses output encoding.
 */

const sanitizeHtml = require('sanitize-html');

// Use sanitize-html's defaults (a curated allow-list of inert formatting
// tags + http/https/mailto/tel/ftp URL schemes). This matches DOMPurify's
// default posture — strip scripts/handlers/dangerous URLs, keep safe
// inline/block formatting — without pulling in a DOM.
const SANITIZE_OPTIONS = {
  // Defaults: address, article, h1-h6, blockquote, p, pre, ul, ol, li, a,
  // b, em, strong, code, span, etc. NOT in default: script, iframe, img,
  // svg, object, embed, form, input, style, meta, link, button.
  //
  // We additionally allow `img` because DOMPurify (the previous
  // implementation) preserved the <img> shell while stripping dangerous
  // src/onerror attributes — and existing user notes in the wild may
  // contain inline images. Dangerous URL schemes on `src` are still
  // rejected via allowedSchemes (no javascript:, vbscript:, data:), and
  // event handlers (onerror, onload, ...) are stripped because they are
  // not in allowedAttributes.img.
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img']),
  allowedAttributes: sanitizeHtml.defaults.allowedAttributes,
  // Defaults: http, https, ftp, mailto, tel. Excludes javascript:,
  // vbscript:, data: — eliminates the classic href-injection vectors.
  allowedSchemes: sanitizeHtml.defaults.allowedSchemes,
  allowedSchemesByTag: sanitizeHtml.defaults.allowedSchemesByTag,
  // Disallowed-tag bodies are dropped entirely (matches the test
  // assertion `<script>alert(1)</script>safe` -> `safe`).
  disallowedTagsMode: 'discard'
};

function sanitizeString (s) {
  return sanitizeHtml(s, SANITIZE_OPTIONS);
}

/**
 * Recursively walks the object and rewrites any string-valued leaves
 * with their sanitized form. Mutates in place AND returns the input,
 * so callers can use either pattern.
 *
 * Hardening over the previous implementation:
 *   - Uses Object.prototype.hasOwnProperty.call instead of obj.hasOwnProperty
 *     (objects without prototypes, e.g. Object.create(null), would have
 *     thrown).
 *   - Drops the `isNaN(value)` heuristic that mis-classified booleans,
 *     null, and undefined as "needs sanitization".
 *   - Handles arrays explicitly so numeric indices are walked too.
 *   - Detects cycles to avoid stack overflow on self-referential payloads.
 *   - Skips Date / Buffer / typed-array leaves.
 */
function purifyObject (root) {
  const seen = new WeakSet();

  function walk (node) {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    if (node instanceof Date) return;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(node)) return;
    if (ArrayBuffer.isView(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i];
        if (typeof v === 'string') {
          const clean = sanitizeString(v);
          if (clean !== v) node[i] = clean;
        } else if (v && typeof v === 'object') {
          walk(v);
        }
      }
      return;
    }

    for (const key of Object.keys(node)) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      const v = node[key];
      if (typeof v === 'string') {
        const clean = sanitizeString(v);
        if (clean !== v) node[key] = clean;
      } else if (v && typeof v === 'object') {
        walk(v);
      }
    }
  }

  walk(root);
  return root;
}

function init (env, ctx) {
  return {
    purifyObject: purifyObject,
    // Exposed for unit tests / future call sites that want to scrub a
    // single string without an object wrapper.
    sanitizeString: sanitizeString
  };
}

module.exports = init;
