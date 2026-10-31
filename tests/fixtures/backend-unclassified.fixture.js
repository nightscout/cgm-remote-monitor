'use strict';

// Run by tests/test-backends.test.js in a child mocha under a selection without
// mongodb: a file outside the census that tries to reach MongoDB, and whose own
// test passes anyway. The run must still fail, naming this file.
const { MongoClient } = require('mongodb');

describe('a file outside the census', function () {
  before(async function () {
    const client = new MongoClient('mongodb://127.0.0.1:9/never', { serverSelectionTimeoutMS: 200 });
    await client.connect().catch(() => {});
  });

  it('passes without the database', function () {});
});
