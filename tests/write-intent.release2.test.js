'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { ObjectId } = require('mongodb');

const writeIntent = require('../lib/storage/write-intent');
const MongoCollection = require('../lib/api3/storage/mongoCollection');
const MongoCachedCollection = require('../lib/api3/storage/mongoCachedCollection');

// WC-STEP-PATCH release 2 (write-contract Q-A, Q-U; Q9 decided 2026-10-30)
// over a live mongod. Every write by filter is resolved to the _ids it will
// touch inside the write step, written as {filter AND _id in ids}, and named
// in WriteResult.removed / .updated; API v3's cache hears exactly those
// records; over RESOLVE_CAP the write keeps its plain filter and is unnamed
// (null), and the cache reloads. A record that starts to match while a write
// by filter runs is not reached by it (the one behaviour change Q-A decided).
//
// Skipped without a database, like tests/api3.storage.filter-semantics.test.js.
// Synthetic values only.

const mongoUrl = process.env.CUSTOMCONNSTR_mongo;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

(mongoUrl ? describe : describe.skip)('write(intent) release 2: writes by filter resolved to _ids', function ( ) {
  this.timeout(30000);
  const physical = 'wir2_' + randomUUID().replace(/-/g, '');
  let client, db, raw, bus, events;

  const v1Ctx = ( ) => ({ store: { collection: name => db.collection(name), db, ensureIndexes: ( ) => { } }, bus });
  function v1Storage (logical, source) {
    return new MongoCollection(v1Ctx(), { }, physical, logical, [ ], { source: source || 'v1/internal' });
  }
  // API v3's storage as lib/api3/generic/collection.js builds it: the cached
  // wrapper over MongoCollection, with a cache for the collection.
  function v3Storage (logical) {
    const ctx = Object.assign(v1Ctx(), {
      cache: { treatments: [ ], entries: [ ], devicestatus: [ ] },
      ddata: { processRawDataForRuntime: docs => docs }
    });
    return new MongoCachedCollection(ctx, { }, logical, new MongoCollection(ctx, { }, physical, logical, [ ]));
  }
  const updates = ( ) => events.filter(e => e.op === 'update' || e.op === 'remove');
  // A missing name (undefined, null) compares as no names, so a write left
  // unnamed fails on the assertion, not here.
  const hex = ids => (Array.isArray(ids) ? ids : [ ]).map(id => String(id)).sort();

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
    events = [ ];
    bus.on('data-update', e => events.push(e));
  });

  after(async function ( ) {
    try { if (raw) await raw.drop(); } finally { if (client) await client.close(); }
  });

  it('the resolve cap is the fixed constant 1,000', function ( ) {
    assert.equal(writeIntent.RESOLVE_CAP, 1000);
  });

  describe('API v1 delete by query', function ( ) {
    it('names exactly the records it removed and leaves the others', async function ( ) {
      const { insertedIds } = await raw.insertMany([
        { eventType: 'Note', enteredBy: 'r2-a', created_at: '2026-10-31T10:00:00.000Z' },
        { eventType: 'Note', enteredBy: 'r2-a', created_at: '2026-10-31T10:05:00.000Z' },
        { eventType: 'Note', enteredBy: 'r2-b', created_at: '2026-10-31T10:10:00.000Z' }
      ]);
      const written = await writeIntent.forCollectionResolved(v1Storage('treatments'), 'treatments', 'v1/internal', { env: { } })
        .write({ op: 'delete', target: { filter: { enteredBy: 'r2-a' } } });
      assert.deepEqual(hex(written.removed), hex([insertedIds[0], insertedIds[1]]));
      assert.equal(written.adapter.deletedCount, 2);
      assert.equal(written.items[0].outcome, 'deleted');
      assert.deepEqual((await raw.find({ }).toArray()).map(d => d.enteredBy), ['r2-b']);
    });

    it('a delete that matches nothing names nothing (no cache reload)', async function ( ) {
      await raw.insertOne({ eventType: 'Note', enteredBy: 'r2-b' });
      const written = await writeIntent.forCollectionResolved(v1Storage('entries'), 'entries', 'v1/internal', { env: { } })
        .write({ op: 'delete', target: { filter: { enteredBy: 'r2-none' } } });
      assert.deepEqual(written.removed, [ ]);
      assert.equal(written.adapter.deletedCount, 0);
      assert.equal(written.items[0].outcome, 'not-found');
    });

    it('a record inserted between the resolve and the delete is not deleted, and not named (Q-A)', async function ( ) {
      const { insertedId } = await raw.insertOne({ eventType: 'Note', enteredBy: 'r2-race' });
      const storage = v1Storage('treatments');
      const findFiltered = storage.findFiltered;
      let late;
      storage.findFiltered = async function (...args) {
        const found = await findFiltered.apply(this, args);
        // after the resolve read, before the write: a matching insert
        if (!late) late = (await raw.insertOne({ eventType: 'Note', enteredBy: 'r2-race', late: true })).insertedId;
        return found;
      };
      const written = await writeIntent.forCollectionResolved(storage, 'treatments', 'v1/internal', { env: { } })
        .write({ op: 'delete', target: { filter: { enteredBy: 'r2-race' } } });
      assert.deepEqual(hex(written.removed), hex([insertedId]));
      assert.equal(written.adapter.deletedCount, 1);
      const left = await raw.find({ }).toArray();
      assert.deepEqual(left.map(d => String(d._id)), [String(late)]);
    });

    it('over the resolve cap: the plain filter, every match deleted, unnamed (null), so the cache reloads', async function ( ) {
      const docs = [ ];
      for (let i = 0; i <= writeIntent.RESOLVE_CAP; i += 1) docs.push({ type: 'sgv', sgv: 100, device: 'r2-cap', date: i });
      await raw.insertMany(docs);
      const written = await writeIntent.forCollectionResolved(v1Storage('entries'), 'entries', 'v1/internal', { env: { } })
        .write({ op: 'delete', target: { filter: { device: 'r2-cap' } } });
      assert.equal(written.removed, null);
      assert.equal(written.adapter.deletedCount, writeIntent.RESOLVE_CAP + 1);
      assert.equal(await raw.countDocuments({ }), 0);
    });

    it('exactly the cap: resolved and named', async function ( ) {
      const docs = [ ];
      for (let i = 0; i < writeIntent.RESOLVE_CAP; i += 1) docs.push({ type: 'sgv', sgv: 100, device: 'r2-cap', date: i });
      await raw.insertMany(docs);
      const written = await writeIntent.forCollectionResolved(v1Storage('entries'), 'entries', 'v1/internal', { env: { } })
        .write({ op: 'delete', target: { filter: { device: 'r2-cap' } } });
      assert.equal(written.removed.length, writeIntent.RESOLVE_CAP);
    });

    it('a delete by _id names every stored form it removed', async function ( ) {
      const id = new ObjectId();
      await raw.insertMany([{ _id: id, name: 'oid' }, { _id: id.toHexString(), name: 'string' }, { name: 'other' }]);
      const written = await writeIntent.forCollectionResolved(v1Storage('food'), 'food', 'v1/internal', { env: { } })
        .write({ op: 'delete', target: { _id: id.toHexString() } });
      assert.deepEqual(hex(written.removed), hex([id, id.toHexString()]));
      assert.equal(written.adapter.deletedCount, 2);
    });
  });

  describe('socket', function ( ) {
    it('dbUpdate by a 24-hex _id names both stored forms it updated', async function ( ) {
      const id = new ObjectId();
      await raw.insertMany([{ _id: id, eventType: 'Note', notes: 'a', created_at: '2026-10-31T10:00:00.000Z' }
        , { _id: id.toHexString(), eventType: 'Note', notes: 'a', created_at: '2026-10-31T10:00:01.000Z' }
        , { eventType: 'Note', notes: 'a' }]);
      const step = writeIntent.forCollectionResolved(v1Storage('treatments', 'socket'), 'treatments', 'socket', { env: { } });
      const written = await step.write(step.plan({ op: 'update', form: 'merge', target: { _id: id.toHexString() }, fields: { notes: 'b' } }));
      assert.deepEqual(hex(written.updated), hex([id, id.toHexString()]));
      assert.equal(await raw.countDocuments({ notes: 'b' }), 2);
    });

    it('dbRemove by a 24-hex _id names both stored forms it removed', async function ( ) {
      const id = new ObjectId();
      await raw.insertMany([{ _id: id, eventType: 'Note' }, { _id: id.toHexString(), eventType: 'Note' }, { eventType: 'Note' }]);
      const written = await writeIntent.forCollectionResolved(v1Storage('treatments', 'socket'), 'treatments', 'socket', { env: { } })
        .write({ op: 'delete', target: { _id: id.toHexString() } });
      assert.deepEqual(hex(written.removed), hex([id, id.toHexString()]));
      assert.equal(await raw.countDocuments({ }), 1);
    });
  });

  describe('API v3', function ( ) {
    it('DELETE of a record stored in two forms removes and names both, and nothing else', async function ( ) {
      const id = new ObjectId();
      await raw.insertMany([{ _id: id, eventType: 'Note' }, { _id: id.toHexString(), eventType: 'Note' }
        , { eventType: 'Note', identifier: id.toHexString() + '-other' }]);
      const storage = v3Storage('treatments');
      const written = await writeIntent.forCollectionResolved(storage, 'treatments', 'v3', { env: { } })
        .write({ op: 'delete', form: 'permanent', target: { identifier: id.toHexString() } });
      assert.equal(written.adapter.deleted, 2);
      assert.deepEqual(hex(written.removed), hex([id, id.toHexString()]));
      assert.deepEqual(updates(), [{ type: 'treatments', op: 'remove', changes: [String(id), id.toHexString()] }]);
      assert.equal(await raw.countDocuments({ }), 1);
    });

    it('DELETE (marked) names both forms as removed for the cache', async function ( ) {
      const id = new ObjectId();
      await raw.insertMany([{ _id: id, eventType: 'Note' }, { _id: id.toHexString(), eventType: 'Note' }]);
      await writeIntent.forCollectionResolved(v3Storage('treatments'), 'treatments', 'v3', { env: { } })
        .write({ op: 'delete', form: 'mark', target: { identifier: id.toHexString() } });
      assert.deepEqual(updates().map(e => [e.op, e.changes.length]), [['remove', 2]]);
      assert.equal(await raw.countDocuments({ isValid: false }), 2);
    });

    it('PUT announces the record written, read back by its _id', async function ( ) {
      const { insertedId } = await raw.insertOne({ identifier: 'r2-put', eventType: 'Note', notes: 'a', created_at: '2026-10-31T10:00:00.000Z' });
      const written = await writeIntent.forCollectionResolved(v3Storage('treatments'), 'treatments', 'v3', { env: { } })
        .write({ op: 'update', docs: [{ identifier: 'r2-put', eventType: 'Note', notes: 'b', created_at: '2026-10-31T10:00:00.000Z' }]
          , target: { identifier: 'r2-put', stored: { srvCreated: 1 } } });
      assert.equal(String(written.items[0]._id), String(insertedId));
      assert.deepEqual(hex(written.updated), hex([insertedId]));
      const announced = updates();
      assert.equal(announced.length, 1);
      assert.equal(announced[0].op, 'update');
      assert.equal(announced[0].changes[0].notes, 'b');
    });

    it('autoPrune names a record past the cutoff by one OR condition only (Q-U; BF-222)', async function ( ) {
      const now = Date.now();
      const old = now - 40 * DAY;
      const { insertedIds } = await raw.insertMany([
        // past the cutoff by date only: created (and stamped) now
        { eventType: 'Note', created_at: new Date(now).toISOString(), srvCreated: now, date: old },
        { eventType: 'Note', created_at: new Date(now).toISOString(), srvCreated: now, date: now }
      ]);
      const cutoff = now - 30 * DAY;
      const written = await writeIntent.forCollectionResolved(v3Storage('treatments'), 'treatments', 'v3', { env: { } })
        .write({ op: 'prune', target: { filter: [
          { field: 'srvCreated', operator: 'lt', value: cutoff },
          { field: 'created_at', operator: 'lt', value: new Date(cutoff).toISOString() },
          { field: 'date', operator: 'lt', value: cutoff }
        ] } });
      assert.equal(written.adapter.deleted, 1);
      assert.deepEqual(hex(written.removed), hex([insertedIds[0]]));
      assert.deepEqual(updates(), [{ type: 'treatments', op: 'remove', changes: [String(insertedIds[0])] }]);
    });

    it('autoPrune with nothing to prune announces nothing', async function ( ) {
      await raw.insertOne({ eventType: 'Note', srvCreated: Date.now(), date: Date.now() });
      await writeIntent.forCollectionResolved(v3Storage('treatments'), 'treatments', 'v3', { env: { } })
        .write({ op: 'prune', target: { filter: [{ field: 'date', operator: 'lt', value: Date.now() - DAY }] } });
      assert.deepEqual(updates(), [ ]);
    });
  });
});
