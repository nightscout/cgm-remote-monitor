'use strict';

const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const fromDriver = createRequire(require.resolve('mongodb'));
const {saslprep} = fromDriver('@mongodb-js/saslprep');

describe('MongoDB password preparation', function () {
  const vectors = [
    ['I\u00ADX', 'IX'], ['user', 'user'], ['USER', 'USER'],
    ['\u00AA', 'a'], ['\u2168', 'IX'], ['a\u00A0b', 'a b']
  ];
  vectors.forEach(([input, expected], index) => {
    it('preserves RFC 4013 normalization vector ' + index, function () {
      assert.equal(saslprep(input), expected);
      assert.equal(saslprep(expected), expected);
    });
  });
  ['\u0007', '\u0627a\u0628', '\u0627\u0031', '\u0221'].forEach((value, index) => {
    it('rejects prohibited, invalid bidirectional or unassigned input ' + index, function () {
      assert.throws(() => saslprep(value));
    });
  });
});
