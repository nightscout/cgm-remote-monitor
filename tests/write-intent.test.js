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
    const cursor = { sort: () => cursor, skip: () => cursor, limit: () => cursor, project: () => cursor,
      toArray: () => Promise.resolve(stored.slice()) };
    return cursor;
  };
  return col;
}

// The storage interface food.js acquires (storage-reads collection()), over
// the recording driver, with its commit events.
function storageOver (calls, stored, upserted, name = 'food') {
  const bus = new EventEmitter();
  const committed = [ ];
  bus.on('storage-write-committed', e => committed.push(e));
  const ctx = { bus, store: { collection: () => driver(calls, stored, upserted) } };
  const storage = new MongoCollection(ctx, { }, name, name, [ ], { source: MongoCollection.SOURCES.V1 });
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
    await assert.rejects(writeIntent.forCollection(storage, 'food', 'socket').write({ op: 'create', docs: [{ }] }), /No write rules/);
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


describe('write(intent) gate G2: one door for the enrolled collections', function ( ) {
  const { check, ENROLLED } = require('../scripts/check-write-intent');

  it('finds no write around the step in an enrolled module', function ( ) {
    // CHANGED EXPECTATION (WC-STEP-PATCH slice 2): activity.js joins food.js.
    // Each slice that routes a module through the step adds it here.
    assert.deepEqual(ENROLLED, ['lib/server/food.js', 'lib/server/activity.js']);
    for (const file of ENROLLED) {
      assert.deepEqual(check(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8')), [], file);
    }
  });

  // Every enrolled module, not only the first (slice 2 widened this from ENROLLED[0]).
  for (const file of ENROLLED) {
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
});
