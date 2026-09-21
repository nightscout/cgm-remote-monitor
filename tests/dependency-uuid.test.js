'use strict';

const assert = require('assert');
const {spawnSync} = require('child_process');
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

// Additional reference vectors computed with Python uuid.uuid5 and the same
// 16 namespace bytes; preserve normalization, NUL and long UTF-8 inputs.
vectors.push([{device: "\u00e9", date: 1704067200000}, 'dc84fc61-f0eb-508a-bafb-f4120b3a8717']);
vectors.push([{device: "e\u0301", date: 1704067200000}, 'e6352a83-49bb-5244-ac7b-140f37d56166']);
vectors.push([{device: "\u0000", date: 1704067200000}, 'b7a6cfd2-4f58-56c5-b200-249802fbb978']);
vectors.push([{device: 'x'.repeat(10000), date: 1704067200000}, 'caad421a-319d-5939-a32e-49a5265592ab']);

describe('Persisted UUID v5 identifier compatibility', function () {
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
      assert.match(expected, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
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

  it('retains absent-document and malformed Unicode behavior', function () {
    assert.equal(opTools.calculateIdentifier(null), undefined);
    assert.equal(opTools.calculateIdentifier(undefined), undefined);
    for (const device of ['\ud800', '\udfff', 'before\ud800after']) {
      assert.throws(() => opTools.calculateIdentifier({device, date: 1704067200000}), URIError);
    }
  });
});
