'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const {createRequire} = require('node:module');

describe('Remaining maintained transitive consumers', function () {
  const fromMocha = createRequire(require.resolve('mocha'));
  const serialize = fromMocha('serialize-javascript');

  it('escapes split script end tags while preserving function results', function () {
    const fixture = {
      prefix: function () { return '</script '; },
      suffix: function () { return '><script>fixture</script>'; },
      compare: function (value) { return value < /script/.test('script'); }
    };
    const source = serialize(fixture);
    assert.equal(/<\/script[\t\n\f\r />]/i.test(source), false);
    const restored = vm.runInNewContext('(' + source + ')', {}, {timeout: 1000});
    assert.equal(restored.prefix(), fixture.prefix());
    assert.equal(restored.suffix(), fixture.suffix());
    assert.equal(restored.compare(0), fixture.compare(0));
    assert.equal(restored.compare(2), fixture.compare(2));
  });

  it('rejects non-string URL and RegExp representations without coercing them', function () {
    let coerced = false;
    const nonString = {toString() { coerced = true; return 'fixture'; }};
    const url = new URL('https://fixture.invalid/path');
    url.toString = () => nonString;
    assert.throws(() => serialize(url), /URL.toString\(\) must return a string/);
    const regexp = /fixture/;
    Object.defineProperty(regexp, 'source', {value: nonString});
    assert.throws(() => serialize(regexp), /RegExp.source must be a string/);
    assert.equal(coerced, false);
  });

  it('preserves APNs error formatting, cause and structured metadata', function () {
    const fromApn = createRequire(require.resolve('@parse/node-apn'));
    const VError = fromApn('verror');
    const cause = new Error('fixture connection closed');
    const error = new VError({cause, name: 'FixtureTransportError', info: {status: 503}},
      'request %s failed after %d attempts (%%)', 'α', 2);
    assert.equal(error.message, 'request α failed after 2 attempts (%): fixture connection closed');
    assert.equal(VError.cause(error), cause);
    assert.deepEqual(VError.info(error), {status: 503});
    assert.equal(error.name, 'FixtureTransportError');
  });

  it('retains sanitizer URL filtering through launder and its Day.js dependency', function () {
    const sanitize = require('sanitize-html');
    assert.equal(sanitize('<a href="javascript:fixture()">unsafe</a>'), '<a>unsafe</a>');
    assert.equal(sanitize('<a href="https://example.test/a?x=1&amp;y=2">safe</a>'),
      '<a href="https://example.test/a?x=1&amp;y=2">safe</a>');
    const launder = createRequire(require.resolve('sanitize-html'))('launder')();
    const date = new Date(2024, 1, 29, 13, 5, 9);
    assert.equal(launder.formatDate(date), '2024-02-29');
    assert.equal(launder.formatTime(date), '13:05:09');
  });

  it('lexes webpack module dependencies and every declared export in large sources', async function () {
    const lexer = createRequire(require.resolve('webpack'))('es-module-lexer');
    await lexer.init;
    const source = '/*' + 'x'.repeat(5 * 1024 * 1024) + '*/\n' +
      'export const first = 1, second = 2;\n' +
      'export async function load() { return import(`./fixture.mjs`); }\n' +
      'export const object = { import(a, b) { return a + b; } };';
    const [imports, exports] = lexer.parse(source, 'fixture-large.mjs');
    assert.deepEqual(imports.map(entry => entry.n), ['./fixture.mjs']);
    assert.deepEqual(exports.map(entry => entry.n), ['first', 'second', 'load', 'object']);
  });
});
