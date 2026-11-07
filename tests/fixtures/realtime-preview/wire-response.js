'use strict';
// Exact selected private HTTP response JSON boundary, not an ID normalizer.
// Physical decoded BSON records never pass through this function.
function idType (value) {
  if (value === undefined) return { kind: 'absent' };
  if (value === null) return { kind: 'null' };
  if (value?._bsontype === 'ObjectId') return { kind: 'objectid', constructor: value.constructor.name, value: value.toHexString() };
  return { kind: typeof value, constructor: value?.constructor?.name, value: typeof value === 'string' || typeof value === 'number' ? value : undefined };
}
function replyIds (args) {
  return Array.isArray(args) && Array.isArray(args[0]) ? args[0].map((doc, index) => ({ index, id: idType(doc?._id) })) : { shape: typeof args };
}
function encode (raw) { return JSON.parse(JSON.stringify({ replyArgs: raw })).replyArgs; }
function physicalIds (rows) { return rows.map((row, index) => ({ index, id: idType(row._id) })); }
function assertAndRecord (operation, save, verify) {
  try { verify(); } catch (error) {
    operation.assertion = { code: error.code, message: error.message, operator: error.operator,
      actual: error.actual, expected: error.expected,
      inspectedActual: require('node:util').inspect(error.actual, { depth: 20, maxArrayLength: 1000 }),
      inspectedExpected: require('node:util').inspect(error.expected, { depth: 20, maxArrayLength: 1000 }) };
    save(); throw error;
  }
}
module.exports = { encode, idType, replyIds, physicalIds, assertAndRecord };
