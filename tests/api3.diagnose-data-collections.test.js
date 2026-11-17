'use strict';

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {MongoClient, ObjectId} = require('mongodb');

describe('Diagnostic CLI configured collections', function () {
  this.timeout(30000);
  let client, db, name, seeded;
  before(async function () {
    const env = require('../lib/server/env')();
    client = new MongoClient(env.storageURI);
    await client.connect();
    db = client.db();
    name = 'diagnose_test_' + new ObjectId().toHexString();
    seeded = {_id: new ObjectId(), app: 'diagnose-collections-test', notes: 'sensitive-test-note',
      eventType: 'Temporary Target', duration: 30, targetBottom: 120, targetTop: 110};
    await db.collection(name).insertOne(seeded);
  });
  after(async function () {
    try { if (db && name) await db.collection(name).drop(); }
    finally { if (client) await client.close(); }
  });

  for (const mode of ['direct', 'azure', 'azure-lower']) {
    it('scans the configured collection for ' + mode + ' settings without changing or leaking records', async function () {
      const env = {...process.env, MONGODB_URI: require('../lib/server/env')().storageURI};
      for (const key of ['MONGO_TREATMENTS_COLLECTION', 'mongo_treatments_collection',
        'CUSTOMCONNSTR_MONGO_TREATMENTS_COLLECTION', 'CUSTOMCONNSTR_mongo_treatments_collection']) delete env[key];
      if (mode === 'direct') env.MONGO_TREATMENTS_COLLECTION = name;
      else {
        env.MONGO_TREATMENTS_COLLECTION = 'diagnostic_decoy';
        env[mode === 'azure' ? 'CUSTOMCONNSTR_MONGO_TREATMENTS_COLLECTION'
          : 'CUSTOMCONNSTR_mongo_treatments_collection'] = name;
      }
      const result = spawnSync(process.execPath, ['scripts/diagnose-data.js', '--limit', '2'],
        {env, encoding: 'utf8', timeout: 10000});
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout).treatments;
      assert.equal(summary.scanned, 1);
      assert.equal(summary.flagged, 1);
      assert.equal(summary.rules['tt-order'], 1);
      assert(!result.stdout.includes('sensitive-test-note'));
      assert(!result.stdout.includes(seeded._id.toHexString()));
      assert(!result.stdout.includes(env.MONGODB_URI));
      assert.deepEqual(await db.collection(name).findOne({_id: seeded._id}), seeded);
    });
  }
});
