'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { ObjectId } = require('mongodb');

const writeIntent = require('../lib/storage/write-intent');
const MongoCollection = require('../lib/api3/storage/mongoCollection');
const writes = require('../lib/server/storage-writes');
const reads = require('../lib/server/storage-reads');
const idForms = require('../lib/server/object-id-forms');
const srvDates = require('../lib/server/srv-dates');

// write(intent) for food from API v1 and in-process callers (WC-STEP-PATCH
// slice 1). The step must send MongoDB exactly what lib/server/food.js sent
// before the rules moved, and answer one item per document with what
// happened to it.

// A driver collection that records every call and answers from `stored`.
function driver (calls, stored, upserted) {
  const record = name => function (...args) {
    calls.push([name, ...args]);
    if (name === 'bulkWrite') {
      const upsertedIds = { };
      (upserted || [ ]).forEach(function (index) {
        upsertedIds[index] = args[0][index].replaceOne.filter._id.$eq || args[0][index].replaceOne.filter._id;
      });
      return Promise.resolve({ acknowledged: true, upsertedIds, matchedCount: args[0].length - (upserted || [ ]).length
        , modifiedCount: 0, upsertedCount: (upserted || [ ]).length, insertedCount: 0, deletedCount: 0 });
    }
    if (name === 'deleteMany' || name === 'deleteOne') {
      return Promise.resolve({ acknowledged: true, deletedCount: stored.length });
    }
    if (name === 'insertOne') {
      // As the driver does: a document without an _id gets one, on itself.
      if (args[0]._id == null) args[0]._id = new ObjectId();
      if (driver.failInsert) return Promise.reject(driver.failInsert);
      return Promise.resolve({ acknowledged: true, insertedId: args[0]._id });
    }
    if (name === 'replaceOne') {
      const up = (upserted || [ ]).includes(0);
      return Promise.resolve({ acknowledged: true, matchedCount: up ? 0 : 1, modifiedCount: up ? 0 : 1
        , upsertedCount: up ? 1 : 0, upsertedId: up ? args[0]._id : null });
    }
    return Promise.resolve({ acknowledged: true });
  };
  const col = { };
  for (const name of ['bulkWrite', 'insertOne', 'insertMany', 'deleteOne', 'deleteMany',
    'replaceOne', 'updateOne', 'updateMany']) col[name] = record(name);
  col.find = function (filter, options) {
    calls.push(['find', filter, options]);
    if (driver.failFind) throw driver.failFind;
    const cursor = { sort: () => cursor, skip: () => cursor, limit: () => cursor, project: () => cursor,
      toArray: () => Promise.resolve(stored.slice()) };
    return cursor;
  };
  return col;
}

// The storage interface food.js acquires (storage-reads collection()), over
// the recording driver, with its commit events.
function storageOver (calls, stored, upserted, name = 'food', source = MongoCollection.SOURCES.V1, validated = false) {
  const bus = new EventEmitter();
  const committed = [ ];
  bus.on('storage-write-committed', e => committed.push(e));
  const ctx = { bus, store: { collection: () => driver(calls, stored, upserted) } };
  const storage = new MongoCollection(ctx, { }, name, name, [ ], validated ? { source, validated: true } : { source });
  return { storage, committed };
}

// What lib/server/food.js did before the move (db3b9e4e), kept here as the
// reference the step is compared with: the same driver calls for the same
// documents.
async function legacy (storage, op, docs) {
  const submitted = [ ];
  const bulkOps = docs.map(function (doc) {
    submitted.push(doc._id);
    if (op === 'create') {
      if (!doc._id) doc._id = new ObjectId();
      doc._id = idForms.toStoredId(doc._id);
      return { replaceOne: { filter: { _id: { $eq: doc._id } }, replacement: doc, upsert: true } };
    }
    try { doc._id = new ObjectId(doc._id); } catch { doc._id = new ObjectId(); }
    return { replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } };
  });
  idForms.withStaleStringsRemoved(bulkOps, submitted);
  await srvDates.carryForReplace(reads.documents(storage), bulkOps.filter(op => op.replaceOne)
    .map(op => ({ filter: op.replaceOne.filter, doc: op.replaceOne.replacement })));
  const bulkResult = await writes.bulk(storage, bulkOps, { ordered: true });
  Object.keys(bulkResult.upsertedIds).forEach(function (index) { docs[index]._id = bulkResult.upsertedIds[index]; });
  return docs;
}

