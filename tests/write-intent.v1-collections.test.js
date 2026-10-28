'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ObjectId } = require('mongodb');

const writeIntent = require('../lib/storage/write-intent');

// write(intent) for treatments, entries, devicestatus and profile from API v1
// and in-process callers (WC-STEP-PATCH slice 5). Each module's writes moved
// into the step with today's rules; this file runs the module as it was at
// dev db3b9e4e (tests/fixtures/write-intent/<collection>-db3b9e4e.js, the
// reference) and the module as it is now over the same recording driver, and
// requires the same driver calls, the same commit events, bus emissions and
// log lines in the same order, the same reply and the same documents. The
// write matrix (G1) sees stored state and emissions over a real MongoDB; this
// sees the calls and the order, including inputs the matrix has no cell for
// (preBolus, UUID_HANDLING, WRITE_VALIDATION log and reject, a bad eventTime).

const OWN_LOG = /lib\/server\/(treatments|entries|devicestatus|profile)\.js|fixtures\/write-intent\/|lib\/storage\/write-intent\.js/;

const FIXED = /^(aaaa|bbbb|cccc|dddd|eeee|0000)/;

// A driver collection that records every call and answers as configured:
// finds return `cfg.stored`; a bulkWrite upserts the operation indexes in
// `cfg.upserted`; each replaceOne / updateOne upserts when the next value of
// `cfg.replaceUpserts` is true; insertMany assigns ids or fails as told.
function driver (calls, cfg) {
  let made = 0;
  const madeId = ( ) => new ObjectId((++made).toString(16).padStart(24, '0'));
  const replaceUpserts = (cfg.replaceUpserts || [ ]).slice();
  const answer = name => function (...args) {
    calls.push([name, ...args]);
    if (cfg.fail && cfg.fail[name]) return Promise.reject(cfg.fail[name]);
    if (name === 'bulkWrite') {
      const upsertedIds = { };
      (cfg.upserted || [ ]).forEach(index => { upsertedIds[index] = madeId(); });
      return Promise.resolve({ acknowledged: true, upsertedIds, upsertedCount: Object.keys(upsertedIds).length
        , matchedCount: args[0].length - Object.keys(upsertedIds).length
        , modifiedCount: args[0].length - Object.keys(upsertedIds).length, insertedCount: 0, deletedCount: 0 });
    }
    if (name === 'replaceOne' || name === 'updateOne' || name === 'updateMany') {
      const up = replaceUpserts.length ? replaceUpserts.shift() : false;
      return Promise.resolve({ acknowledged: true, matchedCount: up ? 0 : 1, modifiedCount: up ? 0 : 1
        , upsertedCount: up ? 1 : 0, upsertedId: up ? madeId() : null });
    }
    if (name === 'insertMany') {
      if (cfg.insertManyError) return Promise.reject(cfg.insertManyError);
      const insertedIds = { };
      args[0].forEach((doc, index) => {
        if (doc._id == null) doc._id = madeId();
        insertedIds[index] = doc._id;
      });
      return Promise.resolve({ acknowledged: true, insertedCount: args[0].length, insertedIds });
    }
    if (name === 'deleteMany' || name === 'deleteOne') {
      return Promise.resolve({ acknowledged: true, deletedCount: cfg.deleted === undefined ? 1 : cfg.deleted });
    }
    return Promise.resolve({ acknowledged: true });
  };
  const col = { collectionName: 'c' };
  for (const name of ['bulkWrite', 'insertOne', 'insertMany', 'deleteOne', 'deleteMany',
    'replaceOne', 'updateOne', 'updateMany']) col[name] = answer(name);
  col.find = function (filter, options) {
    calls.push(['find', filter, options]);
    if (cfg.fail && cfg.fail.find) throw cfg.fail.find;
    if (cfg.failFindAt !== undefined && calls.filter(c => c[0] === 'find').length - 1 === cfg.failFindAt) {
      throw new Error('find down');
    }
    const docs = typeof cfg.stored === 'function' ? cfg.stored(filter) : (cfg.stored || [ ]);
    const cursor = { sort: () => cursor, skip: () => cursor, limit: () => cursor, project: () => cursor,
      batchSize: () => cursor, toArray: () => Promise.resolve(JSON.parse(JSON.stringify(docs), revive)) };
    return cursor;
  };
  col.countDocuments = ( ) => Promise.resolve(0);
  return col;
}

// Stored documents are written with {$oid} for ObjectIds.
function revive (key, value) {
  return value && typeof value === 'object' && typeof value.$oid === 'string' ? new ObjectId(value.$oid) : value;
}

