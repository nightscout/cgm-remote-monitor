'use strict';

require('should');

const { ObjectId } = require('mongodb');
const utils = require('../lib/api3/storage/mongoCollection/utils');

describe('API3 mongoCollection selector helpers', function () {
  it('treats an object-shaped identifier as a literal value', function () {
    const identifier = { $ne: null };

    const filter = utils.filterForOne(identifier);

    filter.should.eql({
      $or: [
        { identifier: { $eq: identifier } }
      ]
    });
  });

  it('uses literal equality for filterForOne legacy ObjectId matching', function () {
    const identifier = '507f1f77bcf86cd799439011';

    const filter = utils.filterForOne(identifier);

    filter.$or[0].should.eql({ identifier: { $eq: identifier } });
    filter.$or[1]._id.should.have.property('$eq');
    filter.$or[1]._id.$eq.should.be.instanceof(ObjectId);
    filter.$or[1]._id.$eq.toString().should.equal(identifier);
  });

  it('uses literal equality for both identifier and legacy ObjectId matching', function () {
    const identifier = '507f1f77bcf86cd799439011';

    const filter = utils.identifyingFilter(identifier);

    filter.$or[0].should.eql({ identifier: { $eq: identifier } });
    filter.$or[1].identifier.should.eql({ $exists: false });
    filter.$or[1]._id.should.have.property('$eq');
    filter.$or[1]._id.$eq.should.be.instanceof(ObjectId);
    filter.$or[1]._id.$eq.toString().should.equal(identifier);
  });

  it('treats operator-shaped fallback values as literal data', function () {
    const createdAt = { $ne: null };
    const eventType = { $regex: '.*' };

    const filter = utils.identifyingFilter(null, {
      created_at: createdAt,
      eventType
    }, ['created_at', 'eventType']);

    filter.should.eql({
      $or: [
        {
          $and: [
            { created_at: { $eq: createdAt } },
            { eventType: { $eq: eventType } },
            { identifier: { $exists: false } }
          ]
        }
      ]
    });
  });
});
