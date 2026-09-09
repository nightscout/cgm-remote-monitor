'use strict';

const assert = require('assert');
const { createRequire } = require('module');
const uri = require('fast-uri');

describe('fast-uri dependency security and compatibility', function () {
  const malformed = [
    'http://untrusted.example\\@trusted.example/',
    'http:/\\untrusted.example/',
    'https:/\t/untrusted.example/',
    'http://[::not-valid]/private',
    'http://user@[@127.0.0.1:8123/admin',
    'http://user@prefix]@127.0.0.1:8123/admin',
    'http://example.test:80abc/path',
    'http://example.test:65536/',
    'x://example.test/path%GG'
  ];

  malformed.forEach(function (input) {
    it('rejects malformed URI ' + JSON.stringify(input), function () {
      assert.ok(uri.parse(input).error);
      assert.strictEqual(uri.normalize(input), input);
      assert.strictEqual(uri.equal(input, input), false);
      assert.throws(() => uri.resolve('https://example.test/base', input));
    });
  });

  ['@untrusted.example', '8080/path', '8080#fragment', 1.5].forEach(function (port) {
    it('rejects authority injection through port ' + JSON.stringify(port), function () {
      assert.throws(() => uri.serialize({ scheme: 'http', host: 'trusted.example', port }), /port is malformed/i);
    });
  });

  it('preserves the supplied host when serializing userinfo delimiters', function () {
    const result = uri.serialize({ scheme: 'https', userinfo: 'name@/evil.example', host: 'trusted.example', path: '/' });
    assert.strictEqual(new URL(result).hostname, 'trusted.example');
    assert.strictEqual(uri.parse(result).host, 'trusted.example');
  });

  it('does not repeatedly decode an encoded host delimiter', function () {
    const input = 'http://trusted.example%2540untrusted.example/';
    for (let pass = 0; pass < 2; pass++) {
      assert.strictEqual(uri.normalize(input), input);
      assert.strictEqual(uri.parse(uri.normalize(input)).host, 'trusted.example%2540untrusted.example');
    }
  });

  it('canonicalizes a scheme-relative Unicode hostname consistently', function () {
    const resolved = uri.resolve('https://trusted.example/base', '//127。0。0。1/path');
    assert.strictEqual(resolved, 'https://127.0.0.1/path');
    assert.strictEqual(uri.parse(resolved).host, new URL(resolved).hostname);
  });

  it('preserves case-sensitive paths and queries while folding host case', function () {
    assert.strictEqual(uri.equal('https://EXAMPLE.test/Path', 'https://example.test/Path'), true);
    assert.strictEqual(uri.equal('https://example.test/Path', 'https://example.test/path'), false);
    assert.strictEqual(uri.equal('https://example.test/?token=ABC', 'https://example.test/?token=abc'), false);
  });

  [
    'https://example.test:8443/a%2Fb?x=a/b?c&y=%23#fragment',
    'ws://example.test/chat?a?b',
    'wss://example.test/chat?a?b',
    'urn:example:allowed/child'
  ].forEach(function (input) {
    it('round-trips valid URI ' + input, function () {
      assert.strictEqual(uri.parse(input).error, undefined);
      assert.strictEqual(uri.serialize(uri.parse(input)), input);
      assert.strictEqual(uri.normalize(uri.normalize(input)), input);
    });
  });

  it('preserves encoded JSON-pointer fragments and relative resolution', function () {
    assert.strictEqual(uri.resolve('https://example.test/schemas/main.json', '../common.json#/$defs/a~1b'),
      'https://example.test/common.json#/$defs/a~1b');
  });
});

// Resolve Ajv through each installed consumer, rather than testing the root
// Ajv 6 package (which uses uri-js and would not exercise this upgrade).
describe('fast-uri compatibility with installed Ajv consumers', function () {
  ['webpack', 'webpack-dev-middleware', 'terser-webpack-plugin', 'ajv-formats', 'table'].forEach(function (consumer) {
    it(consumer + ' resolves external and escaped local schema references', function () {
      const requireConsumer = createRequire(require.resolve(consumer));
      const Ajv = requireConsumer('ajv');
      const requireAjv = createRequire(requireConsumer.resolve('ajv'));
      assert.strictEqual(requireAjv('fast-uri'), uri);
      const ajv = new Ajv({ strict: true });
      ajv.addSchema({
        $id: 'https://schemas.example.test/common.json',
        $defs: { 'glucose/value': { type: 'integer', minimum: 1 }, 'a~b': { type: 'string' } }
      });
      const validate = ajv.compile({
        $id: 'https://schemas.example.test/nested/entry.json',
        type: 'object', required: ['sgv', 'note'], additionalProperties: false,
        properties: {
          sgv: { $ref: '../common.json#/$defs/glucose~1value' },
          note: { $ref: '../common.json#/$defs/a~0b' }
        }
      });
      assert.strictEqual(validate({ sgv: 123, note: 'Fish & Chips' }), true);
      assert.strictEqual(validate({ sgv: '123', note: 'Fish & Chips' }), false);
      assert.strictEqual(validate({ sgv: 0, note: 'Fish & Chips' }), false);
      assert.strictEqual(validate({ sgv: 123, note: 'Café 💉' }), true);
    });

    it(consumer + ' keeps case-sensitive schema IDs distinct', function () {
      const Ajv = createRequire(require.resolve(consumer))('ajv');
      const ajv = new Ajv({ strict: true });
      ajv.addSchema({ $id: 'https://schemas.example.test/Value', type: 'integer' });
      ajv.addSchema({ $id: 'https://schemas.example.test/value', type: 'string' });
      const upper = ajv.compile({ $ref: 'https://schemas.example.test/Value' });
      const lower = ajv.compile({ $ref: 'https://schemas.example.test/value' });
      assert.strictEqual(upper(123), true);
      assert.strictEqual(upper('123'), false);
      assert.strictEqual(lower('123'), true);
      assert.strictEqual(lower(123), false);
    });
  });
});