// Times and ObjectIds the server makes differ between two runs; everything
// else must be equal.
function shape (value) {
  return JSON.parse(JSON.stringify(value, function (key, v) {
    if (key === 'srvModified' || key === 'time' || key === 'at' || key === 'timestamp') return 'T';
    if (key === 'srvCreated' && typeof v === 'number' && v > 1e12) return 'T';
    if (v instanceof ObjectId || (v && v._bsontype === 'ObjectId')) v = v.toHexString();
    if (typeof v === 'string' && /^[0-9a-f]{24}$/.test(v) && !FIXED.test(v)) return 'NEWID';
    if (v instanceof Error) return { error: v.message, name: v.name, code: v.code };
    return v;
  }));
}

// Run `act(api, done)` against a module built by `make(env, ctx)`; returns
// everything observable: driver calls, the ordered bus events and log lines,
// a synchronous throw, the callback's arguments, and the documents passed in.
async function observe (make, envExtra, cfg, act) {
  const calls = [ ];
  const timeline = [ ];
  const bus = new EventEmitter();
  for (const name of ['storage-write-committed', 'data-update', 'data-received']) {
    bus.on(name, e => timeline.push([name, e]));
  }
  const ctx = {
    bus,
    store: { collection: ( ) => driver(calls, cfg), ensureIndexes: ( ) => { } },
    ddata: { processRawDataForRuntime: x => JSON.parse(JSON.stringify(x)) },
    purifier: { purifyObject: ( ) => { } }
  };
  const env = Object.assign({ treatments_collection: 'treatments', entries_collection: 'entries'
    , devicestatus_collection: 'devicestatus' }, envExtra);
  const saved = { };
  for (const level of ['log', 'warn', 'error']) {
    saved[level] = console[level];
    // Only the lines the modules under test log: another suite's late timer
    // can log while this one runs.
    console[level] = function (...args) {
      if (!OWN_LOG.test(new Error().stack)) return saved[level].apply(console, args);
      timeline.push(['console.' + level, args.map(a => a instanceof Error ? a.message : a)]);
    };
  }
  const out = { };
  try {
    const api = make(env, ctx);
    await new Promise(function (resolve) {
      const timer = setTimeout(resolve, 300);
      const done = function (...args) { out.callback = args; clearTimeout(timer); setTimeout(resolve, 20); };
      try {
        const returned = act(api, done);
        if (returned && typeof returned.then === 'function') {
          returned.then(r => { out.resolved = r; }, e => { out.rejected = e; });
        }
      } catch (err) {
        out.threw = err;
        clearTimeout(timer);
        setTimeout(resolve, 20);
      }
    });
  } finally {
    for (const level of Object.keys(saved)) console[level] = saved[level];
  }
  return shape({ calls, timeline, out });
}

// Both modules over the same inputs: `docs()` makes fresh documents each run.
async function same (name, makeBefore, makeAfter, envExtra, cfg, act) {
  const before = await observe(makeBefore, envExtra, cfg, act);
  const after = await observe(makeAfter, envExtra, cfg, act);
  assert.deepEqual(after, before, name);
  return after;
}

const HEX = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const HEX2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const T1 = '2026-10-27T10:00:00.000Z';
const T2 = '2026-10-27T10:05:00.000Z';
const T3 = '2026-10-27T10:10:00.000+02:00';

