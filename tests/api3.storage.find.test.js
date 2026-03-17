'use strict';

require('should');

const find = require('../lib/api3/storage/mongoCollection/find');

describe('API3 mongoCollection findMany', function () {
  function createStubCollection (observed) {
    return {
      find: function () {
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
      project: function () {
        return this;
      },
      toArray: function (callback) {
        callback(null, []);
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
});
