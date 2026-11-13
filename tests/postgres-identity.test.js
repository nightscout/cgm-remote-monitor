'use strict';

const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const { encodeDocument, decodeDocument } = require('../lib/storage/postgres-identity');
const idForms = require('../lib/server/object-id-forms');

describe('PostgreSQL document identity encoding', function () {
  it('round-trips both current id forms through JSON without collapsing their kinds', function () {
    const hex = '1234567890abcdef12345678';
    const encoded = idForms.idForms(hex).map(_id => encodeDocument({ _id, identifier: 'same', sgv: 100 }));
    assert.deepEqual(encoded.map(row => [row.id_kind, row.doc._id]), [['objectid', hex], ['string', hex]]);
    const restored = encoded.map(row => decodeDocument(JSON.parse(JSON.stringify(row))));
    assert.ok(restored[0]._id instanceof ObjectId);
    assert.equal(restored[0]._id.toHexString(), hex);
    assert.equal(restored[1]._id, hex);
    assert.deepEqual(restored.map(doc => [doc.identifier, doc.sgv]), [['same', 100], ['same', 100]]);
  });

  it('preserves string spelling, custom identifiers and both input documents', function () {
    for (const id of ['1234567890ABCDEF12345678', 'custom-id', '11111111-1111-4111-8111-111111111111']) {
      const doc = Object.freeze({ _id: id, sgv: 101 });
      assert.deepEqual(decodeDocument(encodeDocument(doc)), doc);
    }
    const doc = Object.freeze({ _id: new ObjectId(), sgv: 102 });
    const encoded = encodeDocument(doc);
    assert.ok(doc._id instanceof ObjectId);
    const before = JSON.stringify(encoded);
    decodeDocument(encoded);
    assert.equal(JSON.stringify(encoded), before);
  });

  it('refuses unsupported or absent identities rather than inventing or coercing keys', function () {
    for (const _id of [undefined, null, '', 1, true, {}, { $oid: '1234567890abcdef12345678' }]) {
      assert.throws(() => encodeDocument({ _id }), /nonempty string or ObjectId/);
    }
    for (const doc of [null, undefined, [], 'document']) {
      assert.throws(() => encodeDocument(doc), /requires a document/);
    }
  });

  it('refuses corrupt stored kinds and encodings instead of returning a success-shaped record', function () {
    for (const row of [
      { doc: { _id: 'abc' } }, { id_kind: 'unknown', doc: { _id: 'abc' } },
      { id_kind: 'objectid', doc: { _id: 'abc' } },
      { id_kind: 'objectid', doc: { _id: '1234567890ABCDEF12345678' } },
      { id_kind: 'string', doc: { _id: null } }, null
    ]) {
      assert.throws(() => decodeDocument(row), TypeError);
    }
  });
});