describe('write(intent): treatments from API v1 and in-process callers (equal to db3b9e4e)', function ( ) {
  const before = require('./fixtures/write-intent/treatments-db3b9e4e');
  const after = require('../lib/server/treatments');

  const batch = ( ) => [
    { eventType: 'Correction Bolus', insulin: '1.5', created_at: T1, _id: HEX.toUpperCase() },
    { eventType: 'Meal Bolus', carbs: 20, created_at: T2, identifier: 'id-1' },
    { eventType: 'Note', notes: 'x', created_at: T3, enteredBy: 'loop' },
    { eventType: 'Carb Correction', carbs: 10, created_at: T1, _id: '1b2c3d4e-uuid', syncIdentifier: 's-1' }
  ];
  const stored = [{ _id: { $oid: HEX2 }, identifier: 'id-1', srvCreated: 5, created_at: T2, eventType: 'Meal Bolus' }];
  const tt = (bottom, top, units) => ({ eventType: 'Temporary Target', targetBottom: bottom, targetTop: top
    , units, duration: 60, created_at: T1, enteredBy: 'aid' });

  const cases = [
    ['a batch (bulk write, a twin removal after its _id write, read-backs)', { }, { stored, upserted: [0] }
      , (api, done) => api.create(batch(), done)],
    ['a batch under UUID_HANDLING', { uuidHandling: true }, { stored, upserted: [2] }
      , (api, done) => api.create(batch(), done)],
    ['a batch where nothing is upserted (every item answered by read-back)', { }, { stored }
      , (api, done) => api.create(batch(), done)],
    ['one document by _id (replace, then the twin removal in its own call)', { }, { stored, replaceUpserts: [false] }
      , (api, done) => api.create(batch()[0], done)],
    ['one document by fallback key, matched (BF-165 read-back)', { }, { stored, replaceUpserts: [false] }
      , (api, done) => api.create(batch()[2], done)],
    ['one document by identifier, inserted', { uuidHandling: true }, { stored: [ ], replaceUpserts: [true] }
      , (api, done) => api.create(batch()[3], done)],
    ['a batch with a preBolus (each item alone, then its preBolus record)', { }, { stored, replaceUpserts: [true, true, false, true] }
      , (api, done) => api.create([Object.assign(batch()[1], { preBolus: '15' }), batch()[0], batch()[2]], done)],
    ['one document with a preBolus whose record write fails', { }, { stored, replaceUpserts: [true], fail: { } }
      , (api, done) => api.create({ eventType: 'Meal Bolus', carbs: 30, preBolus: 10, created_at: T1, notes: 'n' }, done)],
    ['a batch whose bulk write fails', { }, { stored, fail: { bulkWrite: new Error('bulk down') } }
      , (api, done) => api.create(batch(), done)],
    ['one document whose write fails', { }, { stored, fail: { replaceOne: new Error('replace down') } }
      , (api, done) => api.create(batch()[0], done)],
    ['an empty batch', { }, { }, (api, done) => api.create([ ], done)],
    ['a Temporary Target in mmol stored in mg/dL (BF-194)', { }, { stored: [ ], upserted: [0] }
      , (api, done) => api.create([tt(5.5, 6.5, 'mmol'), tt(100, 120, 'mg/dl')], done)],
    ['a bad eventTime throws synchronously (validation off)', { }, { }
      , (api, done) => api.create([{ eventType: 'Note', created_at: T1, eventTime: 'not a date' }], done)],
    ['a bad eventTime under WRITE_VALIDATION=log is an error to the callback', { writeValidation: 'log' }, { }
      , (api, done) => api.create([{ eventType: 'Note', created_at: T1, eventTime: 'not a date' }], done)],
    ['WRITE_VALIDATION=log: logs and stores', { writeValidation: 'log' }, { stored: [ ], upserted: [0, 1] }
      , (api, done) => api.create([tt(120, 100, 'mg/dl'), tt(100, 120, 'mmol')], done)],
    ['WRITE_VALIDATION=reject: refuses one, stores the other, keeps the slots', { writeValidation: 'reject' }, { stored: [ ], upserted: [0] }
      , (api, done) => api.create([tt(120, 100, 'mg/dl'), tt(100, 120, 'MG/DL'), tt(100, 120, 'mmol')], done)],
    ['WRITE_VALIDATION=reject: every item refused is a ValidationError', { writeValidation: 'reject' }, { }
      , (api, done) => api.create([tt(120, 100, 'mg/dl')], done)],
    ['a non-string identifier is refused before any write', { }, { }
      , (api, done) => api.create([{ eventType: 'Note', created_at: T1, identifier: 5 }], done)],
    ['save by 24-hex _id (replace, twin removal, data-received first)', { }, { stored, replaceUpserts: [false] }
      , (api, done) => api.save(batch()[0], done)],
    ['save by identifier, matched (REQ-SYNC-072 read-back)', { }, { stored, replaceUpserts: [false] }
      , (api, done) => api.save(batch()[1], done)],
    ['save, inserted', { }, { stored: [ ], replaceUpserts: [true] }
      , (api, done) => api.save({ eventType: 'Note', notes: 'n', created_at: T1 }, done)],
    ['save refused by WRITE_VALIDATION=reject', { writeValidation: 'reject' }, { }
      , (api, done) => api.save(tt(120, 100, 'mg/dl'), done)],
    ['save with a bad eventTime throws synchronously', { }, { }
      , (api, done) => api.save({ eventType: 'Note', created_at: T1, eventTime: 'nope' }, done)],
    ['save whose write fails', { }, { fail: { replaceOne: new Error('replace down') } }
      , (api, done) => api.save(batch()[0], done)],
    ['remove by 24-hex _id', { }, { deleted: 1 }
      , (api, done) => api.remove({ find: { _id: HEX } }, done)],
    ['remove by query, nothing removed', { }, { deleted: 0 }
      , (api, done) => api.remove({ find: { eventType: 'Note', created_at: { $gte: '2026-01-01' } } }, done)]
  ];

  for (const [name, envExtra, cfg, act] of cases) {
    it(name, async function ( ) {
      await same(name, before, after, envExtra, cfg, act);
    });
  }

  it('the comparison is not vacuous: a batch writes, emits and answers', async function ( ) {
    const seen = await observe(after, { }, { stored, upserted: [0] }, (api, done) => api.create(batch(), done));
    const names = seen.timeline.map(e => e[0]);
    assert.deepEqual(names.filter(n => n !== 'console.log'), ['storage-write-committed', 'data-update', 'data-received']);
    assert.equal(seen.calls.filter(c => c[0] === 'bulkWrite').length, 1);
    // The twin removal follows the write of the item matched by _id, in the same bulk write.
    const ops = seen.calls.find(c => c[0] === 'bulkWrite')[1];
    assert.deepEqual(ops.map(op => Object.keys(op)[0]), ['replaceOne', 'deleteMany', 'replaceOne', 'replaceOne', 'replaceOne']);
    assert.equal(seen.out.callback[1].length, 4);
  });

  it('the comparison sees log lines: WRITE_VALIDATION=reject logs the refusal', async function ( ) {
    const seen = await observe(after, { writeValidation: 'reject' }, { stored: [ ], upserted: [0] }
      , (api, done) => api.create([{ eventType: 'Temporary Target', targetBottom: 120, targetTop: 100, units: 'mg/dl'
        , duration: 60, created_at: T1 }, { eventType: 'Note', created_at: T1 }], done));
    const warns = seen.timeline.filter(e => e[0] === 'console.warn');
    assert.equal(warns.length, 1);
    assert(warns[0][1][0].startsWith('WRITE_VALIDATION API v1 refused: '), warns[0][1][0]);
    assert.equal(seen.out.callback[1][0].refused !== undefined, true, 'the refused slot');
  });
});

