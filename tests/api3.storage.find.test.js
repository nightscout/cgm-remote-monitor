'use strict';

require('should');

const find = require('../lib/api3/storage/mongoCollection/find');
const { ObjectId } = require('mongodb');

describe('API3 mongoCollection find helpers', function () {
  function createStubCursor (observed, docs) {
    return {
      find: function () {
        return this;
      },
      project: function () {
        return this;
      },
      sort: function () {
        return this;
      },
      limit: function (value) {
        observed.limit = value;
        return this;
      },
      skip: function (value) {
        observed.skip = value;
        return this;
      },
      toArray: function () {
        observed.toArrayCalls = (observed.toArrayCalls || 0) + 1;
        return Promise.resolve(docs || []);
      }
    };
  }

  function createStubCollection (observed, docs) {
    return {
      find: function () {
        return createStubCursor(observed, docs);
      }
    };
  }

  it('coerces string limit and skip before calling Mongo', async function () {
    const observed = {};
    const col = createStubCollection(observed);

    const result = await find.findMany(col, {
      filter: [],
      sort: { created_at: -1 },
      limit: '5',
      skip: '2',
      projection: {}
    });

    observed.limit.should.equal(5);
    observed.skip.should.equal(2);
    observed.toArrayCalls.should.equal(1);
    result.should.eql([]);
  });


  it('coerces float-like values to integers before calling Mongo', async function () {
    const observed = {};
    const col = createStubCollection(observed);

    await find.findMany(col, {
      filter: [],
      sort: { created_at: -1 },
      limit: 5.9,
      skip: 2.4,
      projection: {}
    });

    observed.limit.should.equal(5);
    observed.skip.should.equal(2);
  });

  it('normalizes findOne results when using promise-based cursors', async function () {
    const observed = {};
    const docId = new ObjectId();
    const col = createStubCollection(observed, [{ _id: docId, type: 'sgv' }]);

    const result = await find.findOne(col, docId.toString(), {});

    observed.toArrayCalls.should.equal(1);
    result.should.have.length(1);
    result[0].should.have.property('identifier', docId.toString());
    result[0].should.not.have.property('_id');
  });

  it('supports promise-based findOneFilter without normalization when requested', async function () {
    const observed = {};
    const docId = new ObjectId();
    const col = createStubCollection(observed, [{ _id: docId, type: 'mbg' }]);

    const result = await find.findOneFilter(col, { type: 'mbg' }, {}, { normalize: false });

    observed.toArrayCalls.should.equal(1);
    result.should.have.length(1);
    result[0].should.have.property('_id');
    result[0]._id.toString().should.equal(docId.toString());
  });
});
