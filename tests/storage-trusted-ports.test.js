'use strict';

const assert = require('node:assert/strict');
const reads = require('../lib/server/storage-reads');

describe('trusted legacy storage ports', function () {
  it('uses the same logical source for reads and intents without a Mongo handle', function () {
    const calls = [];
    const step = { write () {} };
    const storage = { findFiltered () {} };
    const options = { env: {}, bus: {} };
    const ctx = { storagePorts: { resolve (selection) {
      calls.push(selection);
      return { storage, intentFactory (actual) { assert.equal(actual, options); return step; } };
    } } };
    assert.equal(reads.collection(ctx, {}, 'ignored', 'entries'), storage);
    assert.equal(reads.intent(ctx, 'entries', 'v1/internal', options, () => {
      throw new Error('Mongo fallback reached');
    }), step);
    assert.deepEqual(calls, [
      { logical: 'entries', source: 'v1/internal' },
      { logical: 'entries', source: 'v1/internal' }
    ]);
  });

  it('refuses incomplete tenant ports instead of falling back', function () {
    for (const storagePorts of [null, {}, { resolve: () => null },
      { resolve: () => ({ storage: { findFiltered () {} } }) }]) {
      assert.throws(() => reads.collection({ storagePorts }, {}, 'entries', 'entries'), TypeError);
      assert.throws(() => reads.intent({ storagePorts }, 'entries', 'v1/internal', {}, () => {
        throw new Error('Mongo fallback reached');
      }), TypeError);
    }
  });

  it('retains the single application intent factory when injection is absent', function () {
    const expected = {};
    assert.equal(reads.intent({}, 'entries', 'v1/internal', {}, () => expected), expected);
  });
});