describe('write(intent): the treatments rule table (slice 5)', function ( ) {
  const rules = writeIntent.COLLECTION_RULES.treatments['v1/internal'];

  it('has a batch, a single and a preBolus form of create, an update and a delete by query', function ( ) {
    assert.deepEqual(Object.keys(rules.create.forms), ['batch', 'one', 'prebolus']);
    assert.equal(rules.create.forms.batch.twins, 'remove-string-forms-each');
    assert.equal(rules.create.forms.one.twins, 'remove-string-forms-after');
    assert.equal(rules.create.forms.prebolus.twins, 'none');
    assert.equal(rules.update.keyTime, 'doc');
    assert.equal(rules.create.forms.one.keyTime, 'prepared');
    assert.equal(rules.delete.target, 'query');
    assert.equal(rules.check, 'treatment-domain-v1');
  });

  function step (env, calls, cfg) {
    const bus = new EventEmitter();
    const MongoCollection = require('../lib/api3/storage/mongoCollection');
    const ctx = { bus, store: { collection: ( ) => driver(calls, cfg || { }) } };
    const storage = new MongoCollection(ctx, env, 'treatments', 'treatments', [ ], { source: 'v1/internal' });
    return writeIntent.forCollection(storage, 'treatments', 'v1/internal', { env });
  }

  it('plans the _id form, preparation and target synchronously, and throws there as the module did', function ( ) {
    const s = step({ }, [ ]);
    const planned = s.plan({ op: 'create', form: 'one', docs: [{ _id: HEX.toUpperCase(), eventType: 'Note', created_at: T3 }] });
    assert(planned.docs[0]._id instanceof ObjectId);
    assert.deepEqual(Object.keys(planned.targets[0]), ['_id']);
    assert.deepEqual(planned.stale[0], [HEX, HEX.toUpperCase()], 'both string forms are removed after the write');
    assert.equal(planned.prepared[0].created_at, '2026-10-27T08:10:00.000Z');
    assert.equal(planned.docs[0].utcOffset, 120);
    assert.throws(( ) => s.plan({ op: 'create', form: 'one', docs: [{ eventType: 'Note', eventTime: 'x' }] }), RangeError);
  });

  it('targets the identifier first and drops the _id; under UUID_HANDLING also the identifier as _id', function ( ) {
    const plain = step({ }, [ ]).plan({ op: 'create', form: 'batch', docs: [{ _id: HEX, identifier: 'i', eventType: 'Note', created_at: T1 }] });
    assert.deepEqual(plain.targets[0], { identifier: { $eq: 'i' } });
    assert(!Object.prototype.hasOwnProperty.call(plain.docs[0], '_id'));
    assert.deepEqual(plain.stale[0], [ ], 'no twin removal for a write that is not by _id');
    const uuid = step({ uuidHandling: true }, [ ]).plan({ op: 'create', form: 'batch', docs: [{ _id: 'u-1', eventType: 'Note', created_at: T1 }] });
    assert.deepEqual(uuid.targets[0], { $or: [{ identifier: { $eq: 'u-1' } }, { _id: { $eq: 'u-1' } }] });
    assert.equal(uuid.docs[0].identifier, 'u-1');
  });

  it('falls back to created_at + eventType with the amounts when there is no identity (BF-121)', function ( ) {
    const planned = step({ }, [ ]).plan({ op: 'update', docs: [{ eventType: 'Meal Bolus', carbs: 20, created_at: T1 }] });
    assert.deepEqual(planned.targets[0].created_at, { $eq: T1 });
    assert.deepEqual(planned.targets[0].carbs, { $eq: 20 });
    assert.deepEqual(planned.targets[0].insulin, { $eq: null });
  });

  it('stores a Temporary Target in mmol as mg/dL, labelled mg/dl (BF-194), and keeps the label without glucose', function ( ) {
    const planned = step({ }, [ ]).plan({ op: 'update', docs: [{ eventType: 'Temporary Target', targetBottom: 5, targetTop: 6, units: 'mmol', duration: 30, created_at: T1 }] });
    assert.equal(planned.docs[0].units, 'mg/dl');
    assert.equal(Math.round(planned.docs[0].targetBottom), 90);
  });

  it('checks WRITE_VALIDATION on the targets as sent, before BF-194 (reject refuses, log only logs)', function ( ) {
    const warn = console.warn;
    const lines = [ ];
    console.warn = line => lines.push(line);
    try {
      const doc = ( ) => ({ eventType: 'Temporary Target', targetBottom: 120, targetTop: 100, units: 'mg/dl', duration: 30, created_at: T1 });
      assert.deepEqual(step({ }, [ ]).check([doc()]), [ ]);
      assert.deepEqual(step({ writeValidation: 'log' }, [ ]).check([doc()]), [ ]);
      const refused = step({ writeValidation: 'reject' }, [ ]).check([doc(), doc()]);
      assert.deepEqual(refused.map(r => r.index), [0, 1]);
      assert.equal(refused[0].problems[0].rule, 'tt-order');
      // mmol numbers labelled mmol are fine as sent, though BF-194 would convert them.
      assert.deepEqual(step({ writeValidation: 'reject' }, [ ]).check([{ eventType: 'Temporary Target', targetBottom: 5, targetTop: 6, units: 'mmol', duration: 30, created_at: T1 }]), [ ]);
    } finally {
      console.warn = warn;
    }
    assert.equal(lines.length, 3);
    assert(lines[0].startsWith('WRITE_VALIDATION API v1: '), lines[0]);
    assert(lines[1].startsWith('WRITE_VALIDATION API v1 refused: '), lines[1]);
  });

  it('answers a fallback-key match with the stored _id (BF-165), read back by the same target', async function ( ) {
    const calls = [ ];
    const s = step({ }, calls, { stored: [{ _id: { $oid: HEX2 } }] });
    const doc = { eventType: 'Note', notes: 'n', created_at: T1 };
    const result = await s.write({ op: 'create', form: 'one', docs: [doc] });
    assert.equal(String(doc._id), HEX2);
    assert.deepEqual(result.items.map(i => i.outcome), ['replaced']);
    assert.equal(calls.filter(c => c[0] === 'find').length, 2, 'the server-date read and the read-back');
  });

  it('refuses a create without a form it knows, before any write', async function ( ) {
    const calls = [ ];
    await assert.rejects(step({ }, calls).write({ op: 'create', form: 'nope', docs: [{ }] }), /No write rules for create form nope/);
    assert.deepEqual(calls, [ ]);
  });
});

