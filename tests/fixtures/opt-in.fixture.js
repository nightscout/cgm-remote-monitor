'use strict';

const assert = require('node:assert/strict');
const { optInSuite } = require('../support/opt-in');

optInSuite(process.env.NS_OPT_IN_FIXTURE === '1', 'NS_OPT_IN_FIXTURE=1')('opt-in lab', function () {
  before(function () { assert.equal(process.env.NS_OPT_IN_FIXTURE, '1'); });
  if (process.env.NS_OPT_IN_EMPTY !== '1') {
    describe('nested suite', function () {
      const test = process.env.NS_OPT_IN_SKIP === '1' ? it.skip : it;
      test('lab behavior', function () { assert.notEqual(process.env.NS_OPT_IN_FAIL, '1'); });
    });
  }
});