// The driver calls with the server's times and freshly made ObjectIds
// replaced by placeholders, which differ between any two runs.
function shape (calls) {
  return JSON.parse(JSON.stringify(calls, function (key, value) {
    if (key === 'srvModified') return 'T';
    // A new record's srvCreated is the clock too; a carried one is kept as stored.
    if (key === 'srvCreated' && value > 1e12) return 'T';
    return value;
  }));
}

const HEX = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const HEX2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const HEX3 = 'cccccccccccccccccccccccc';

function batch () {
  return [
    { _id: HEX.toUpperCase(), name: 'upper hex', created_at: 'C' },
    { _id: new ObjectId(HEX2), name: 'object id', created_at: 'C' },
    { _id: 'custom-id', name: 'custom string', created_at: 'C' }
  ];
}

describe('write(intent): food from API v1 and in-process callers', function ( ) {

  for (const op of ['create', 'update']) {
    it(op + ' sends the driver what food.js sent, and the same commit events', async function ( ) {
      const stored = [{ _id: new ObjectId(HEX2), srvCreated: 5, identifier: 'kept' }];

      const before = { calls: [ ] };
      Object.assign(before, storageOver(before.calls, stored, [0]));
      // update turns a non-hex _id into a fresh ObjectId, which differs
      // between the two runs; that case has its own test below.
      const input = op === 'update' ? () => batch().map((d, i) => i === 2 ? Object.assign(d, { _id: HEX3 }) : d) : batch;
      const legacyDocs = await legacy(before.storage, op, input());

      const after = { calls: [ ] };
      Object.assign(after, storageOver(after.calls, stored, [0]));
      const docs = input();
      const result = await writeIntent.forCollection(after.storage, 'food', 'v1/internal').write({ op, docs });

      assert.deepEqual(shape(after.calls), shape(before.calls));
      assert.deepEqual(after.committed, before.committed);
      assert.equal(after.committed.length, 1, 'one bulk write, one commit event');
      assert.deepEqual(shape(docs), shape(legacyDocs));
      assert.equal(result.event, null);
      assert.equal(result.items.length, 3, 'one item per document');
    });
  }

  it('answers one item per document: inserted with the upserted _id, otherwise replaced', async function ( ) {
    const calls = [ ];
    const { storage } = storageOver(calls, [ ], [0, 2]);
    const docs = batch();
    const result = await writeIntent.forCollection(storage, 'food', 'v1/internal').write({ op: 'create', docs });

    assert.deepEqual(result.items.map(i => [i.index, i.outcome]), [[0, 'inserted'], [1, 'replaced'], [2, 'inserted']]);
    assert(result.items[0]._id instanceof ObjectId);
    assert.equal(result.items[0]._id.toHexString(), HEX, 'an upper-case 24-hex _id is stored as its ObjectId');
    assert.equal(result.items[2]._id, 'custom-id', 'a create keeps a non-hex _id as given');
    assert.equal(result.items[1]._id, docs[1]._id);
    for (const item of result.items) assert.equal(item.identifier, null);
    assert(writeIntent.OUTCOMES.includes(result.items[1].outcome));
  });

  it('removes the string forms of every submitted 24-hex _id after the replaces, in the same bulk write', async function ( ) {
    const calls = [ ];
    const { storage } = storageOver(calls, [ ], [ ]);
    await writeIntent.forCollection(storage, 'food', 'v1/internal').write({ op: 'create', docs: batch() });
    const bulk = calls.find(call => call[0] === 'bulkWrite');
    assert.deepEqual(bulk[2], { ordered: true });
    assert.equal(bulk[1].length, 4);
    assert.deepEqual(bulk[1][3], { deleteMany: { filter: { _id: { $in: [HEX, HEX.toUpperCase(), HEX2] } } } });
  });

  it('carries srvCreated and identifier from the record each document replaces', async function ( ) {
    const calls = [ ];
    const { storage } = storageOver(calls, [{ _id: new ObjectId(HEX2), srvCreated: 5, identifier: 'kept' }], [ ]);
    const docs = batch();
    const result = await writeIntent.forCollection(storage, 'food', 'v1/internal').write({ op: 'update', docs });
    assert.equal(docs[1].srvCreated, 5);
    assert.equal(docs[1].identifier, 'kept');
    assert.equal(result.items[1].identifier, 'kept');
    assert.equal(docs[0].srvCreated, docs[0].srvModified, 'a new record is created now');
    assert(docs[1].srvModified > 5);
  });

  it('update gives a non-hex _id a new ObjectId and matches by plain _id equality', async function ( ) {
    const calls = [ ];
    const { storage } = storageOver(calls, [ ], [ ]);
    const docs = [{ _id: 'not-hex', name: 'x' }];
    await writeIntent.forCollection(storage, 'food', 'v1/internal').write({ op: 'update', docs });
    assert(docs[0]._id instanceof ObjectId);
    const bulk = calls.find(call => call[0] === 'bulkWrite');
    assert.deepEqual(Object.keys(bulk[1][0].replaceOne.filter._id), Object.keys(docs[0]._id));
    assert.equal(bulk[1].length, 1, 'no twin removal for a non-hex _id');
  });

  it('assigns each _id before its first await, so the caller sees it when write() returns', function ( ) {
    const docs = [{ name: 'no id' }];
    const pending = writeIntent.forCollection(storageOver([ ], [ ], [0]).storage, 'food', 'v1/internal')
      .write({ op: 'create', docs });
    assert(docs[0]._id instanceof ObjectId);
    return pending;
  });

  it('delete removes every stored form and answers deleted or not-found, with the interface reply', async function ( ) {
    const calls = [ ];
    const { storage } = storageOver(calls, [{ _id: HEX }, { _id: new ObjectId(HEX) }]);
    const result = await writeIntent.forCollection(storage, 'food', 'v1/internal').write({ op: 'delete', target: { _id: HEX } });
    assert.deepEqual(calls[0][0], 'deleteMany');
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), { _id: { $in: [HEX, HEX] } });
    assert.deepEqual(result.items, [{ index: 0, outcome: 'deleted', _id: HEX, identifier: null }]);
    assert.deepEqual(result.adapter, { acknowledged: true, deletedCount: 2, deleted: 2 });

    const none = await writeIntent.forCollection(storageOver([ ], [ ]).storage, 'food', 'v1/internal')
      .write({ op: 'delete', target: { _id: 'custom' } });
    assert.deepEqual(none.items, [{ index: 0, outcome: 'not-found', _id: 'custom', identifier: null }]);
  });

  it('refuses an intent it has no rules for, before any write', async function ( ) {
    const calls = [ ];
    const { storage } = storageOver(calls, [ ]);
    const step = writeIntent.forCollection(storage, 'food', 'v1/internal');
    await assert.rejects(step.write({ op: 'patch', target: { _id: HEX }, set: { a: 1 } }), /No write rules for patch on food/);
    await assert.rejects(writeIntent.forCollection(storage, 'treatments', 'v1/internal').write({ op: 'create', docs: [{ }] }), /No write rules/);
    // CHANGED EXPECTATION (WC-STEP-PATCH slice 3): food from the socket has
    // rules now (generic dbAdd and dbRemove); API v3 is a source with none yet.
    await assert.rejects(writeIntent.forCollection(storage, 'food', 'v3').write({ op: 'create', docs: [{ }] }), /No write rules/);
    await assert.rejects(step.write({ op: 'delete', target: { } }), /delete needs target._id/);
    assert.deepEqual(calls, [ ]);
  });
});