describe('write(intent): entries from API v1 and in-process callers (equal to db3b9e4e)', function ( ) {
  const before = require('./fixtures/write-intent/entries-db3b9e4e');
  const after = require('../lib/server/entries');

  const D1 = Date.parse(T1);
  const sgv = (minutes, extra) => Object.assign({ type: 'sgv', sgv: 100 + minutes, date: D1 + minutes * 60000
    , dateString: new Date(D1 + minutes * 60000).toISOString(), device: 'cgm' }, extra);
  const storedAt = (minutes, extra) => Object.assign({ _id: { $oid: 'dddddddddddddddddddddd' + String(10 + minutes) }
    , type: 'sgv', sysTime: new Date(D1 + minutes * 60000).toISOString(), sgv: 1, srvCreated: 5 }, extra);

  const cases = [
    ['new readings (all upserted)', { }, { stored: [ ], upserted: [0, 1] }
      , (api, done) => api.create([sgv(0), sgv(5)], done)],
    ['re-sent readings matched by sysTime + type (stored _id read back)', { }, { stored: [storedAt(0), storedAt(5)] }
      , (api, done) => api.create([sgv(0), sgv(5, { _id: HEX })], done)],
    ['a stored identifier is the target (ID-SIMPLE-MATCH)', { }, { stored: [storedAt(0, { identifier: 'r-1' })] }
      , (api, done) => api.create([sgv(1, { identifier: 'r-1' }), sgv(6, { identifier: 'r-2' }), sgv(7, { identifier: 'r-2' })], done)],
    ['a stored identifier under UUID_HANDLING, with a UUID _id', { uuidHandling: true }, { stored: [storedAt(0, { _id: 'u-1' })], upserted: [1] }
      , (api, done) => api.create([sgv(1, { _id: 'u-1' }), sgv(2, { _id: 'u-2' })], done)],
    ['a re-send with a null and an object member is merged (Q1b)', { }, { stored: [storedAt(0, { noise: 1, meta: { a: 1, b: 2 } })] }
      , (api, done) => api.create([sgv(0, { noise: null, meta: { b: null, c: 3 } }), sgv(0, { meta: { d: 4 } })], done)],
    ['an entry without a type is an insert-only write by a new _id', { }, { stored: [ ], upserted: [0] }
      , (api, done) => api.create([{ sgv: 90, date: D1 }, { sgv: 91, date: D1, isValid: true, _id: HEX2 }], done)],
    ['a failed read-back is logged and the entries are still answered', { }, { stored: [storedAt(0)], failFindAt: 0 }
      , (api, done) => api.create([sgv(0)], done)],
    ['a failed identifier read fails the batch', { }, { stored: [ ], failFindAt: 0 }
      , (api, done) => api.create([sgv(0, { identifier: 'r-1' })], done)],
    ['a failed bulk write', { }, { fail: { bulkWrite: new Error('bulk down') } }
      , (api, done) => api.create([sgv(0)], done)],
    ['an empty batch', { }, { }, (api, done) => api.create([ ], done)],
    ['a non-string type is refused before any write', { }, { }
      , (api, done) => api.create([{ type: 5, sgv: 1, date: D1 }], done)],
    ['remove by 24-hex _id', { }, { deleted: 1 }, (api, done) => api.remove({ find: { _id: HEX } }, done)],
    ['remove by query', { }, { deleted: 2 }
      , (api, done) => api.remove({ find: { type: 'sgv', date: { $gte: D1 } } }, done)]
  ];

  for (const [name, envExtra, cfg, act] of cases) {
    it(name, async function ( ) {
      await same(name, before, after, envExtra, cfg, act);
    });
  }

  it('the comparison is not vacuous: a merged re-send writes $unset, emits and answers', async function ( ) {
    const seen = await observe(after, { }, { stored: [storedAt(0, { noise: 1 })] }
      , (api, done) => api.create([sgv(0, { noise: null })], done));
    const bulk = seen.calls.find(c => c[0] === 'bulkWrite');
    assert.deepEqual(bulk[1][0].updateOne.update.$unset, { isValid: '', noise: '' });
    assert.deepEqual(seen.timeline.map(e => e[0]), ['storage-write-committed', 'data-update', 'data-received']);
    assert.equal(seen.out.callback[1][0]._id, 'dddddddddddddddddddddd10');
  });
});

