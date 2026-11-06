'use strict';

// Run by tests/test-backends.test.js in a child mocha: one suite of each kind.
const { describeForEachBackend, describeMongoOnly } = require('../support/backends');

describeForEachBackend('an interface suite', function (backend) {
  it('runs against ' + backend.name, function () {});
});

describeMongoOnly('a MongoDB-only suite', 'by nature: fixture for the harness', function () {
  it('runs against mongodb', function () {});
});
