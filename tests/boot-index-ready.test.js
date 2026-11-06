'use strict';

const assert = require('node:assert/strict');
const boot = require('../lib/server/bootevent');

// On an empty database, boot asks for its collections and indexes. When boot
// reports ready they must already exist, so the first write after start-up
// does not wait behind them.
describe('Boot index setup on an empty database', function () {
  this.timeout(30000);

  let ctx;

  before(async function () {
    const originalSecret = process.env.API_SECRET;
    process.env.API_SECRET = 'boot index ready test secret';
    try {
      const env = require('../lib/server/env')();
      env.IMPORT_CONFIG = null;
      env.extendedSettings.connect = {};
      env.extendedSettings.bridge = {};
      env.extendedSettings.mmconnect = {};

      const { MongoClient } = require('mongodb');
      const client = await MongoClient.connect(env.storageURI);
      try {
        await client.db().dropDatabase();
      } finally {
        await client.close();
      }

      ctx = await new Promise(resolve => boot(env, require('../lib/language')()).boot(resolve));
      ctx.env = env;
    } finally {
      if (originalSecret === undefined) delete process.env.API_SECRET;
      else process.env.API_SECRET = originalSecret;
    }
  });

  after(function () {
    if (ctx && ctx.bus) ctx.bus.teardown();
  });

  async function indexKeys (name) {
    const indexes = await ctx.store.db.collection(name).indexes();
    return indexes.map(index => JSON.stringify(index.key));
  }

  function keyOf (field) {
    return JSON.stringify(typeof field === 'string' ? { [field]: 1 } : field);
  }

  it('boots without errors', function () {
    assert.deepEqual(ctx.bootErrors, []);
    assert.equal(ctx.runtimeState === 'booted' || ctx.runtimeState === 'loaded', true);
  });

  it('has every data collection index in place when boot reports ready', async function () {
    const expected = [
      [ctx.entries().collectionName, ctx.entries.indexedFields]
      , [ctx.treatments().collectionName, ctx.treatments.indexedFields]
      , [ctx.devicestatus().collectionName, ctx.devicestatus.indexedFields]
      , [ctx.profile().collectionName, ctx.profile.indexedFields]
      , [ctx.food().collectionName, ctx.food.indexedFields]
      , [ctx.activity().collectionName, ctx.activity.indexedFields]
    ];
    for (const [name, fields] of expected) {
      const keys = await indexKeys(name);
      for (const field of fields) {
        assert.ok(keys.includes(keyOf(field)), name + ' is missing index ' + keyOf(field));
      }
    }
  });

  it('has the API v3 indexes in place, including the settings collection', async function () {
    const api3Fields = require('../lib/api3/storage/mongoCollection').indexedFields;
    const names = Object.values(require('../lib/api3/generic/setup').storageColNames(ctx.env));
    assert.equal(names.length, 6);
    for (const name of names) {
      const keys = await indexKeys(name);
      for (const field of api3Fields) {
        assert.ok(keys.includes(keyOf(field)), name + ' is missing index ' + keyOf(field));
      }
    }
  });

  it('has the authorization indexes in place', async function () {
    for (const name of ['auth_roles', 'auth_subjects']) {
      assert.ok((await indexKeys(name)).includes(keyOf('name')), name + ' is missing its name index');
    }
  });

  it('has no index build still running for this database', async function () {
    const ops = await ctx.store.client.db('admin').aggregate([
      { $currentOp: { allUsers: true, idleConnections: false } }
      , { $match: { 'command.createIndexes': { $exists: true }, ns: { $regex: '^' + ctx.store.db.databaseName + '\\.' } } }
    ]).toArray();
    assert.deepEqual(ops.map(op => op.ns), []);
  });
});