// What lib/server/activity.js did before the move (db3b9e4e): create is
// food's create without server dates; save is one upserting replaceOne by
// plain _id, then a separate removal of the string forms of a 24-hex _id.
async function legacyActivity (storage, op, docs) {
  if (op === 'create') {
    const submitted = [ ];
    const bulkOps = docs.map(function (doc) {
      submitted.push(doc._id);
      if (!doc._id) doc._id = new ObjectId();
      doc._id = idForms.toStoredId(doc._id);
      return { replaceOne: { filter: { _id: { $eq: doc._id } }, replacement: doc, upsert: true } };
    });
    idForms.withStaleStringsRemoved(bulkOps, submitted);
    const bulkResult = await writes.bulk(storage, bulkOps, { ordered: true });
    Object.keys(bulkResult.upsertedIds).forEach(function (index) { docs[index]._id = bulkResult.upsertedIds[index]; });
    return docs;
  }
  const obj = docs[0];
  const stale = idForms.staleStringForms([obj._id]);
  try { obj._id = new ObjectId(obj._id); } catch { obj._id = new ObjectId(); }
  await writes.replace(storage, { _id: obj._id }, obj, { upsert: true });
  if (stale.length > 0) await writes.remove(storage, { _id: { $in: stale } });
  return obj;
}

