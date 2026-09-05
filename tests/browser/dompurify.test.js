'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {withPage} = require('./fixture');

// This is an independent sanitizer comparator, not Nightscout's server
// sanitizer. Exercise its published browser API using a real browser DOM.
describe('DOMPurify reference in a real browser', function () {
  let server, origin;
  before(async function () {
    const source = fs.readFileSync(path.join(path.dirname(require.resolve('dompurify')), 'purify.js'));
    server = http.createServer((request, response) => {
      response.setHeader('Content-Type', request.url === '/purify.js' ? 'application/javascript' : 'text/html');
      response.end(request.url === '/purify.js' ? source : '<!doctype html><html><body></body></html>');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  async function inspect(input, passes = 1) {
    return withPage(origin, async ({page}) => {
      await page.goto(origin);
      await page.addScriptTag({url: origin + '/purify.js'});
      return page.evaluate(({input, passes}) => {
        const purifier = window.DOMPurify;
        if (!purifier.isSupported) throw new Error('DOMPurify is not supported');
        function violations(node, findings) {
          if (node.nodeType === 1) {
            if (/^(script|iframe|object|embed)$/i.test(node.localName)) findings.push(node.localName);
            for (const attr of node.attributes) {
              if (/^on/i.test(attr.name)) findings.push(attr.name);
              if (/^(href|src|xlink:href|action|formaction)$/i.test(attr.name)) {
                // eslint-disable-next-line no-control-regex
                if (/^(?:javascript|vbscript|data):/i.test(attr.value.replace(/[\s\u0000-\u001f]/g, ''))) findings.push(attr.value);
              }
            }
            if (node.content) violations(node.content, findings);
          }
          for (const child of node.childNodes) violations(child, findings);
        }
        return Array.from({length: passes}, () => {
          const output = purifier.sanitize(input);
          if (typeof output !== 'string') throw new Error('Expected the default string API');
          const holder = document.createElement('div');
          holder.innerHTML = output;
          const findings = [];
          violations(holder, findings);
          const rect = holder.querySelector('rect');
          return {output, findings, text: holder.textContent, ampersand: purifier.sanitize('Fish &amp; Chips'),
            attributes: rect ? Object.fromEntries(Array.from(rect.attributes, attr => [attr.name, attr.value])) : {}};
        });
      }, {input, passes});
    });
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
  for (const [name, input] of Object.entries(attacks)) {
    it('removes executable markup from ' + name + ' on repeated calls', async function () {
      for (const result of await inspect(input, 2)) {
        assert.deepEqual(result.findings, []);
        assert.equal(result.ampersand, 'Fish &amp; Chips');
      }
    });
  }
  for (const input of ['Fish & Chips', 'Hypo: BG <70 needed sugar', 'Glucose >200; 5.5 mmol/L', 'Café 💉\nBolus 2U']) {
    it('preserves visible note text: ' + JSON.stringify(input), async function () {
      assert.equal((await inspect(input))[0].text, input);
    });
  }
  it('preserves safe formatting and nested template content', async function () {
    const input = '<div><strong>Bolus</strong><template><template><em>2U</em></template></template></div>';
    assert.equal((await inspect(input))[0].output, input);
  });
  for (const attribute of ['pointer-events', 'vector-effect']) {
    it('preserves SVG ' + attribute + ' while stripping event handlers', async function () {
      const value = attribute === 'pointer-events' ? 'none' : 'non-scaling-stroke';
      const result = (await inspect('<svg><rect ' + attribute + '="' + value + '" onclick="alert(1)"></rect></svg>'))[0];
      assert.equal(result.attributes[attribute], value);
      assert.deepEqual(result.findings, []);
    });
  }
});
