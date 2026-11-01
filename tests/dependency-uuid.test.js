'use strict';

const assert = require('assert');
const {spawnSync} = require('child_process');
const uuid = require('uuid');
const opTools = require('../lib/api3/shared/operationTools');

// Fixed independently using SHA-1(namespace bytes + UTF-8 key), with UUID v5
// version/variant bits. Never derive expected IDs with calculateIdentifier.
const vectors = [
  [{device: 'test-device', date: 1704067200000}, '82029f92-19d9-5c24-8dc9-36516308bb8b'],
  [{device: 'test-device', date: 1704067200000, eventType: 'Correction Bolus'}, '8c59e104-14cf-5bac-90e2-a47e502baaac'],
  [{device: 'test-device', date: 1704067200000, eventType: 'Carb Correction'}, 'c6043a2a-78e9-539b-903c-239aea6d7a0f'],
  [{date: 1704067200000}, '3f7ca9d7-91d1-51ae-8fb9-98a7c2702940'],
  [{device: '泵-🩺', date: 1704067200000, eventType: '餐前'}, '5f03a422-7d06-57b5-9a5a-54d33c8b05a3'],
  [{device: 'test-device', date: 1704067200001}, '311353ac-f7f9-51e8-a39e-04f362cb9593']
];

describe('UUID dependency compatibility', function () {
  it('loads the synchronous API without experimental require(ESM) support', function () {
    const flag = '--no-experimental-require-module';
    const flags = process.allowedNodeEnvironmentFlags.has(flag) ? [flag] : [];
    const script = 'const assert = require("assert"); const op = require(' +
      JSON.stringify(require.resolve('../lib/api3/shared/operationTools')) +
      '); assert.strictEqual(op.calculateIdentifier({device:"test-device",date:1704067200000}),"82029f92-19d9-5c24-8dc9-36516308bb8b");';
    const result = spawnSync(process.execPath, [...flags, '-e', script], {encoding: 'utf8'});
    assert.ifError(result.error);
    assert.strictEqual(result.status, 0, result.stderr);
  });

  for (const [doc, expected] of vectors) {
    it('preserves the persisted identifier ' + expected, function () {
      assert.strictEqual(opTools.calculateIdentifier(doc), expected);
      assert.strictEqual(opTools.calculateIdentifier({...doc}), expected);
      assert.ok(uuid.validate(expected));
      assert.strictEqual(uuid.version(expected), 5);
    });
  }

  it('keeps identifiers stable when non-identity treatment fields change', function () {
    const [doc, expected] = vectors[1];
    assert.strictEqual(opTools.calculateIdentifier({...doc, insulin: 1, notes: 'first'}), expected);
    assert.strictEqual(opTools.calculateIdentifier({...doc, insulin: 2, notes: 'edited', app: 'another app'}), expected);
  });

  it('resolves the same identifier on repeated processing', function () {
    const [original, expected] = vectors[1];
    const doc = {...original};
    opTools.resolveIdentifier(doc);
    assert.strictEqual(doc.identifier, expected);
    opTools.resolveIdentifier(doc);
    assert.strictEqual(doc.identifier, expected);
  });

  it('preserves a caller-supplied identifier on repeated processing', function () {
    const doc = {...vectors[1][0], identifier: 'client-owned-id'};
    const warn = console.warn;
    const log = console.log;
    try {
      console.warn = () => {};
      console.log = () => {};
      opTools.resolveIdentifier(doc);
      opTools.resolveIdentifier(doc);
      assert.strictEqual(doc.identifier, 'client-owned-id');
    } finally {
      console.warn = warn;
      console.log = log;
    }
  });

  it('retains the patched v5 buffer bounds checks without partial writes', function () {
    for (const [length, offset] of [[8, 0], [16, -1], [16, 1]]) {
      const buffer = Buffer.alloc(length, 0xaa);
      assert.throws(() => uuid.v5('fixture', uuid.v5.DNS, buffer, offset), RangeError);
      assert.deepStrictEqual(buffer, Buffer.alloc(length, 0xaa));
    }
  });

  it('writes v5 into a valid buffer without changing adjacent bytes', function () {
    const buffer = Buffer.alloc(20, 0xaa);
    assert.strictEqual(uuid.v5('www.example.com', uuid.v5.DNS, buffer, 2), buffer);
    assert.strictEqual(uuid.stringify(buffer, 2), '2ed6657d-e927-568b-95e1-2665a8aea6a2');
    assert.deepStrictEqual(buffer.subarray(0, 2), Buffer.from([0xaa, 0xaa]));
    assert.deepStrictEqual(buffer.subarray(18), Buffer.from([0xaa, 0xaa]));
  });
});