describe('write(intent): the entries rule table (slice 5)', function ( ) {
  function step (env, calls, cfg) {
    const MongoCollection = require('../lib/api3/storage/mongoCollection');
    const ctx = { bus: new EventEmitter(), store: { collection: ( ) => driver(calls, cfg || { }) } };
    const storage = new MongoCollection(ctx, env, 'entries', 'entries', [ ], { source: 'v1/internal' });
    return writeIntent.forCollection(storage, 'entries', 'v1/internal', { env });
  }

  it('creates by a merging bulk write and deletes by query', function ( ) {
    const rules = writeIntent.COLLECTION_RULES.entries['v1/internal'];
    assert.deepEqual(rules.create, { plan: 'entries', write: 'entries-merge-bulk', onMatch: 'merged' });
    assert.deepEqual(rules.delete, { target: 'query' });
  });

  it('plans sysTime + type as the target, srvModified now and srvCreated on insert only', function ( ) {
    const doc = { type: 'sgv', sgv: 1, dateString: T3, _id: 'not-hex' };
    const planned = step({ }, [ ]).plan({ op: 'create', docs: [doc] });
    const op = planned.ops[0].updateOne;
    assert.deepEqual(op.filter, { sysTime: { $eq: '2026-10-27T08:10:00.000Z' }, type: { $eq: 'sgv' } });
    assert.equal(doc.utcOffset, 120);
    assert(!('_id' in doc), 'a non-hex _id is not written');
    assert.equal(op.update.$setOnInsert.srvCreated, doc.srvModified);
    assert.deepEqual(op.update.$unset, { isValid: '' });
    assert.equal(planned.insertOnly.size, 0);
  });

  it('matches a stored identifier, and a repeat within the batch, before sysTime + type', async function ( ) {
    const calls = [ ];
    const s = step({ }, calls, { stored: [{ _id: { $oid: HEX2 }, identifier: 'r-1', type: 'sgv', sysTime: T1 }] });
    const docs = [{ type: 'sgv', sgv: 1, date: 1, identifier: 'r-1' }, { type: 'sgv', sgv: 1, date: 2, identifier: 'new' }
      , { type: 'sgv', sgv: 1, date: 3, identifier: 'new' }];
    const result = await s.write({ op: 'create', docs });
    const ops = calls.find(c => c[0] === 'bulkWrite')[1];
    assert.deepEqual(ops[0].updateOne.filter, { identifier: { $eq: 'r-1' } });
    assert(ops[1].updateOne.filter.sysTime, 'a new identifier keeps the time match');
    assert.deepEqual(ops[2].updateOne.filter, { identifier: { $eq: 'new' } }, 'a repeat in the batch updates the first');
    assert.equal(String(docs[0]._id), HEX2);
    assert.deepEqual(result.items.map(i => i.outcome), ['merged', 'merged', 'merged']);
  });

  it('answers a failed read-back as readBackError, not a failed write', async function ( ) {
    const result = await step({ }, [ ], { stored: [ ], failFindAt: 0 }).write({ op: 'create', docs: [{ type: 'sgv', sgv: 1, date: 1 }] });
    assert.equal(result.readBackError.message, 'find down');
  });
});

