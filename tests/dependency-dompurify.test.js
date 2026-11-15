'use strict';

const assert = require('assert');
const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');

// DOMPurify is the reference used by sanitizer-differential.test.js, not the
// production sanitizer. Exercise its actual default string API with our jsdom.
describe('DOMPurify reference dependency compatibility', function () {
  let dom;
  let purifier;

  beforeEach(function () {
    dom = new JSDOM('');
    purifier = createDOMPurify(dom.window);
    assert.strictEqual(purifier.isSupported, true);
  });

  afterEach(function () {
    dom.window.close();
  });

  // querySelectorAll does not enter template.content. Inspect it recursively
  // so a clean outer tree cannot hide an armed nested template in our oracle.
  function assertInert(node) {
    if (node.nodeType === 1) {
      assert.ok(!/^(script|iframe|object|embed)$/i.test(node.localName));
      for (const attr of node.attributes) {
        assert.ok(!/^on/i.test(attr.name), attr.name);
        if (/^(href|src|xlink:href|action|formaction)$/i.test(attr.name)) {
          // URL parsers ignore these control characters inside script schemes.
          // eslint-disable-next-line no-control-regex
          assert.ok(!/^(?:javascript|vbscript|data):/i.test(attr.value.replace(/[\s\u0000-\u001f]/g, '')), attr.value);
        }
      }
      if (node.content) assertInert(node.content);
    }
    for (const child of node.childNodes) assertInert(child);
  }

  const attacks = {
    'event handlers': '<img src=x onerror=alert(1)>',
    'encoded script URL': '<a href="java&#x09;script:alert(1)">link</a>',
    'nested templates': '<div><template><template><img src=x onerror=alert(1)></template></template></div>',
    'template script': '<div><template><script>alert(1)</script></template></div>',
    'template URL': '<div><template><a href="javascript:alert(1)">link</a></template></div>',
    'declarative template': '<div><?marker name="a"></div><template for="a"><img src=x onerror=alert(1)></template>',
    'MathML integration point': '<math><mtext><?marker name="a"></mtext></math><template for="a"><style><img src=x onerror=alert(1)></style></template>',
    'SVG integration point': '<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>'
  };

  Object.entries(attacks).forEach(function ([name, input]) {
    it('removes executable markup from ' + name + ' on repeated calls', function () {
      for (let pass = 0; pass < 2; pass++) {
        const output = purifier.sanitize(input);
        assert.strictEqual(typeof output, 'string');
        const holder = dom.window.document.createElement('div');
        holder.innerHTML = output;
        assertInert(holder);
        assert.strictEqual(purifier.sanitize('Fish &amp; Chips'), 'Fish &amp; Chips');
      }
    });
  });

  ['Fish & Chips', 'Hypo: BG <70 needed sugar', 'Glucose >200; 5.5 mmol/L', 'Café 💉\nBolus 2U'].forEach(function (input) {
    it('preserves visible note text: ' + JSON.stringify(input), function () {
      const holder = dom.window.document.createElement('div');
      holder.innerHTML = purifier.sanitize(input);
      assert.strictEqual(holder.textContent, input);
    });
  });

  it('preserves safe formatting and nested template content', function () {
    const input = '<div><strong>Bolus</strong><template><template><em>2U</em></template></template></div>';
    assert.strictEqual(purifier.sanitize(input), input);
  });

  // Newly supported in 3.4.14. Pin intended comparator differences while
  // ensuring an allowed presentation attribute does not retain an on* handler.
  ['pointer-events', 'vector-effect'].forEach(function (attribute) {
    it('preserves SVG ' + attribute + ' while stripping event handlers', function () {
      const value = attribute === 'pointer-events' ? 'none' : 'non-scaling-stroke';
      const output = purifier.sanitize('<svg><rect ' + attribute + '="' + value + '" onclick="alert(1)"></rect></svg>');
      const holder = dom.window.document.createElement('div');
      holder.innerHTML = output;
      assert.strictEqual(holder.querySelector('rect').getAttribute(attribute), value);
      assertInert(holder);
    });
  });
});
