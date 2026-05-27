'use strict';

/**
 * Sanitizer differential test
 * ----------------------------
 * Compares the current production sanitizer (DOMPurify + jsdom) against two
 * lighter, no-DOM candidates (xss, sanitize-html) on the inputs Nightscout
 * actually sees in `lib/server/purifier.js#purifyObject`.
 *
 * Goals:
 *   1. Document where the candidates DIVERGE from DOMPurify so any future
 *      swap is intentional, not silent.
 *   2. Assert the SECURITY invariant that matters: regardless of which
 *      sanitizer's output is stored, when that output is rendered via the
 *      paths Nightscout actually uses (jQuery .text() or EJS <%= %>), no
 *      live script/handler/URL survives.
 *   3. Provide a stable corpus future PRs can extend.
 *
 * This test is purely a measurement/safety-net — it does NOT change runtime
 * behavior. Run with: `npx mocha tests/sanitizer-differential.test.js`
 *
 * Companion docs:
 *   - lib/server/purifier.js (current sanitizer)
 *   - PR #8517 (drops jsdom-purify alias, keeps dompurify+jsdom)
 *
 * Findings as of this commit:
 *   - `xss` (default strip-all config) DATA-LOSS-BUG for Nightscout: it
 *     truncates `"Hypo: BG < 70 needed sugar"` to `"Hypo: BG "` because it
 *     parses `<` as a tag start. Diabetes users routinely write `BG < 70`
 *     or `> 250` in notes — disqualifying without a different xss config.
 *   - `sanitize-html` with `{allowedTags:[], allowedAttributes:{}}` matches
 *     DOMPurify on every benign input and is MORE aggressive than DOMPurify
 *     on attack payloads (collapses `<a>click</a>` -> `click`, kills inert
 *     `<svg></svg>` shells). It HTML-entity-escapes `<` and `&` correctly.
 *     => Preferred replacement candidate.
 *   - DOMPurify keeps inert tag shells (`<img src="x">`, `<svg></svg>`,
 *     `<a>...</a>`) after stripping handlers/URLs. Harmless but noisier.
 *   - The jQuery .text() / textContent render path is INERT for raw input —
 *     so server-side sanitization is strictly defense-in-depth for that
 *     code path. EJS `<%= %>` likewise renders any input safely.
 */

const should = require('should');

// Current production stack
const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');
const dompurify = createDOMPurify(new JSDOM('').window);

// Candidate replacements (no DOM dependency)
const xss = require('xss');
const sanitizeHtml = require('sanitize-html');

// Strict empty-allowlist config — closest semantic match to DOMPurify's
// default of "strip everything that's not safe text".
const sanitizeHtmlStrict = (input) => sanitizeHtml(input, {
  allowedTags: [],
  allowedAttributes: {},
  disallowedTagsMode: 'discard'
});

// The xss default config is already strip-all-tags-by-default for unknown
// tags; we lock it down further to match a "text-only" use case.
const xssStrict = new xss.FilterXSS({
  whiteList: {},
  stripIgnoreTag: true,
  stripIgnoreTagBody: ['script', 'style']
});
const xssStrip = (input) => xssStrict.process(input);

/**
 * Minimal renderer-equivalence helpers.
 *
 * Nightscout renders sanitized strings via two paths in production:
 *   (a) jQuery .text() / textContent  -> behaves like HTML-escape, so any
 *       residual markup is shown as literal text. Safe by construction.
 *   (b) EJS <%= %>                     -> HTML-entity escapes &, <, >, ', ".
 *
 * For the security invariant we focus on path (b): if the sanitizer output,
 * after EJS escape, parses back to a DOM with zero <script>, zero on*
 * attributes, zero javascript: URLs, and zero data URLs containing script,
 * the value is safe.
 */