describe('write(intent): activity from API v1 and in-process callers', function ( ) {
  const activity = (storage) => writeIntent.forCollection(storage, 'activity', 'v1/internal');

  it('create sends the driver what activity.js sent (no server dates, no read), and the same commit events', async function ( ) {
    const before = { calls: [ ] };
    Object.assign(before, storageOver(before.calls, [ ], [0], 'activity'));
    const legacyDocs = await legacyActivity(before.storage, 'create', batch());

    const after = { calls: [ ] };
    Object.assign(after, storageOver(after.calls, [ ], [0], 'activity'));
    const docs = batch();
    const result = await activity(after.storage).write({ op: 'create', docs });

    assert.deepEqual(JSON.parse(JSON.stringify(after.calls)), JSON.parse(JSON.stringify(before.calls)));
    assert.deepEqual(after.calls.map(c => c[0]), ['bulkWrite'], 'one bulk write and no find: activity is not stamped');
    assert.deepEqual(after.committed, before.committed);
    assert.equal(after.committed.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(docs)), JSON.parse(JSON.stringify(legacyDocs)));
    for (const doc of docs) {
      assert(!('srvCreated' in doc) && !('srvModified' in doc), 'no server dates on activity');
    }
    assert.deepEqual(result.items.map(i => [i.index, i.outcome]), [[0, 'inserted'], [1, 'replaced'], [2, 'replaced']]);
    assert.deepEqual(after.calls[0][1][3], { deleteMany: { filter: { _id: { $in: [HEX, HEX.toUpperCase(), HEX2] } } } }
      , 'the string-twin removal is appended to the same bulk write, as food does');
  });

  for (const [label, id] of [['an upper-case 24-hex _id', HEX.toUpperCase()], ['an ObjectId _id', new ObjectId(HEX2)]
    , ['a non-hex _id', null]]) {
    it('update of ' + label + ' sends the driver what save sent (replaceOne; a twin removal in a call of its own)', async function ( ) {
      // A non-hex _id becomes a fresh ObjectId, different in each run: those
      // are compared with the new id replaced by a placeholder.
      const sent = () => ({ _id: id === null ? 'not-hex' : id, name: 'x', created_at: 'C' });
      const before = { calls: [ ] };
      // One stored string twin, so the mock's removal reports a deletion and commits.
      const twin = [{ _id: HEX }];
      Object.assign(before, storageOver(before.calls, twin, [ ], 'activity'));
      const after = { calls: [ ] };
      Object.assign(after, storageOver(after.calls, twin, [ ], 'activity'));
      const doc = sent();
      const result = await activity(after.storage).write({ op: 'update', docs: [doc] });
      const legacyDoc = await legacyActivity(before.storage, 'update', [sent()]);

      const fresh = (calls, newId) => JSON.parse(JSON.stringify(calls).split(String(newId)).join('NEW'));
      assert.deepEqual(fresh(after.calls, doc._id), fresh(before.calls, legacyDoc._id));
      assert.deepEqual(after.committed, before.committed);
      if (id === null) {
        assert.deepEqual(after.calls.map(c => c[0]), ['replaceOne'], 'no twin removal for a non-hex _id');
      } else {
        assert.deepEqual(after.calls.map(c => c[0]), ['replaceOne', 'deleteMany'], 'two driver calls');
        assert.equal(after.committed.length, 2, 'the replace and the twin removal each commit');
        assert.deepEqual(Object.keys(after.calls[0][1]), ['_id'], 'plain _id equality, not $eq');
        assert.deepEqual(after.calls[0][3], { upsert: true });
      }
      assert(doc._id instanceof ObjectId);
      assert.deepEqual(result.items, [{ index: 0, outcome: 'replaced', _id: doc._id, identifier: null }]);
      assert.equal(result.adapter.matchedCount, 1);
    });
  }

  it('update answers inserted, with the upserted _id, when no record had that _id', async function ( ) {
    const { storage } = storageOver([ ], [ ], [0], 'activity');
    const doc = { _id: HEX, name: 'new' };
    const result = await activity(storage).write({ op: 'update', docs: [doc] });
    assert.equal(result.items[0].outcome, 'inserted');
    assert.equal(result.items[0]._id.toHexString(), HEX);
  });

  it('update writes one document: a batch is refused before any write', async function ( ) {
    const calls = [ ];
    const { storage } = storageOver(calls, [ ], [ ], 'activity');
    await assert.rejects(activity(storage).write({ op: 'update', docs: [{ _id: HEX }, { _id: HEX2 }] }), /writes one document, not 2/);
    assert.deepEqual(calls, [ ]);
  });

  it('assigns the update _id before its first await, so save returns with it', function ( ) {
    const doc = { _id: HEX.toUpperCase() };
    const pending = activity(storageOver([ ], [ ], [ ], 'activity').storage).write({ op: 'update', docs: [doc] });
    assert(doc._id instanceof ObjectId);
    assert.equal(doc._id.toHexString(), HEX);
    return pending;
  });

  it('delete removes every stored form, as food does', async function ( ) {
    const calls = [ ];
    const { storage, committed } = storageOver(calls, [{ _id: HEX }], [ ], 'activity');
    const result = await activity(storage).write({ op: 'delete', target: { _id: HEX } });
    assert.deepEqual(calls.map(c => c[0]), ['deleteMany']);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), { _id: { $in: [HEX, HEX] } });
    assert.equal(result.items[0].outcome, 'deleted');
    assert.equal(committed[0].collection, 'activity');
  });

  it('keeps activity without server dates (write-contract Q5 is the second release)', function ( ) {
    const rules = writeIntent.COLLECTION_RULES.activity['v1/internal'];
    assert.equal(rules.create.dates, 'none');
    assert.equal(rules.update.dates, 'none');
    assert(Object.isFrozen(rules.update));
  });
});


