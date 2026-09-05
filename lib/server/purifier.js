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
const { decodeHTML } = require('entities/decode');

// package.json deliberately pins sanitize-html 2.17.5: later releases require
// Node 22.12 while Nightscout still supports Node 20. The fixed allow-list
// below excludes the SVG/Math, SMIL, form, and raw-text elements involved in
// later parser advisories; tests lock those configuration assumptions down.

// sanitize-html builds a serialized copy of its input and can temporarily use
// considerably more memory than the source string. Nightscout text fields are
// normally tiny, so bound only strings that actually contain a possible HTML
// token. Large plain-text values retain the API's existing behavior without
// paying the parser's allocation cost.
const MAX_SANITIZED_STRING_LENGTH = 64 * 1024;
const POSSIBLE_HTML_MARKUP = /<[!/?A-Za-z]/;
// Keep hostile but valid JSON from turning the sanitizer itself into a heap
// exhaustion primitive. These limits are deliberately far above real
// Nightscout documents (including full profiles), while still bounding the
// traversal state retained for deeply nested input.
const MAX_TRAVERSED_OBJECTS = 10 * 1024;
const MAX_TRAVERSED_PROPERTIES = 50 * 1024;
const MAX_TRAVERSED_DEPTH = 1024;

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

function sanitizeStringWithBudget (s, budget) {
  // In the HTML data state, a tag can only start with "<" followed by an
  // ASCII letter, !, /, or (conservatively) ?. Character references that
  // decode to "<" are emitted as text and are not parsed again as markup.
  if (!POSSIBLE_HTML_MARKUP.test(s)) return s;

  if (s.length > budget.remaining) {
    throw new RangeError('HTML-containing text field exceeds the sanitization limit');
  }
  budget.remaining -= s.length;

  const clean = sanitizeHtml(s, SANITIZE_OPTIONS);

  // sanitize-html serializes harmless text characters as entities. Keep the
  // original value when decoding shows that sanitization did not remove or
  // rewrite anything. This avoids corrupting identifiers and references such
  // as profile names while retaining sanitized output whenever markup was
  // actually changed.
  return decodeHTML(clean) === decodeHTML(s) ? s : clean;
}

function sanitizeString (s) {
  return sanitizeStringWithBudget(s, {remaining: MAX_SANITIZED_STRING_LENGTH});
}

// Object.keys() creates a complete key array before a complexity limit can be
// checked. Iterating own enumerable keys lazily lets us reject very wide input
// without retaining another request-sized allocation in userland.
function * ownEnumerableKeys (node) {
  for (const key in node) {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      yield key;
    }
  }
}

/**
 * Walks the object and rewrites any string-valued leaves
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
  const stack = [];
  // Bound aggregate parser work as well as individual fields. Otherwise a
  // large request could split markup across many individually small strings.
  const sanitizeBudget = {remaining: MAX_SANITIZED_STRING_LENGTH};
  const traversalBudget = {objects: 0, properties: 0};

  function enter (node) {
    if (node === null || typeof node !== 'object') return false;
    if (seen.has(node)) return false;
    if (node instanceof Date) return false;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(node)) return false;
    if (ArrayBuffer.isView(node)) return false;
    seen.add(node);

    traversalBudget.objects += 1;
    if (traversalBudget.objects > MAX_TRAVERSED_OBJECTS || stack.length >= MAX_TRAVERSED_DEPTH) {
      throw new RangeError('Object exceeds the sanitization complexity limit');
    }

    stack.push({
      node: node,
      keys: ownEnumerableKeys(node)
    });
    return true;
  }

  enter(root);

  // Keep traversal state on the heap rather than the JavaScript call stack.
  // This retains depth-first behavior without overflowing on deeply nested
  // payloads received from API or WebSocket clients.
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const next = frame.keys.next();

    if (next.done) {
      stack.pop();
      continue;
    }

    traversalBudget.properties += 1;
    if (traversalBudget.properties > MAX_TRAVERSED_PROPERTIES) {
      throw new RangeError('Object exceeds the sanitization complexity limit');
    }

    const key = next.value;
    const value = frame.node[key];
    if (typeof value === 'string') {
      const clean = sanitizeStringWithBudget(value, sanitizeBudget);
      if (clean !== value) frame.node[key] = clean;
    } else if (value && typeof value === 'object') {
      enter(value);
    }
  }

  return root;
}

function init () {
  return {
    purifyObject: purifyObject,
    // Exposed for unit tests / future call sites that want to scrub a
    // single string without an object wrapper.
    sanitizeString: sanitizeString
  };
}

module.exports = init;
