'use strict';

const assert = require('assert');
const http = require('http');
const {once} = require('events');
const {JSDOM} = require('jsdom');
const {createSecureDOM} = require('./fixtures/secure-jsdom');

// These existing isolation tests previously lived outside test-ci's file glob.
require('./fixtures/secure-jsdom.test');

describe('jsdom dependency compatibility', function () {
  let env;
  afterEach(function () { if (env) env.cleanup(); env = null; });

  it('keeps scripted window prototypes inside their own realm', function () {
    env = createSecureDOM('', {runScripts: 'outside-only'});
    assert.strictEqual(Object.getPrototypeOf(env.window.EventTarget.prototype), env.window.Object.prototype);
    assert.notStrictEqual(env.window.Object.prototype, Object.prototype);
    assert.strictEqual(env.window.eval('window instanceof Object'), true);
  });
  it('isolates authentication storage between windows and retains it during DOM updates', function () {
    env = createSecureDOM('<main></main>');
    for (let cycle = 0; cycle < 2; cycle++) {
      env.window.localStorage.setItem('apisecrethash', 'fixture-hash');
      env.document.querySelector('main').textContent = 'updated ' + cycle;
      assert.strictEqual(env.window.localStorage.getItem('apisecrethash'), 'fixture-hash');
      env.window.localStorage.removeItem('apisecrethash');
      assert.strictEqual(env.window.localStorage.getItem('apisecrethash'), null);
    }
    env.window.localStorage.setItem('apisecrethash', 'old-window');
    env.cleanup();
    env = createSecureDOM();
    assert.strictEqual(env.window.localStorage.getItem('apisecrethash'), null);
  });
  it('preserves selector matching and delegated input events after repeated form replacement', function () {
    env = createSecureDOM('<main></main>');
    const events = [];
    env.document.querySelector('main').addEventListener('input', event => events.push(event.target.value));
    for (let cycle = 0; cycle < 2; cycle++) {
      env.document.querySelector('main').innerHTML = '<form><label><input name="carbs" value="0"></label></form>';
      const input = env.document.querySelector('form input[name="carbs"]');
      assert.strictEqual(input.closest('form'), env.document.querySelector('form'));
      input.value = String(20 + cycle);
      input.dispatchEvent(new env.window.Event('input', {bubbles: true}));
    }
    assert.deepStrictEqual(events, ['20', '21']);
  });
  it('preserves SVG group classes and viewport relationships used by chart fixtures', function () {
    env = createSecureDOM('<svg id="chart" xmlns="http://www.w3.org/2000/svg"><defs></defs><g id="points"><svg id="nested"><g id="inner"></g></svg></g></svg>');
    const document = env.document;
    assert.ok(document.querySelector('defs') instanceof env.window.SVGDefsElement);
    assert.ok(document.querySelector('#points') instanceof env.window.SVGGElement);
    assert.strictEqual(document.querySelector('#inner').viewportElement, document.querySelector('#nested'));
    assert.ok(document.querySelector('#chart').createSVGRect() instanceof env.window.SVGRect);
  });
  it('exposes form controls by index without changing their submitted values', function () {
    env = createSecureDOM('<form><input name="carbs" value="20"><input name="insulin" value="2"></form>');
    const form = env.document.querySelector('form');
    assert.strictEqual(form[0], form.elements.namedItem('carbs'));
    assert.strictEqual(form[1], form.elements.namedItem('insulin'));
    assert.deepStrictEqual(Array.from(new env.window.FormData(form).entries()), [['carbs', '20'], ['insulin', '2']]);
  });
  it('composes abort signals without invoking cancellation more than once', function () {
    env = createSecureDOM();
    const first = new env.window.AbortController();
    const second = new env.window.AbortController();
    const signal = env.window.AbortSignal.any([first.signal, second.signal]);
    let calls = 0;
    signal.addEventListener('abort', () => calls++);
    second.abort('fixture');
    first.abort('later');
    assert.strictEqual(signal.aborted, true);
    assert.strictEqual(signal.reason, 'fixture');
    assert.strictEqual(calls, 1);
  });
  it('round-trips entities and nested template content without executing scripts', function () {
    env = createSecureDOM('<p>Fish &amp; Chips &#x1f489;</p><template><b>&lt;70</b><script>window.fixtureExecuted=true</script></template>');
    assert.strictEqual(env.document.querySelector('p').textContent, 'Fish & Chips 💉');
    assert.strictEqual(env.document.querySelector('template').content.querySelector('b').textContent, '<70');
    assert.strictEqual(env.window.fixtureExecuted, undefined);
  });
  it('serializes XMLHttpRequest multipart text and file data to a local server', async function () {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({type: req.headers['content-type'], body: Buffer.concat(chunks).toString()}));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = 'http://127.0.0.1:' + server.address().port;
    const dom = new JSDOM('', {url});
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        const form = new dom.window.FormData();
        form.append('note', 'Café 💉 ' + cycle);
        form.append('file', new dom.window.Blob(['fixture-data'], {type: 'text/plain'}), 'fixture.txt');
        const result = await new Promise((resolve, reject) => {
          const xhr = new dom.window.XMLHttpRequest();
          xhr.open('POST', url);
          xhr.timeout = 2000;
          xhr.onload = () => resolve(JSON.parse(xhr.responseText));
          xhr.onerror = xhr.ontimeout = () => reject(new Error('fixture upload failed'));
          xhr.send(form);
        });
        const boundary = result.type.split('boundary=')[1];
        assert.ok(boundary);
        assert.ok(result.body.includes('Café 💉 ' + cycle));
        assert.ok(result.body.includes('filename="fixture.txt"'));
        assert.ok(result.body.includes('fixture-data'));
        assert.ok(result.body.includes('--' + boundary + '--'));
      }
    } finally {
      dom.window.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
});