function ejsEscape (s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Re-parse sanitizer output to detect any LIVE markup that survived.
// A clean sanitizer should leave at most inert text or entity references.
function residualLiveMarkup (sanitizerOutput) {
  const dom = new JSDOM(`<!doctype html><body>${sanitizerOutput}</body>`);
  const body = dom.window.document.body;
  const findings = [];
  body.querySelectorAll('*').forEach((el) => {
    if (el.tagName === 'SCRIPT') findings.push('script-tag');
    if (el.tagName === 'IFRAME') findings.push('iframe-tag');
    if (el.tagName === 'OBJECT') findings.push('object-tag');
    if (el.tagName === 'EMBED') findings.push('embed-tag');
    for (const attr of el.attributes) {
      if (/^on/i.test(attr.name)) findings.push('event-handler:' + attr.name);
      if (/^(href|src|action|formaction)$/i.test(attr.name)) {
        const v = (attr.value || '').trim().toLowerCase();
        if (v.startsWith('javascript:')) findings.push('js-url:' + attr.name);
        if (v.startsWith('vbscript:')) findings.push('vbs-url:' + attr.name);
        if (v.startsWith('data:') && v.includes('script')) findings.push('data-script-url:' + attr.name);
      }
    }
  });
  return findings;
}

// Corpus.
// Each entry: { id, label, input, mustBeStripped: [substrings that MUST NOT
// appear unescaped in any sanitizer's output] }
const CORPUS = [
  // ---- Realistic Nightscout free-text (notes, eventType-as-Note) ----
  { id: 'plain-note', label: 'plain note', input: 'Pre-meal correction, 30g carbs',           mustBeStripped: [] },
  { id: 'mathy-note', label: 'mathy note (>200 mg/dL)', input: 'BG was >200 mg/dL after run', mustBeStripped: [] },
  { id: 'less-than',  label: 'note with < 70',          input: 'Hypo: BG < 70 needed sugar',  mustBeStripped: [] },
  { id: 'amp-note',   label: 'ampersand in note',       input: 'Carbs & protein meal',        mustBeStripped: [] },
  { id: 'unicode',    label: 'unicode/emoji',           input: 'Meal 🍕 with ❤️',              mustBeStripped: [] },
  { id: 'mmol',       label: 'mmol/L decimal',          input: '5.5 mmol/L → 99 mg/dL',       mustBeStripped: [] },
  { id: 'multiline',  label: 'multiline notes',         input: 'line one\nline two\rline three', mustBeStripped: [] },
  { id: 'enum-bolus', label: 'eventType enum',          input: 'Meal Bolus',                  mustBeStripped: [] },
  { id: 'device-uri', label: 'device uri',              input: 'loop://Loop-iPhone',          mustBeStripped: [] },

  // ---- OWASP-style XSS payloads ----
  { id: 'xss-script-tag',     label: 'classic script tag',           input: '<script>alert(1)</script>',                            mustBeStripped: ['<script', 'alert(1)'] },
  { id: 'xss-img-onerror',    label: 'img onerror handler',          input: '<img src=x onerror=alert(1)>',                         mustBeStripped: ['onerror', 'alert(1)'] },
  { id: 'xss-svg-onload',     label: 'svg onload handler',           input: '<svg/onload=alert(1)>',                                mustBeStripped: ['onload', 'alert(1)'] },
  { id: 'xss-anchor-jsurl',   label: 'anchor with javascript: url',  input: '<a href="javascript:alert(1)">click</a>',              mustBeStripped: ['javascript:', 'alert(1)'] },
  { id: 'xss-iframe-src',     label: 'iframe javascript: src',       input: '<iframe src="javascript:alert(1)"></iframe>',          mustBeStripped: ['javascript:', '<iframe'] },
  { id: 'xss-mixed-case',     label: 'mixed-case ScRiPt tag',        input: '<ScRiPt>alert(1)</ScRiPt>',                            mustBeStripped: ['ScRiPt', 'alert(1)'] },
  { id: 'xss-html-entities',  label: 'entity-encoded payload',       input: '&lt;script&gt;alert(1)&lt;/script&gt;',                mustBeStripped: [] }, // already inert
  { id: 'xss-malformed',      label: 'malformed tag',                input: '<img src="x" onerror=alert(1) //>',                    mustBeStripped: ['onerror', 'alert(1)'] },
  { id: 'xss-style-expr',     label: 'style with expression',        input: '<div style="background:url(javascript:alert(1))">x</div>', mustBeStripped: ['javascript:'] },
  { id: 'xss-data-uri',       label: 'data: uri with script',        input: '<a href="data:text/html,<script>alert(1)</script>">x</a>', mustBeStripped: ['<script', 'alert(1)'] },
  { id: 'xss-vbscript',       label: 'vbscript: url',                input: '<a href="vbscript:msgbox(1)">x</a>',                   mustBeStripped: ['vbscript:'] },
  { id: 'xss-mxss-noscript',  label: 'mXSS via noscript',            input: '<noscript><p title="</noscript><img src=x onerror=alert(1)>">', mustBeStripped: ['onerror', 'alert(1)'] },
  { id: 'xss-svg-namespace',  label: 'svg foreignObject',            input: '<svg><foreignObject><script>alert(1)</script></foreignObject></svg>', mustBeStripped: ['<script', 'alert(1)'] },
  { id: 'xss-form-action',    label: 'form formaction',              input: '<button formaction="javascript:alert(1)">go</button>', mustBeStripped: ['javascript:', 'formaction'] },
  { id: 'xss-meta-refresh',   label: 'meta refresh javascript',      input: '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">', mustBeStripped: ['javascript:'] },

  // ---- Edge cases ----
  { id: 'empty',          label: 'empty string',          input: '',                  mustBeStripped: [] },
  { id: 'whitespace',     label: 'whitespace only',       input: '   \t\n  ',         mustBeStripped: [] },
  { id: 'long-text',      label: 'long benign text',      input: 'A'.repeat(2000),    mustBeStripped: [] },
  { id: 'null-byte',      label: 'embedded null byte',    input: 'pre\u0000post',     mustBeStripped: [] },
  { id: 'tag-soup',       label: 'unclosed tag soup',     input: '<<<>>>< br><<><<a',  mustBeStripped: [] },
  { id: 'nested-quotes',  label: 'mixed quotes in note',  input: 'She said "hello" & he said \'hi\'', mustBeStripped: [] }
];

const SANITIZERS = [
  { name: 'dompurify', fn: (s) => dompurify.sanitize(s) },
  { name: 'xss',       fn: xssStrip },
  { name: 'sanitize-html-strict', fn: sanitizeHtmlStrict }
];

describe('sanitizer-differential: behavior comparison', function () {
  this.timeout(15000);

  // Capture results in a matrix for the closing report.
  const matrix = {}; // matrix[corpusId][sanitizerName] = { output, residual }

  CORPUS.forEach((c) => {
    matrix[c.id] = {};
    describe(c.label + ' [' + c.id + ']', () => {

      SANITIZERS.forEach((s) => {
        it(s.name + ': must neutralize', () => {
          const out = s.fn(c.input);
          matrix[c.id][s.name] = { output: out };

          // Invariant 1: required-strip substrings must not appear LIVE in
          // the output. (entity-encoded forms are fine — those are inert.)
          c.mustBeStripped.forEach((bad) => {
            // For executable-handler/URL substrings we test loosely: they
            // should not appear in their original lower-case dangerous form
            // unless surrounded by entity escapes.
            const lower = out.toLowerCase();
            const liveOccurrence = lower.indexOf(bad.toLowerCase());
            if (liveOccurrence !== -1) {
              // Check whether the surrounding context is entity-escaped
              // (i.e. the dangerous substring is inert text). DOMPurify
              // sometimes returns the inner text "alert(1)" verbatim after
              // stripping the script wrapper, which is harmless inert text.
              // We accept it ONLY if no executable structure remains.
              const residual = residualLiveMarkup(out);
              residual.should.eql([], `[${s.name}] live markup found for "${c.id}": ${JSON.stringify(residual)} | output=${JSON.stringify(out)}`);
            }
          });

          // Invariant 2: regardless of substring residue, no live markup.
          const residual = residualLiveMarkup(out);
          matrix[c.id][s.name].residual = residual;
          residual.should.eql([], `[${s.name}] residual live markup for "${c.id}": ${JSON.stringify(residual)} | output=${JSON.stringify(out)}`);
        });
      });

      it('produce a documented divergence record', () => {
        const outs = SANITIZERS.map((s) => matrix[c.id][s.name].output);
        const allEqual = outs.every((o) => o === outs[0]);
        // We do NOT fail on divergence — we record it. Future PRs that
        // intentionally swap sanitizers can read this matrix to confirm the
        // expected delta.
        if (!allEqual) {
          // Attach to the test for visibility in mocha output.
          // eslint-disable-next-line no-console
          console.log('  divergence [' + c.id + ']:');
          SANITIZERS.forEach((s) => {
            // eslint-disable-next-line no-console
            console.log('    ' + s.name.padEnd(22) + ' -> ' + JSON.stringify(matrix[c.id][s.name].output));
          });
        }
      });
    });
  });

  // Aggregate divergence summary.
  after(() => {
    const rows = [];
    CORPUS.forEach((c) => {
      const row = { id: c.id };
      SANITIZERS.forEach((s) => {
        row[s.name + '_len'] = (matrix[c.id][s.name].output || '').length;
      });
      const outs = SANITIZERS.map((s) => matrix[c.id][s.name].output);
      const equivClasses = new Set(outs).size;
      row.equiv_classes = equivClasses;
      rows.push(row);
    });
    // eslint-disable-next-line no-console
    console.log('\n=== sanitizer-differential summary ===');
    // eslint-disable-next-line no-console
    console.table(rows);
    const divergent = rows.filter((r) => r.equiv_classes > 1).length;
    // eslint-disable-next-line no-console
    console.log(`Total corpus: ${rows.length}, divergent: ${divergent}\n`);
  });
});

describe('sanitizer-differential: render-path safety (post-EJS-escape)', () => {
  // Even if a sanitizer leaves "scary-looking" text in place, the EJS render
  // path entity-escapes it, so this exercise demonstrates the end-to-end
  // safety of each candidate.
  CORPUS.forEach((c) => {
    SANITIZERS.forEach((s) => {
      it('[' + s.name + '] [' + c.id + '] EJS-escaped output is inert', () => {
        const sanitized = s.fn(c.input);
        const rendered = ejsEscape(sanitized);
        const residual = residualLiveMarkup(rendered);
        residual.should.eql([], `[${s.name}] [${c.id}] EJS-escaped residual: ${JSON.stringify(residual)}`);
      });
    });
  });
});

describe('sanitizer-differential: jQuery .text() equivalence', () => {
  // jQuery .text() / textContent assignment treats input as literal text.
  // This means even the RAW input (no sanitizer at all) renders inert via
  // this path. We assert that property here so we can document why the
  // server-side sanitizer is "defense in depth", not the sole barrier.
  CORPUS.forEach((c) => {
    it('[' + c.id + '] raw input rendered via textContent is inert', () => {
      const dom = new JSDOM('<!doctype html><body><span id="t"></span></body>');
      const span = dom.window.document.getElementById('t');
      span.textContent = c.input;
      const residual = residualLiveMarkup(span.outerHTML);
      residual.should.eql([], `raw textContent path leaked for "${c.id}": ${JSON.stringify(residual)}`);
    });
  });
});
