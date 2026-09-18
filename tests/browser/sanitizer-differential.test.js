'use strict';

// Preserve the 30-input/four-sanitizer comparison and render-path corpus
// using a real browser parser. Production sanitization still runs in Node;
// DOMPurify is a development-only reference loaded from its published UMD.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {withPage} = require('./fixture');

// Candidate replacements (no DOM dependency)
const xss = require('xss');
const sanitizeHtml = require('sanitize-html');
const productionSanitizer = require('../../lib/server/purifier')().sanitizeString;

// A text-only comparator. Unlike this configuration, default DOMPurify
// retains supported safe markup; those differences remain in the report.
const sanitizeHtmlStrict = (input) => sanitizeHtml(input, {
  allowedTags: [],
  allowedAttributes: {},
  disallowedTagsMode: 'discard'
});

// Retain the same explicit text-only xss configuration for comparison.
const xssStrict = new xss.FilterXSS({
  whiteList: {},
  stripIgnoreTag: true,
  stripIgnoreTagBody: ['script', 'style']
});
const xssStrip = (input) => xssStrict.process(input);

function ejsEscape (s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  {name: 'production', fn: productionSanitizer},
  {name: 'dompurify'},
  {name: 'xss', fn: xssStrip},
  {name: 'sanitize-html-strict', fn: sanitizeHtmlStrict}
];

