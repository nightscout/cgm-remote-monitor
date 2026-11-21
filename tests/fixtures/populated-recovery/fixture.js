'use strict';

const { ObjectId } = require('mongodb');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const HEX = '0123456789abcdef01234567';
function documents () {
  return [
    { tenant: A, doc: { _id: new ObjectId(HEX), date: 1000, source: { app: 'synthetic-recovery' }, extension: { nullable: null, flags: [false, 0, ''], ordered: [3, 1, 2] } } },
    { tenant: A, doc: { _id: HEX, date: 1000, source: { app: 'synthetic-string-twin' }, extension: { ordered: [3, 1, 2] } } },
    { tenant: B, doc: { _id: HEX, date: 1000, source: { app: 'synthetic-foreign' }, extension: { nullable: null, ordered: [2, 1, 3] } } }
  ];
}
const apiRows = () => [
  { _id: 'synthetic-api-first', date: 1000, source: { app: 'synthetic-api' }, extension: { nullable: null, ordered: [3, 1, 2] } },
  { _id: 'synthetic-api-second', date: 2000, isValid: false, extension: { nested: { _id: 'preserve-nested' } } }
];
module.exports = { A, B, HEX, documents, apiRows };
