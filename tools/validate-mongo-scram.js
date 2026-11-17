'use strict';

const assert = require('node:assert/strict');
const {randomBytes} = require('node:crypto');
const {MongoClient} = require('mongodb');

// Run only against the disposable loopback database owned by the runtime probe.
module.exports = async function validateMongoScram(client, mongo, database) {
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(mongo.hostname));
  assert.match(database, /^nightscout_pruned_test_[a-f0-9]+$/);
  const db = client.db(database);
  const username = 'saslprep_probe';
  const prefix = randomBytes(16).toString('hex');
  const password = prefix + 'I\u00ADX';
  let created = false;
  async function authenticate(value, shouldFail = false) {
    const probe = new MongoClient(mongo.href, {
      auth: {username, password: value}, authSource: database,
      authMechanism: 'SCRAM-SHA-256', maxPoolSize: 1,
      serverSelectionTimeoutMS: 5000, socketTimeoutMS: 5000
    });
    try {
      if (shouldFail) {
        await assert.rejects(probe.connect(), {code: 18});
      } else {
        await probe.connect();
        const state = await probe.db(database).command({connectionStatus: 1});
        assert.ok(state.authInfo.authenticatedUsers.some(user => user.user === username && user.db === database));
      }
    } finally {
      await probe.close();
    }
  }
  try {
    await db.command({createUser: username, pwd: password,
      roles: [{role: 'readWrite', db: database}], mechanisms: ['SCRAM-SHA-256']});
    created = true;
    for (let cycle = 0; cycle < 2; cycle++) {
      await authenticate(password);
      await authenticate(prefix + 'IX');
      await authenticate(prefix + 'wrong', true);
    }
  } finally {
    if (created) await db.command({dropUser: username});
  }
  console.log('Pruned runtime: Unicode SCRAM-SHA-256 authentication and wrong-password rejection pass.');
};