// What lib/server/websocket.js did before the move (db3b9e4e) for a generic
// dbAdd (storeIdAsObjectId, stampCreated when API v3 serves the collection,
// insertDocument) and for dbRemove (idMatch, writes.remove).
async function legacySocketAdd (storage, name, doc) {
  if (idForms.isHexId(doc._id)) {
    const stale = await reads.findOne(storage, { _id: { $in: idForms.stringIdForms(doc._id) } }, { _id: 1 });
    doc._id = stale ? stale._id : idForms.toStoredId(doc._id);
  }
  if (['treatments', 'entries', 'devicestatus', 'profile', 'food'].includes(name)) srvDates.stampCreated(doc);
  await storage.insertOne(doc, { normalize: false });
  return doc;
}

function legacySocketRemove (storage, id) {
  const match = (id instanceof ObjectId || idForms.isHexId(id))
    ? { filter: { _id: { $in: idForms.idForms(id) } }, many: true } : { filter: { _id: id }, many: false };
  return writes.remove(storage, match.filter, { one: !match.many });
}

describe('write(intent): the socket\'s generic dbAdd and its dbRemove', function ( ) {
  const SOCKET = MongoCollection.SOURCES.SOCKET;
  afterEach(function ( ) { delete driver.failInsert; delete driver.failFind; });
  const over = (calls, stored, name) => storageOver(calls, stored, [ ], name, SOCKET, true);
  const socket = (storage, name) => writeIntent.forCollection(storage, name, 'socket');

  for (const name of ['entries', 'food', 'activity']) {
    for (const [label, id, stored] of [['no _id', undefined, [ ]], ['a 24-hex _id', HEX.toUpperCase(), [ ]]
      , ['a 24-hex _id stored as a string', HEX, [{ _id: HEX }]], ['a custom _id', 'custom-id', [ ]]]) {
      it(name + ' create with ' + label + ' sends the driver what dbAdd sent, and the same commit events', async function ( ) {
        const body = () => { const d = { wc: 'x', created_at: 'C' }; if (id !== undefined) d._id = id; return d; };
        const before = { calls: [ ] };
        Object.assign(before, over(before.calls, stored, name));
        const legacyDoc = await legacySocketAdd(before.storage, name, body());
        const after = { calls: [ ] };
        Object.assign(after, over(after.calls, stored, name));
        const doc = body();
        const result = await socket(after.storage, name).write({ op: 'create', docs: [doc] });

        const fresh = (x, newId) => newId instanceof ObjectId && id === undefined
          ? JSON.parse(JSON.stringify(x).split(String(newId)).join('NEW')) : JSON.parse(JSON.stringify(x));
        assert.deepEqual(shape(fresh(after.calls, doc._id)), shape(fresh(before.calls, legacyDoc._id)));
        assert.deepEqual(after.committed, before.committed);
        assert.deepEqual(after.calls.map(c => c[0]), idForms.isHexId(id) ? ['find', 'insertOne'] : ['insertOne']
          , 'one read only for a 24-hex _id');
        assert.equal(after.committed.length, 1);
        assert.equal(after.committed[0].source, 'socket');
        assert.equal('srvCreated' in doc, name !== 'activity', 'server dates where API v3 serves the collection');
        assert.deepEqual(result.items, [{ index: 0, outcome: 'inserted', _id: doc._id, identifier: null }]);
        if (stored.length) assert.equal(doc._id, HEX, 'the stored string form is kept, so the insert collides with it');
        else if (idForms.isHexId(id)) assert.equal(doc._id.toHexString(), HEX);
      });
    }
  }

  it('does not give a document without an _id an `_id: undefined` key before the driver does', async function ( ) {
    const calls = [ ];
    const { storage } = over(calls, [ ], 'entries');
    let seen;
    const insertOne = storage.insertOne;
    storage.insertOne = function (doc, opts) { seen = Object.prototype.hasOwnProperty.call(doc, '_id'); return insertOne(doc, opts); };
    await socket(storage, 'entries').write({ op: 'create', docs: [{ wc: 'x' }] });
    assert.equal(seen, false);
  });

  it('answers a duplicate _id as refused, with the driver\'s message, and does not throw', async function ( ) {
    const { storage, committed } = over([ ], [ ], 'food');
    driver.failInsert = Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
    const result = await socket(storage, 'food').write({ op: 'create', docs: [{ _id: 'custom-id' }] });
    assert.deepEqual(result.items, [{ index: 0, outcome: 'refused', _id: 'custom-id', identifier: null, reason: 'E11000 duplicate key error' }]);
    assert.deepEqual(committed, [ ], 'nothing committed');
  });

  it('passes any other insert error to the caller', async function ( ) {
    const { storage } = over([ ], [ ], 'food');
    driver.failInsert = Object.assign(new Error('not primary'), { code: 10107 });
    await assert.rejects(socket(storage, 'food').write({ op: 'create', docs: [{ _id: 'custom-id' }] }), /not primary/);
  });

  it('names the _id-form rule when its read fails, with the storage error as cause, before any write', async function ( ) {
    const calls = [ ];
    const { storage } = over(calls, [ ], 'entries');
    driver.failFind = new Error('read failed');
    const err = await socket(storage, 'entries').write({ op: 'create', docs: [{ _id: HEX }] }).then(() => null, e => e);
    assert(err instanceof writeIntent.WriteRuleError);
    assert.equal(err.rule, 'id-form');
    assert.equal(err.cause.message, 'read failed');
    assert.deepEqual(calls.map(c => c[0]), ['find']);
  });

  it('writes one document per create: a batch is refused before any write', async function ( ) {
    const calls = [ ];
    const { storage } = over(calls, [ ], 'entries');
    await assert.rejects(socket(storage, 'entries').write({ op: 'create', docs: [{ }, { }] }), /writes one document, not 2/);
    assert.deepEqual(calls, [ ]);
  });

  it('has no socket create rules for the collections dbAdd still matches itself', async function ( ) {
    for (const name of ['treatments', 'devicestatus', 'profile']) {
      const calls = [ ];
      await assert.rejects(socket(over(calls, [ ], name).storage, name).write({ op: 'create', docs: [{ }] }), /No write rules for create/);
      assert.deepEqual(calls, [ ]);
    }
  });

  for (const name of ['treatments', 'entries', 'devicestatus', 'profile', 'food', 'activity']) {
    for (const [label, id] of [['a 24-hex _id', HEX.toUpperCase()], ['an ObjectId', new ObjectId(HEX2)], ['a custom _id', 'custom-id'], ['a number', 7]]) {
      it(name + ' delete of ' + label + ' sends the driver what dbRemove sent, and the same reply and commit events', async function ( ) {
        const before = { calls: [ ] };
        Object.assign(before, storageOver(before.calls, [{ _id: 1 }], [ ], name, SOCKET));
        const legacyReply = await legacySocketRemove(before.storage, id);
        const after = { calls: [ ] };
        Object.assign(after, storageOver(after.calls, [{ _id: 1 }], [ ], name, SOCKET));
        const result = await socket(after.storage, name).write({ op: 'delete', target: { _id: id } });

        assert.deepEqual(JSON.parse(JSON.stringify(after.calls)), JSON.parse(JSON.stringify(before.calls)));
        assert.deepEqual(after.calls.map(c => c[0]), [typeof id === 'string' && !idForms.isHexId(id) || typeof id === 'number' ? 'deleteOne' : 'deleteMany']);
        assert.deepEqual(after.committed, before.committed);
        assert.deepEqual(result.adapter, legacyReply);
        assert.equal(result.items[0].outcome, 'deleted');
      });
    }
  }
});