describe('write(intent): devicestatus from API v1 and in-process callers (equal to db3b9e4e)', function ( ) {
  const before = require('./fixtures/write-intent/devicestatus-db3b9e4e');
  const after = require('../lib/server/devicestatus');

  const status = (minutes, extra) => Object.assign({ device: 'openaps://rig', created_at: new Date(Date.parse(T1) + minutes * 60000).toISOString()
    , openaps: { suggested: { predBGs: { IOB: [1, 2, 3, 4] } } } }, extra);
  const dup = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });

  const cases = [
    ['new statuses', { }, { stored: [ ] }, (api, done) => api.create([status(0), status(5)], done)],
    ['one status, not an array, predictions capped', { predictionsMaxSize: 2 }, { stored: [ ] }
      , (api, done) => api.create(status(0), done)],
    ['a stored identifier is acknowledged, not written; an in-batch repeat takes the first _id', { }
      , { stored: f => f.identifier ? [{ _id: { $oid: HEX2 }, identifier: 's-1' }] : [ ] }
      , (api, done) => api.create([status(0, { identifier: 's-1' }), status(1, { identifier: 's-2' }), status(2, { identifier: 's-2' })], done)],
    ['a stored 24-hex _id (string twin) is acknowledged with the ObjectId form', { }
      , { stored: f => f._id ? [{ _id: HEX }, { _id: { $oid: HEX } }] : [ ] }
      , (api, done) => api.create([status(0, { _id: HEX.toUpperCase() }), status(1, { _id: HEX2 }), status(2, { _id: HEX2 })], done)],
    ['every status already stored: nothing written, nothing announced', { }
      , { stored: f => f.identifier ? [{ _id: { $oid: HEX2 }, identifier: 's-1' }] : [ ] }
      , (api, done) => api.create([status(0, { identifier: 's-1' })], done)],
    ['the same created_at and device as a stored status: a second record', { }, { stored: [{ _id: { $oid: HEX2 }, device: 'openaps://rig', created_at: T1 }] }
      , (api, done) => api.create([status(0)], done)],
    ['a duplicate _id stored meanwhile (the race) is dropped, the rest stored', { }
      , { stored: [ ], insertManyError: Object.assign(new Error('bulk'), { writeErrors: [{ index: 0, code: 11000 }] }) }
      , (api, done) => api.create([status(0, { _id: HEX }), status(1)], done)],
    ['any other insert error fails the batch', { }, { stored: [ ], insertManyError: dup }
      , (api, done) => api.create([status(0)], done)],
    ['a failed read fails the batch', { }, { stored: [ ], failFindAt: 0 }
      , (api, done) => api.create([status(0, { identifier: 's-1' })], done)],
    ['an empty batch', { }, { }, (api, done) => api.create([ ], done)],
    ['remove by 24-hex _id', { }, { deleted: 1 }, (api, done) => api.remove({ find: { _id: HEX } }, done)],
    ['remove by query', { }, { deleted: 3 }
      , (api, done) => api.remove({ find: { device: 'openaps://rig', created_at: { $gte: '2026-01-01' } } }, done)]
  ];

  for (const [name, envExtra, cfg, act] of cases) {
    it(name, async function ( ) {
      await same(name, before, after, envExtra, cfg, act);
    });
  }

  it('the comparison is not vacuous: an acknowledged re-send keeps the stored _id and the new one is inserted', async function ( ) {
    const seen = await observe(after, { }, { stored: f => f.identifier ? [{ _id: { $oid: HEX2 }, identifier: 's-1' }] : [ ] }
      , (api, done) => api.create([status(0, { identifier: 's-1' }), status(1)], done));
    const insert = seen.calls.find(c => c[0] === 'insertMany');
    assert.equal(insert[1].length, 1);
    assert.deepEqual(insert[2], { ordered: false });
    assert.equal(seen.out.callback[1][0]._id, HEX2);
    assert.deepEqual(seen.timeline.map(e => e[0]), ['storage-write-committed', 'data-update', 'data-received']);
  });
});

