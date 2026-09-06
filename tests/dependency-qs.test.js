'use strict';

const assert = require('assert');
const {createRequire} = require('module');
const fromRequest = createRequire(require.resolve('request'));
const fromExpress = createRequire(require.resolve('express'));
const Querystring = fromRequest('./lib/querystring').Querystring;

function requestQuery(options) {
  const query = new Querystring({});
  query.init(options || {});
  return query;
}

describe('query parser consumer regressions', function () {
  for (const [name, qs] of [['Express', fromExpress('qs')], ['request', fromRequest('qs')]]) {
    it(name + ' safely serializes a non-callable constructor.isBuffer', function () {
      const input = JSON.parse('{"value":{"constructor":{"isBuffer":true},"notes":"Fish & Chips"}}');
      const output = qs.stringify(input);
      assert.ok(output.includes('notes%5D=Fish%20%26%20Chips'));
      assert.strictEqual({}.isBuffer, undefined);
    });

    it(name + ' enforces explicit comma-array limits for bracket groups', function () {
      assert.throws(() => qs.parse('values[]=1,2,3', {
        comma: true, arrayLimit: 2, throwOnLimitExceeded: true
      }), RangeError);
      assert.deepStrictEqual(qs.parse('values[]=1,2', {
        comma: true, arrayLimit: 2, throwOnLimitExceeded: true
      }), {values: [['1', '2']]});
    });
  }

  it('request serializes mixed nullable comma values without throwing', function () {
    const query = requestQuery({qsStringifyOptions: {arrayFormat: 'comma', encodeValuesOnly: true}});
    assert.strictEqual(query.stringify({values: ['one', null, undefined, 'two']}), 'values=one,,,two');
  });

  it('request preserves nested filters, unicode, plus signs and array values', function () {
    const query = requestQuery();
    const input = {find: {date: {$gte: '1700000000000'}, device: {$in: ['a+b', 'café']}}, count: '100'};
    assert.deepStrictEqual(query.parse(query.stringify(input)), input);
  });

  it('request preserves its explicit native-querystring mode', function () {
    const query = requestQuery({useQuerystring: true});
    assert.strictEqual(query.stringify({notes: "Fish & Chips!", value: ['1', '2']}),
      'notes=Fish%20%26%20Chips%21&value=1&value=2');
  });
});
