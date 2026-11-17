'use strict';

// Compat card B (maintainer 2026-10-31) with release 2's WriteResult (Q-A):
// a re-send that REPLACES a stored record is an update, so WriteResult.updated
// names the stored _id of each record replaced, on API v1 / in-process
// ('v1/internal') and the socket, whose replaces are upserts release 2 leaves
// unresolved. The _ids come from the items whose outcome is `replaced`: no
// resolve, no cap, never null. `updated` is [ ] when a replace matched a
// record and wrote nothing; it stays absent for a write that replaced none.
// items[] keeps one slot per input, and the D-EVENT record still carries the
// item.
//
// Skipped without a database, like tests/write-intent.release2.test.js.
// Synthetic values only.

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { ObjectId } = require('mongodb');

const writeIntent = require('../lib/storage/write-intent');
const MongoCollection = require('../lib/api3/storage/mongoCollection');

const mongoUrl = process.env.CUSTOMCONNSTR_mongo;

(mongoUrl ? describe : describe.skip)('compat card B: a replace is an update (WriteResult.updated)', function ( ) {
  this.timeout(30000);
  const physical = 'wirepl_' + randomUUID().replace(/-/g, '');
  let client, db, raw, bus;

  function storage (logical, source) {
    const ctx = { store: { collection: name => db.collection(name), db, ensureIndexes: ( ) => { } }, bus };
    return new MongoCollection(ctx, { }, physical, logical, [ ], { source: source });
  }
  function step (name, source) {
    return writeIntent.forCollectionIntent(storage(name, source), name, source, { env: { uuidHandling: true }, bus });
  }
  const hex = ids => (Array.isArray(ids) ? ids : [ ]).map(id => String(id)).sort();
  const at = minutes => new Date(Date.UTC(2019, 4, 12, 7, minutes)).toISOString();

  before(async function ( ) {
    const { MongoClient } = require('mongodb');
    client = new MongoClient(mongoUrl);
    await client.connect();
    db = client.db();
    raw = db.collection(physical);
  });

  beforeEach(async function ( ) {
    await raw.deleteMany({ });
    bus = new EventEmitter();
  });

  after(async function ( ) {
    try { if (raw) await raw.drop(); } finally { if (client) await client.close(); }
  });

  describe('API v1 and in-process (v1/internal)', function ( ) {

    it('food: a re-send matched by identifier names the record it replaced', async function ( ) {
      const { insertedId } = await raw.insertOne({ type: 'food', name: 'apple', carbs: 10, identifier: 'rp-food', kept: 1 });
      const written = await step('food', 'v1/internal').write({ op: 'create', docs: [{ type: 'food', name: 'apple', carbs: 12, identifier: 'rp-food' }] });
      assert.deepEqual(written.items.map(i => i.outcome), ['replaced']);
      assert.deepEqual(hex(written.updated), hex([insertedId]));
    });

    it('food: a re-send by the 24-hex string form of a stored ObjectId _id names the stored _id', async function ( ) {
      const id = new ObjectId();
      await raw.insertOne({ _id: id, type: 'food', name: 'pear', carbs: 10 });
      const written = await step('food', 'v1/internal').write({ op: 'create', docs: [{ _id: id.toHexString(), type: 'food', name: 'pear', carbs: 11 }] });
      assert.deepEqual(written.items.map(i => i.outcome), ['replaced']);
      assert.deepEqual(hex(written.updated), hex([id]));
      assert(written.updated.every(u => u instanceof ObjectId), 'the stored form, an ObjectId');
    });

    it('a batch names each record replaced and keeps one item per input', async function ( ) {
      const a = (await raw.insertOne({ type: 'food', name: 'a', identifier: 'rp-a' })).insertedId;
      const b = (await raw.insertOne({ type: 'food', name: 'b', identifier: 'rp-b' })).insertedId;
      const written = await step('food', 'v1/internal').write({ op: 'create', docs: [
        { type: 'food', name: 'a', identifier: 'rp-a', carbs: 1 }, { type: 'food', name: 'new', carbs: 2 }
        , { type: 'food', name: 'b', identifier: 'rp-b', carbs: 3 }] });
      assert.deepEqual(written.items.map(i => i.outcome), ['replaced', 'inserted', 'replaced']);
      assert.deepEqual(hex(written.updated), hex([a, b]));
    });

    it('device status: a re-send by identifier names the status it replaced', async function ( ) {
      const { insertedId } = await raw.insertOne({ device: 'rp', created_at: at(0), identifier: 'rp-ds', uploaderBattery: 50 });
      const written = await step('devicestatus', 'v1/internal').write({ op: 'create', docs: [{ device: 'rp', created_at: at(0), identifier: 'rp-ds', uploaderBattery: 60 }] });
      assert.deepEqual(written.items.map(i => i.outcome), ['replaced']);
      assert.deepEqual(hex(written.updated), hex([insertedId]));
    });

    it('profile: a re-send matched by identifier names the profile it replaced', async function ( ) {
      const { insertedId } = await raw.insertOne({ defaultProfile: 'rp', startDate: at(0), identifier: 'rp-p', units: 'mg/dl', store: { rp: { dia: 3 } } });
      const written = await step('profile', 'v1/internal').write({ op: 'create', docs: [{ defaultProfile: 'rp', startDate: at(0), identifier: 'rp-p', store: { rp: { dia: 4 } } }] });
      assert.deepEqual(written.items.map(i => i.outcome), ['replaced']);
      assert.deepEqual(hex(written.updated), hex([insertedId]));
    });

    it('profile: a replace that matched and wrote nothing (the same profile again) answers updated [ ]', async function ( ) {
      const doc = { defaultProfile: 'rp', startDate: at(0), identifier: 'rp-same', units: 'mg/dl', store: { rp: { dia: 3 } } };
      await raw.insertOne(Object.assign({ }, doc));
      const written = await step('profile', 'v1/internal').write({ op: 'create', docs: [Object.assign({ }, doc)] });
      assert.deepEqual(written.items.map(i => i.outcome), ['unchanged']);
      assert.deepStrictEqual(written.updated, [ ]);
    });

    it('a create that replaced nothing leaves updated absent', async function ( ) {
      const written = await step('food', 'v1/internal').write({ op: 'create', docs: [{ type: 'food', name: 'fresh' }] });
      assert.equal(Object.prototype.hasOwnProperty.call(written, 'updated'), false);
    });
  });

  describe('the socket', function ( ) {

    it('entries: a dbAdd matched by identifier names the record it replaced', async function ( ) {
      const { insertedId } = await raw.insertOne({ type: 'sgv', sgv: 100, date: 1, identifier: 'rp-e' });
      const written = await step('entries', 'socket').write({ op: 'create', docs: [{ type: 'sgv', sgv: 101, date: 1, identifier: 'rp-e' }] });
      assert.deepEqual(written.items.map(i => i.outcome), ['replaced']);
      assert.deepEqual(hex(written.updated), hex([insertedId]));
    });

    it('profile: an exact match on startDate names the profile it replaced', async function ( ) {
      const { insertedId } = await raw.insertOne({ defaultProfile: 'rp', startDate: at(5), units: 'mg/dl', store: { } });
      const written = await step('profile', 'socket').write({ op: 'create', docs: [{ defaultProfile: 'rp', startDate: at(5), units: 'mmol', store: { } }] });
      assert.deepEqual(written.items.map(i => i.outcome), ['replaced']);
      assert.deepEqual(hex(written.updated), hex([insertedId]));
    });

    it('treatments: a UUID sent as _id (BF-225 C) names the stored record, not the UUID', async function ( ) {
      const uuid = randomUUID();
      const { insertedId } = await raw.insertOne({ eventType: 'Temporary Override', created_at: at(10), identifier: uuid, duration: 30 });
      const written = await step('treatments', 'socket').write({ op: 'create', docs: [{ _id: uuid, eventType: 'Temporary Override', created_at: at(10), duration: 15 }] });
      assert.deepEqual(written.items.map(i => i.outcome), ['replaced']);
      assert.deepEqual(hex(written.updated), hex([insertedId]));
    });

    it('device status: a dbAdd matched by identifier names the status it replaced', async function ( ) {
      const { insertedId } = await raw.insertOne({ device: 'rp', created_at: at(20), identifier: 'rp-sds', uploaderBattery: 50 });
      const written = await step('devicestatus', 'socket').write({ op: 'create', docs: [{ device: 'rp', created_at: at(21), identifier: 'rp-sds' }] });
      assert.deepEqual(written.items.map(i => i.outcome), ['replaced']);
      assert.deepEqual(hex(written.updated), hex([insertedId]));
    });
  });

  it('the D-EVENT record still carries the item: the stored _id, the identifier, `replaced`, once', async function ( ) {
    const { insertedId } = await raw.insertOne({ type: 'food', name: 'apple', identifier: 'rp-ev' });
    const seen = [ ];
    bus.on(writeIntent.INTENT_EVENT, e => seen.push(e));
    await step('food', 'v1/internal').write({ op: 'create', docs: [{ type: 'food', name: 'apple', carbs: 1, identifier: 'rp-ev' }] });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].records.map(r => [String(r._id), r.identifier, r.outcome]), [[String(insertedId), 'rp-ev', 'replaced']]);
    assert.equal(seen[0].collapsed, false);
  });
});