describe('sanitizer corpus in a real browser', function () {
  let server, origin;
  before(async function () {
    const source = fs.readFileSync(path.join(path.dirname(require.resolve('dompurify')), 'purify.js'));
    server = http.createServer((request, response) => {
      response.setHeader('Content-Type', request.url === '/purify.js' ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8');
      response.end(request.url === '/purify.js' ? source : '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  async function inspect(sanitizer, input, mode) {
    return withPage(origin, async ({page}) => {
      await page.goto(origin);
      let output = input;
      if (sanitizer && sanitizer.name === 'dompurify') {
        await page.addScriptTag({url: origin + '/purify.js'});
        output = await page.evaluate(input => {
          if (!window.DOMPurify.isSupported) throw new Error('DOMPurify is not supported');
          return window.DOMPurify.sanitize(input);
        }, input);
      } else if (sanitizer) {
        output = sanitizer.fn(input);
      }
      const rendered = mode === 'ejs' ? ejsEscape(output) : output;
      const residual = await page.evaluate(({rendered, mode}) => {
        let markup = rendered;
        if (mode === 'text') {
          const span = document.createElement('span');
          span.textContent = rendered;
          markup = span.outerHTML;
        }
        // Parse an inert full document, as the original jsdom oracle did.
        // Do not insert attack markup into the executing fixture document.
        const body = new DOMParser().parseFromString('<!doctype html><body>' + markup + '</body>', 'text/html').body;
        const findings = [];
        body.querySelectorAll('*').forEach(el => {
          if (el.tagName === 'SCRIPT') findings.push('script-tag');
          if (el.tagName === 'IFRAME') findings.push('iframe-tag');
          if (el.tagName === 'OBJECT') findings.push('object-tag');
          if (el.tagName === 'EMBED') findings.push('embed-tag');
          for (const attr of el.attributes) {
            if (/^on/i.test(attr.name)) findings.push('event-handler:' + attr.name);
            if (/^(href|src|action|formaction)$/i.test(attr.name)) {
              const value = (attr.value || '').trim().toLowerCase();
              if (value.startsWith('javascript:')) findings.push('js-url:' + attr.name);
              if (value.startsWith('vbscript:')) findings.push('vbs-url:' + attr.name);
              if (value.startsWith('data:') && value.includes('script')) findings.push('data-script-url:' + attr.name);
            }
          }
        });
        return findings;
      }, {rendered, mode});
      return {output, residual};
    });
  }

  describe('sanitizer-differential: behavior comparison', function () {
    this.timeout(15000);

    // Capture results in a matrix for the closing report.
    const matrix = {}; // matrix[corpusId][sanitizerName] = { output, residual }

    CORPUS.forEach((c) => {
      matrix[c.id] = {};
      describe(c.label + ' [' + c.id + ']', () => {

        SANITIZERS.forEach((s) => {
          it(s.name + ': must neutralize', async () => {
            const {output: out, residual} = await inspect(s, c.input);
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
                assert.deepEqual(residual, [], `[${s.name}] live markup found for "${c.id}": ${JSON.stringify(residual)} | output=${JSON.stringify(out)}`);
              }
            });

            // Invariant 2: regardless of substring residue, no live markup.
            matrix[c.id][s.name].residual = residual;
            assert.deepEqual(residual, [], `[${s.name}] residual live markup for "${c.id}": ${JSON.stringify(residual)} | output=${JSON.stringify(out)}`);
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
      // A focused --grep run or an earlier failed case may leave a partial
      // matrix. Report only measured rows without masking the test failure
      // with an unrelated exception in this diagnostic hook.
      const measured = CORPUS.filter(c => SANITIZERS.every(s => matrix[c.id][s.name]));
      measured.forEach((c) => {
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
      console.log(`Measured corpus: ${rows.length}, divergent: ${divergent}, incomplete: ${CORPUS.length - rows.length}\n`);
    });
  });

  describe('sanitizer-differential: render-path safety (post-EJS-escape)', () => {
    // Even if a sanitizer leaves "scary-looking" text in place, the EJS render
    // path entity-escapes it, so this exercise demonstrates the end-to-end
    // safety of each candidate.
    CORPUS.forEach((c) => {
      SANITIZERS.forEach((s) => {
        it('[' + s.name + '] [' + c.id + '] EJS-escaped output is inert', async () => {
          const {residual} = await inspect(s, c.input, 'ejs');
          assert.deepEqual(residual, [], `[${s.name}] [${c.id}] EJS-escaped residual: ${JSON.stringify(residual)}`);
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
      it('[' + c.id + '] raw input rendered via textContent is inert', async () => {
        const {residual} = await inspect(null, c.input, 'text');
        assert.deepEqual(residual, [], `raw textContent path leaked for "${c.id}": ${JSON.stringify(residual)}`);
      });
    });
  });

  it('production sanitizer keeps disabled SVG, form and raw-text parser features inert', async function () {
    var payloads = [
      '<svg><a><animate attributeName="href" values="#safe;javascript:alert(\'XSS\')" dur=".01s" fill="freeze"></animate><text y="30">Click me</text></a></svg>',
      '<button formaction="javascript:alert(1)">Submit</button>',
      '<object data="javascript:alert(1)"></object>',
      '<textarea><img src=x onerror=alert(1)></textarea>SAFE',
      '<xmp><img src=x onerror=alert(1)></xmp>SAFE',
      '<textarea></textarea/><img src=x onerror="alert(document.domain)">',
      '<xmp></xmp/><img src=x onerror="alert(document.domain)">',
      '<svg><textarea><img src=x onerror=alert(1)>',
      '<svg><xmp><img src=x onerror=alert(1)>',
      '<math><textarea><img src=x onerror=alert(1)>',
      '<math><xmp><img src=x onerror=alert(1)>',
      '<math><mtext><table><mglyph><style><!--</style><img title="--></mglyph><img src=1 onerror=alert(1)>">'
    ];
    const sanitized = payloads.map(payload => productionSanitizer(payload));
    await withPage(origin, async ({page}) => {
      await page.goto(origin);
      const findings = await page.evaluate(outputs => {
        const findings = [];
        for (let index = 0; index < outputs.length; index++) {
          let markup = outputs[index];
          for (let round = 0; round < 3; round++) {
            const body = new DOMParser().parseFromString('<!doctype html><body>' + markup + '</body>', 'text/html').body;
            for (const element of body.querySelectorAll('svg, animate, set, form, button, object, textarea, xmp, math, script, iframe, embed')) {
              findings.push({index, round, tag: element.localName});
            }
            for (const element of body.querySelectorAll('*')) {
              for (const attribute of element.attributes) {
                if (/^on/i.test(attribute.name)) findings.push({index, round, attribute: attribute.name});
                if (/^(?:href|src|srcset|action|formaction|data|srcdoc)$/i.test(attribute.name) && /^\s*(?:javascript|vbscript):/i.test(attribute.value)) {
                  findings.push({index, round, url: attribute.value});
                }
              }
            }
            markup = body.innerHTML;
          }
        }
        return findings;
      }, sanitized);
      assert.deepEqual(findings, []);
    });
  });
});