describe('write(intent): the devicestatus rule table (slice 5)', function ( ) {
  function step (calls, cfg) {
    const MongoCollection = require('../lib/api3/storage/mongoCollection');
    const ctx = { bus: new EventEmitter(), store: { collection: ( ) => driver(calls, cfg || { }) } };
    const storage = new MongoCollection(ctx, { }, 'devicestatus', 'devicestatus', [ ], { source: 'v1/internal' });
    return writeIntent.forCollection(storage, 'devicestatus', 'v1/internal', { env: { } });
  }

  it('creates by insert only, with created server dates, and deletes by query', function ( ) {
    const rules = writeIntent.COLLECTION_RULES.devicestatus['v1/internal'];
    assert.deepEqual(rules.create, { write: 'statuses', dates: 'stamp-created' });
    assert.deepEqual(rules.delete, { target: 'query' });
  });

  it('answers each status: inserted, or refused (already stored, repeated in the batch), and lists what was inserted', async function ( ) {
    const docs = [{ identifier: 'old' }, { identifier: 'new' }, { identifier: 'new' }, { _id: HEX2 }];
    const result = await step([ ], { stored: f => f.identifier ? [{ _id: { $oid: HEX }, identifier: 'old' }] : [ ] })
      .write({ op: 'create', docs });
    assert.deepEqual(result.items.map(i => [i.outcome, i.reason]), [['refused', 'already stored'], ['inserted', undefined]
      , ['refused', 'repeated in the batch'], ['inserted', undefined]]);
    assert.equal(String(docs[0]._id), HEX);
    assert.equal(String(docs[2]._id), String(docs[1]._id));
    assert(docs[3]._id instanceof ObjectId, 'a new 24-hex _id is stored as its ObjectId');
    assert.deepEqual(result.inserted, [docs[1], docs[3]]);
    assert(docs[1].srvCreated > 0 && docs[1].srvCreated === docs[1].srvModified);
  });

  it('names a failed read as the status-match rule, with the storage error as cause, before any write', async function ( ) {
    const calls = [ ];
    await assert.rejects(step(calls, { failFindAt: 0 }).write({ op: 'create', docs: [{ identifier: 'x' }] }), function (err) {
      return err instanceof writeIntent.WriteRuleError && err.rule === 'status-match' && err.cause.message === 'find down';
    });
    assert.deepEqual(calls.map(c => c[0]), ['find']);
  });
});
