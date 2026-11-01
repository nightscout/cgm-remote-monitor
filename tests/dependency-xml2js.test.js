'use strict';

const assert = require('node:assert');
const xml2js = require('xml2js');

describe('XML test parser compatibility', function () {
  it('preserves renderer-style scalars, repeated elements, Unicode and escaped text', async function () {
    const parser = new xml2js.Parser({explicitArray: false});
    const source = '<result><value>150</value><empty/><note>Café 💉 &lt;script&gt; &amp; text</note>' +
      '<entry id="a">first</entry><entry id="b">second</entry></result>';
    for (let cycle = 0; cycle < 2; cycle++) {
      const data = await parser.parseStringPromise(source);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(data)), {result: {
        value: '150', empty: '', note: 'Café 💉 <script> & text',
        entry: [{_: 'first', $: {id: 'a'}}, {_: 'second', $: {id: 'b'}}]
      }});
    }
  });

  it('preserves prototype-named elements as writable own data without pollution', async function () {
    const data = await xml2js.parseStringPromise(
      '<root><__proto__><polluted>true</polluted></__proto__><constructor>ordinary</constructor></root>',
      {explicitArray: false});
    assert.strictEqual(Object.getPrototypeOf(data.root), null);
    assert(Object.hasOwn(data.root, '__proto__'));
    assert.strictEqual(data.root.__proto__.polluted, 'true');
    assert.strictEqual(data.root.constructor, 'ordinary');
    assert.strictEqual(data.root.polluted, undefined);
    assert.strictEqual(Object.prototype.polluted, undefined);
    data.root.__proto__ = 'updated';
    assert.strictEqual(data.root.__proto__, 'updated');
    assert.strictEqual(Object.getPrototypeOf(data.root), null);
  });

  it('preserves prototype-named attributes without changing the attribute object prototype', async function () {
    const data = await xml2js.parseStringPromise('<root constructor="ordinary"/>');
    assert(Object.hasOwn(data.root.$, 'constructor'));
    assert.strictEqual(data.root.$.constructor, 'ordinary');
    assert.strictEqual(Object.getPrototypeOf(data.root.$), null);
  });

  it('rejects malformed XML and undeclared external entities, then parses a fresh document', async function () {
    const parser = new xml2js.Parser({explicitArray: false});
    for (const source of ['<root><child></root>', '<root>&unknown;</root>',
      '<!DOCTYPE root [<!ENTITY xxe SYSTEM "https://example.invalid/not-requested">]><root>&xxe;</root>']) {
      await assert.rejects(parser.parseStringPromise(source));
      assert.strictEqual((await parser.parseStringPromise('<root>valid</root>')).root, 'valid');
    }
  });
});
