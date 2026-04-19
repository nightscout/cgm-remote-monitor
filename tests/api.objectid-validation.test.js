'use strict';

var should = require('should');

var objectIdValidation = require('../lib/api/shared/objectid-validation');

describe('API ObjectId validation helper', function () {
  it('accepts missing ids for create-tolerant routes', function () {
    should(objectIdValidation.isValidObjectId(undefined)).be.true();
    should(objectIdValidation.isValidObjectId(null)).be.true();
  });

  it('accepts 24-character hex ids and rejects non-hex values', function () {
    should(objectIdValidation.isValidObjectId('507f1f77bcf86cd799439011')).be.true();
    should(objectIdValidation.isValidObjectId('550e8400-e29b-41d4-a716-446655440000')).be.false();
    should(objectIdValidation.isValidObjectId(123)).be.false();
  });

  it('finds the first invalid id in a batch', function () {
    objectIdValidation.findInvalidId([
      { _id: '507f1f77bcf86cd799439011' },
      { _id: 'invalid-id' },
      { _id: '507f191e810c19729de860ea' }
    ]).should.eql({ index: 1, id: 'invalid-id' });
  });

  it('returns null when all ids are valid or omitted', function () {
    should.not.exist(objectIdValidation.findInvalidId([
      { _id: '507f1f77bcf86cd799439011' },
      {},
      { _id: null }
    ]));
  });
});
