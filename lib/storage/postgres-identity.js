'use strict';

const { ObjectId } = require('mongodb');
const HEX = /^[0-9a-f]{24}$/;

function documentId (doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new TypeError('PostgreSQL identity requires a document');
  }
  return doc._id;
}

// Keep the BSON kind outside JSONB: ObjectId.toJSON() and the corresponding
// string are identical JSON, but current lookup/delete rules distinguish them.
function encodeDocument (doc) {
  const id = documentId(doc);
  if (typeof id === 'string' && id.length) {
    return { id_kind: 'string', doc: { ...doc } };
  }
  if (id && id._bsontype === 'ObjectId' && typeof id.toHexString === 'function') {
    const hex = id.toHexString();
    if (typeof hex === 'string' && HEX.test(hex)) {
      return { id_kind: 'objectid', doc: { ...doc, _id: hex } };
    }
  }
  throw new TypeError('PostgreSQL identity requires a nonempty string or ObjectId _id');
}

function decodeDocument (row) {
  const id = documentId(row && row.doc);
  if (typeof id !== 'string' || !id.length) {
    throw new TypeError('PostgreSQL stored identity must be a nonempty string');
  }
  if (row.id_kind === 'string') return { ...row.doc };
  if (row.id_kind === 'objectid' && HEX.test(id)) {
    return { ...row.doc, _id: new ObjectId(id) };
  }
  throw new TypeError('PostgreSQL stored identity kind or ObjectId encoding is invalid');
}

module.exports = { encodeDocument, decodeDocument };
