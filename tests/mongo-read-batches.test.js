'use strict';

const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {MongoClient, ObjectId} = require('mongodb');
const findMany = require('../lib/api3/storage/mongoCollection/find').findMany;

// Exercise real application reads and wire replies: a version bump must not
// silently turn a month/report read into one large continuation batch.
describe('MongoDB application read batches', function () {
  this.timeout(15000);
  const collectionName = 'read_batches_' + randomUUID().replaceAll('-', '');
  let client, db, col, ctx, docs;
  const batches = [];
  const opts = count => ({find: {
    date: {$gte: 1700000000000},
    created_at: {$gte: '2000-01-01T00:00:00.000Z'},
    startDate: {$gte: '2000-01-01T00:00:00.000Z'}
  }, ...(count ? {count} : {})});

  before(async function () {
    client = new MongoClient(process.env.CUSTOMCONNSTR_mongo || 'mongodb://127.0.0.1:27017/test', {monitorCommands:true});
    await client.connect();
    db = client.db();
    col = db.collection(collectionName);
    ctx = {store:db};
    client.on('commandSucceeded', event => {
      const cursor = event.reply.cursor;
      if (['find', 'getMore'].includes(event.commandName) && cursor?.ns === db.databaseName + '.' + collectionName) {
        batches.push((cursor.firstBatch || cursor.nextBatch).length);
      }
    });
    docs = Array.from({length:2501}, (_, i) => ({
      _id:new ObjectId(i.toString(16).padStart(24, '0')),
      date:1700000000000 + i * 300000,
      created_at:new Date(1700000000000 + i * 300000).toISOString(),
      startDate:new Date(1700000000000 + i * 300000).toISOString(),
      type:'food', sgv:80 + i % 180, position:i
    }));
    await col.insertMany(docs);
    await col.createIndex({date:-1});
  });

  after(async function () {
    try {if (col) await col.drop();} finally {if (client) await client.close();}
  });
  beforeEach(function () {batches.length = 0;});

  function verify(rows, count, descending = true, normalized = false) {
    assert.equal(rows.length, count);
    assert.equal(new Set(rows.map(row => normalized ? row.identifier : row._id.toHexString())).size, count);
    if (descending) rows.forEach((row, i) => {
      assert.equal(row.date, docs[2500-i].date);
      assert.equal(row.sgv, docs[2500-i].sgv);
    });
    assert.equal(batches.reduce((a,b) => a+b, 0), count);
    assert(batches.length >= 2, 'Fixture must cross a batch boundary');
    assert(batches.every(n => n <= 1000), 'No returned batch may exceed 1,000 documents: ' + batches);
  }

  for (const name of ['entries', 'treatments', 'activity', 'devicestatus']) {
    it(name + ' preserves sorted full and limited reads across repeated cursors', async function () {
      const env = {[name + '_collection']:collectionName};
      const api = require('../lib/server/' + name)(env, ctx);
      for (const count of [2501, 1500]) {
        batches.length = 0;
        verify(await api.list(opts(count === 2501 ? undefined : count)), count);
      }
    });
  }

  it('profile query preserves ordering and unlimited results', async function () {
    const api = require('../lib/server/profile')(collectionName, ctx);
    verify(await api.list_query(opts()), 2501);
  });

  it('profile list preserves explicitly unlimited results', async function () {
    const api = require('../lib/server/profile')(collectionName, ctx);
    verify(await api.list(undefined, 0), 2501);
  });

  it('food lists retain every result across batches', async function () {
    const api = require('../lib/server/food')({food_collection:collectionName}, ctx);
    for (const method of ['list', 'listregular']) {
      batches.length = 0;
      verify(await api[method](), 2501, false);
    }
  });

  it('quickpicks preserve visibility filtering and position order', async function () {
    const api = require('../lib/server/food')({food_collection:collectionName}, ctx);
    try {
      await col.updateMany({}, {$set:{type:'quickpick', hidden:'false'}});
      await col.updateOne({position:2500}, {$set:{hidden:'true'}});
      const rows = await api.listquickpicks();
      verify(rows, 2500, false);
      rows.forEach((row, i) => assert.equal(row.position, i));
    } finally {
      await col.updateMany({}, {$set:{type:'food'}, $unset:{hidden:''}});
    }
  });

  it('authorization role and subject lists preserve sorted results', async function () {
    // Map both owned role/subject handles to this fixture collection. Queries
    // still execute through real MongoDB cursors and the application adapter.
    const auth = require('../lib/authorization/storage')({authentication_collections_prefix:'fixture_'}, {
      store:{collection:() => col}, settings:{}, moment:require('moment'),
      language:{translate:value => value}
    });
    for (const method of ['listRoles', 'listSubjects']) {
      batches.length = 0;
      verify(await auth[method]({}), 2501);
    }
  });

  it('API v3 preserves sorting, projection, normalization, skip and limit', async function () {
    for (const limit of [2501, 1500]) {
      batches.length = 0;
      const rows = await findMany(col, {filter:{date:{$gte:1700000000000}}, sort:{date:-1}, limit, projection:{date:1,sgv:1}});
      verify(rows, limit, true, true);
      assert(rows.every(row => !('_id' in row) && !('type' in row)));
    }
    batches.length = 0;
    const rows = await findMany(col, {sort:{date:-1}, skip:10, limit:1500, options:{normalize:false}});
    verify(rows, 1500, false);
    assert.equal(rows[0].date, docs[2490].date);
    assert.equal(rows.at(-1).date, docs[991].date);
  });
});