describe('write(intent) gate G2: one door for the enrolled collections', function ( ) {
  const { check, checkEntry, fileOf, ENROLLED } = require('../scripts/check-write-intent');

  it('finds no write around the step in an enrolled module', function ( ) {
    // CHANGED EXPECTATION (WC-STEP-PATCH slice 2): activity.js joins food.js.
    // CHANGED EXPECTATION (slice 3): two functions of websocket.js join.
    // Each slice that routes code through the step adds it here.
    assert.deepEqual(ENROLLED, ['lib/server/food.js', 'lib/server/activity.js'
      , { file: 'lib/server/websocket.js', functions: ['processGenericDbAdd', 'dbRemove'] }]);
    for (const entry of ENROLLED) {
      assert.deepEqual(checkEntry(entry, fs.readFileSync(path.resolve(__dirname, '..', fileOf(entry)), 'utf8')), [], fileOf(entry));
    }
  });

  // Every enrolled module, not only the first (slice 2 widened this from ENROLLED[0]).
  for (const file of ENROLLED.filter(entry => typeof entry === 'string')) {
    it('fails, naming the line, when ' + file + ' writes around the step (break-it control)', function ( ) {
      const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
      const lines = source.split('\n').length;
      for (const bypass of [
        'store().bulkUpsert([], { mode: "replace" });'
        , 'store().insertOne({});'
        , 'store().replaceFiltered(null, {}, { upsert: true, v1: true });'
        , 'reads.collection(ctx, env, "x", "x").deleteMany(null, { v1: true });'
        , 'var writes = require("./storage-writes"); writes.remove(store(), {});'
      ]) {
        const issues = check(source + '\n' + bypass + '\n');
        assert(issues.length > 0, bypass);
        assert(issues.every(issue => issue.endsWith('line ' + (lines + 1))), issues.join('; '));
      }
    });
  }

  describe('enrolled functions (the socket\'s generic dbAdd and dbRemove)', function ( ) {
    const entry = ENROLLED.find(e => typeof e !== 'string');
    const source = fs.readFileSync(path.resolve(__dirname, '..', entry.file), 'utf8');
    // The text right after an enrolled function's opening line, where a bypass is put.
    const into = (name, line) => source.replace(new RegExp('(function ' + name + ' \\([^)]*\\) \\{\\n)'), '$1' + line + '\n');

    for (const name of entry.functions) {
      for (const bypass of [
        'socketStore(data.collection).insertOne(data.data, { normalize: false });'
        , 'writes.remove(socketStore(data.collection), { _id: data._id });'
        , 'insertDocument(socketStore(data.collection), data.data);'
      ]) {
        it('fails when ' + name + ' writes around the step: ' + bypass.split('(')[0], function ( ) {
          const broken = into(name, bypass);
          assert.notEqual(broken, source, 'the bypass was put in');
          const issues = checkEntry(entry, broken);
          assert(issues.length > 0, bypass);
          assert(issues.every(issue => issue.startsWith(name + ': ')), issues.join('; '));
        });
      }
    }

    it('fails when an enrolled function cannot be found (a rename cannot empty the gate)', function ( ) {
      const issues = checkEntry(entry, source.replace('function processGenericDbAdd (', 'function renamedDbAdd ('));
      assert.deepEqual(issues, ['enrolled function processGenericDbAdd found 0 times, expected once']);
    });

    it('does not flag the other socket writers, which are not enrolled yet', function ( ) {
      assert.deepEqual(checkEntry(entry, source), [ ]);
      assert(check(source).length > 0, 'the module as a whole still writes around the step');
    });
  });
});
