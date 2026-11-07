'use strict';
require('should');

// Runs alarmStorage against a real MongoDB, so the aggregation-pipeline upsert
// and the TTL index are exercised by the database and not by a stand-in.
// Skipped when no connection string is configured.
var uri = process.env.STORAGE_URI || process.env.MONGO_CONNECTION || process.env.MONGO ||
  process.env.MONGODB_URI;

(uri ? describe : describe.skip)('alarmStorage against MongoDB', function () {
  this.timeout(30000);
  var MIN = 60 * 1000;
  var client, db, storage, collectionName;

  before(async function () {
    var MongoClient = require('mongodb').MongoClient;
    client = await MongoClient.connect(uri);
    db = client.db();
    collectionName = 'alarmsnooze_test_' + process.pid + '_' + Date.now();
    var ctx = { store: { collection: function (name) { return db.collection(name); } } };
    storage = require('../lib/storage/alarmStorage')(ctx, { alarmsnooze_collection: collectionName });
  });

  after(async function () {
    if (db) await db.collection(collectionName).drop().catch(function () {});
    if (client) await client.close();
  });

  it('reads nothing before any ack', async function () {
    var doc = await storage.getSnooze(2, 'default');
    (doc === null).should.equal(true);
  });

  it('a first setSnooze inserts the document keyed by level-group', async function () {
    var now = Date.now();
    await storage.setSnooze(2, undefined, now, 60 * MIN);
    var doc = await storage.getSnooze(2, 'default');
    doc._id.should.equal('2-default');
    doc.level.should.equal(2);
    doc.group.should.equal('default');
    doc.silenceTime.should.equal(60 * MIN);
    doc.lastAckTime.should.equal(now);
    doc.expiresAt.getTime().should.equal(now + 60 * MIN);
  });

  it('a shorter snooze does not replace a longer one', async function () {
    await storage.setSnooze(2, 'default', Date.now(), 5 * MIN);
    var doc = await storage.getSnooze(2, 'default');
    doc.silenceTime.should.equal(60 * MIN);
  });

  it('a longer snooze replaces a shorter one, all three fields together', async function () {
    var later = Date.now() + 1000;
    await storage.setSnooze(2, 'default', later, 120 * MIN);
    var doc = await storage.getSnooze(2, 'default');
    doc.silenceTime.should.equal(120 * MIN);
    doc.lastAckTime.should.equal(later);
    doc.expiresAt.getTime().should.equal(later + 120 * MIN);
  });

  it('getSnooze ignores a document that has already expired', async function () {
    var now = Date.now();
    await db.collection(collectionName).insertOne({
      _id: '1-old', level: 1, group: 'old', lastAckTime: now - 10 * MIN,
      silenceTime: MIN, expiresAt: new Date(now - 9 * MIN)
    });
    var doc = await storage.getSnooze(1, 'old');
    (doc === null).should.equal(true);
  });

  it('ensureIndexes creates the TTL index and can run twice', async function () {
    await storage.ensureIndexes();
    await storage.ensureIndexes();
    var indexes = await db.collection(collectionName).indexes();
    var ttl = indexes.filter(function (index) { return index.key.expiresAt === 1; });
    ttl.length.should.equal(1);
    ttl[0].expireAfterSeconds.should.equal(0);
  });
});
