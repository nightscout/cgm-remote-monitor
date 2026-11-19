'use strict';
// Actual cohort handlers/coordinator with recording transport and role contexts.
// No native PG, process deployment, UDS listener or credential-custody evidence.
const assert=require('node:assert/strict');

describe('Private role health client', function () {
  it('exposes the named health operation only', function () {
    const client = require('../lib/server/internal-api/clients').roleHealth({socketPath:'/synthetic/health.sock', maxBytes:1000, timeoutMs:1000});
    assert.deepEqual(Object.keys(client), ['getStatus']);
    assert.equal(client.constructor, undefined);
  });
});
