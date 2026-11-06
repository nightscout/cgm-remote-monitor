'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ObjectId } = require('mongodb');

const writeIntent = require('../lib/storage/write-intent');
const MongoCachedCollection = require('../lib/api3/storage/mongoCachedCollection');
const MongoCachedCollectionBefore = require('./fixtures/write-intent/api3-cached-collection-71738792');
const utils = require('../lib/api3/storage/mongoCollection/utils');
const security = require('../lib/api3/security');
const srvDates = require('../lib/server/srv-dates');

// write(intent) for API v3's generic create, update (PUT), patch and delete
// (WC-STEP-PATCH slice 4). The step writes by identifier through the cached
// storage (lib/api3/storage/mongoCachedCollection), as the v3 modules did, so
// the in-memory cache hears `data-update` `update` with the record written,
// or `remove` with its _id, and never a `remove` with no changes (which
// empties the caches and reloads them from MongoDB). Each module as it was at
// db3b9e4e (tests/fixtures/write-intent/api3-*-db3b9e4e.js) and as it is now
// runs over the same recording storage and bus: the storage calls, the bus
// emissions, the reply and the stored record must be equal.
//
// Write-contract Q-A (WC-STEP-PATCH release 2): every v3 write now resolves
// the _ids it touches first and names them to the cache itself, so the
// storage calls differ by design (a resolve before each write, a read back by
// _id). The baseline runs the db3b9e4e modules over the cached wrapper as it
// is at 71738792 (tests/fixtures/write-intent/api3-cached-collection-71738792.js);
// the bus emissions, the reply and the stored record must still be equal, and
// the writes the same methods with the same identifiers and documents.
//
// Synthetic values only.

const NOW = {
  insert: require('../lib/api3/generic/create/insert'),
  replace: require('../lib/api3/generic/update/replace'),
  patch: require('../lib/api3/generic/patch/operation'),
  delete: require('../lib/api3/generic/delete/operation')
};
const BEFORE = {
  insert: require('./fixtures/write-intent/api3-insert-db3b9e4e'),
  replace: require('./fixtures/write-intent/api3-replace-db3b9e4e'),
  patch: require('./fixtures/write-intent/api3-patch-db3b9e4e'),
  delete: require('./fixtures/write-intent/api3-delete-db3b9e4e')
};

const STORED_ID = new ObjectId('5f00000000000000000000a1');
const NEW_ID = new ObjectId('5f00000000000000000000b2');
// The ObjectId twin of a v1 record stored twice by _id (string and ObjectId).
const TWIN_ID = new ObjectId('5f00000000000000000000c3');
const CACHED = ['treatments', 'entries', 'devicestatus'];
const WRITE_METHODS = ['insertOne', 'replaceOne', 'updateOne', 'updateEveryForm', 'deleteEveryForm'];
const QUERY_METHODS = ['insertMany', 'deleteMany', 'bulkUpsert', 'updateMany', 'replaceFiltered', 'deleteManyOr'];

// A copy at the moment of the call or emission: plain objects and arrays
// copied, anything else (ObjectId, Date) kept.
function snap (value) {
  if (Array.isArray(value)) return value.map(snap);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = { };
    Object.keys(value).forEach(function (key) { out[key] = snap(value[key]); });
    return out;
  }
  return value;
}

// The storage below the cached wrapper (lib/api3/storage/mongoCollection),
// one record deep: it records every call and answers from state.stored. Its
// query-based methods are recorded too, so a write that reached one shows.
function baseStorage (calls, state) {
  const found = function ( ) { return state.stored ? [snap(state.stored)] : [ ]; };
  const record = function (name, answer) {
    return async function (...args) {
      calls.push([name].concat(snap(args)));
      return answer(...args);
    };
  };
  const base = {
    identifyingFilter: utils.identifyingFilter,
    findOne: record('findOne', found),
    findEveryForm: record('findEveryForm', found),
    // As find.findOneFilter: normalized (identifier from _id, _id removed)
    // unless options.normalize is false.
    findOneFilter: record('findOneFilter', function (filter, projection, options) {
      const docs = found();
      if (!options || options.normalize !== false) docs.forEach(utils.normalizeDoc);
      return docs;
    }),
    findMany: record('findMany', found),
    // Id resolution (write-contract Q-A, release 2): the stored record's _id,
    // or every form state.forms names; autoPrune's matches from state.pruned
    // (null: over the cap).
    resolveOne: record('resolveOne', function ( ) { return state.stored ? [state.stored._id] : [ ]; }),
    resolveEveryForm: record('resolveEveryForm', function ( ) {
      if (state.forms !== undefined) return state.forms;
      return state.stored ? [state.stored._id] : [ ];
    }),
    resolveOr: record('resolveOr', function ( ) { return state.pruned === undefined ? [ ] : state.pruned; }),
    findByIds: record('findByIds', found),
    insertOne: record('insertOne', function (doc) {
      // As modify.insertOne with normalize: false: the document carries the
      // _id it was stored under.
      if (doc._id === undefined) doc._id = NEW_ID;
      state.stored = snap(doc);
      return doc.identifier || String(doc._id);
    }),
    replaceOne: record('replaceOne', function (identifier, doc) {
      const matched = state.stored ? 1 : 0;
      state.stored = Object.assign({ _id: state.stored ? state.stored._id : NEW_ID }, snap(doc));
      return matched;
    }),
    updateOne: record('updateOne', function (identifier, set, unset) {
      if (!state.stored) return { updated: 0 };
      Object.assign(state.stored, snap(set));
      Object.keys(unset || { }).forEach(function (key) { delete state.stored[key]; });
      return { updated: 1 };
    }),
    updateEveryForm: record('updateEveryForm', function (identifier, set) {
      if (!state.stored) return { updated: 0 };
      Object.assign(state.stored, snap(set));
      return { updated: 1 };
    }),
    deleteEveryForm: record('deleteEveryForm', function ( ) {
      const deleted = state.stored ? 1 : 0;
      state.stored = null;
      return { deleted: deleted };
    })
  };
  QUERY_METHODS.forEach(function (name) {
    base[name] = record(name, function ( ) {
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1, deletedCount: 1, deleted: 1, upsertedCount: 0 };
    });
  });
  return base;
}

// One API v3 collection over the recording storage, with a bus that records
// what the cache and the storage socket hear.
function harness (colName, stored, options) {
  const opts = options || { };
  const calls = [ ];
  const events = [ ];
  const bus = new EventEmitter();
  ['data-update', 'data-received', 'storage-socket-create', 'storage-socket-update', 'storage-socket-delete']
    .forEach(function (name) { bus.on(name, function (e) { events.push([name, snap(e)]); }); });
  const cache = { };
  CACHED.forEach(function (name) { cache[name] = [ ]; });
  const ctx = {
    bus,
    cache,
    // The derivation for the cache copy (ddata.processRawDataForRuntime),
    // marked so the test sees that it ran.
    ddata: { processRawDataForRuntime: function (docs) { return docs.map(function (d) { return Object.assign({ derived: true }, d); }); } },
    purifier: { purifyObject: function (o) { return o; } }
  };
  const state = { stored: stored ? snap(stored) : null };
  const Wrapper = opts.wrapper || MongoCachedCollection;
  const storage = new Wrapper(ctx, { }, colName, baseStorage(calls, state));
  let pruned = 0;
  const col = {
    colName,
    storage,
    autoPrune: function ( ) { pruned++; },
    resolveDates: function (doc) { return new Date(doc.srvModified); },
    parseDate: function ( ) { },
    dedupFallbackFields: [ ]
  };
  const res = {
    statusCode: null, body: null, headers: { }, headersSent: false,
    setHeader: function (key, value) { this.headers[key] = value; },
    status: function (status) { this.statusCode = status; return this; },
    json: function (body) { this.body = snap(body); this.headersSent = true; return this; }
  };
  const auth = { shiros: [{ check: function ( ) { return true; } }] };
  if (opts.subject !== false) auth.subject = { name: 'tester' };
  const env = Object.assign({ }, opts.env);
  return { calls, events, state, ctx, col, res, auth, env, pruned: function ( ) { return pruned; },
    opCtx: function (req) { return { app: { }, ctx, env, col, req: req || { }, res, auth }; },
    req: function (body, identifier, query) {
      return { body, params: { identifier }, query: query || { }, get: function ( ) { return undefined; } };
    } };
}

// The records the scenarios start from: one treatment, entry, status, food
// and profile stored by v3 (identifier set), one treatment stored by v1 (no
// identifier: v3 addresses it by its _id).
function storedRecord (colName, extra) {
  return Object.assign({ _id: STORED_ID, identifier: 'wi-v3-stored', created_at: '2026-10-29T10:00:00.000Z'
    , date: 1761732000000, utcOffset: 0, app: 'wi-test', device: 'wi-test', srvCreated: 1761732000000
    , srvModified: 1761732001000 }, colName === 'treatments' ? { eventType: 'Note', notes: 'stored' } : { }, extra);
}

const TT_MMOL = { eventType: 'Temporary Target', targetTop: 6.5, targetBottom: 5.5, units: 'mmol', duration: 60 };

// Each scenario: the collection, the stored record, and how the module is
// driven (impl is BEFORE or NOW).
const SCENARIOS = {
  'create a treatment': { col: 'treatments', drive: (impl, h) => impl.insert(h.opCtx(), { identifier: 'wi-v3-new'
    , eventType: 'Note', notes: 'new', created_at: '2026-10-29T11:00:00.000Z', date: 1761735600000, utcOffset: 0
    , app: 'wi-test' }) },
  'create a Temporary Target in mmol (BF-194)': { col: 'treatments', drive: (impl, h) => impl.insert(h.opCtx()
    , Object.assign({ identifier: 'wi-v3-tt', created_at: '2026-10-29T11:00:00.000Z', date: 1761735600000
      , app: 'wi-test', utcOffset: 0 }, TT_MMOL)) },
  'create an entry': { col: 'entries', drive: (impl, h) => impl.insert(h.opCtx(), { identifier: 'wi-v3-e'
    , type: 'sgv', sgv: 120, date: 1761735600000, app: 'wi-test', utcOffset: 0 }) },
  'create a device status': { col: 'devicestatus', drive: (impl, h) => impl.insert(h.opCtx(), { identifier: 'wi-v3-d'
    , created_at: '2026-10-29T11:00:00.000Z', date: 1761735600000, app: 'wi-test', utcOffset: 0, device: 'wi-test' }) },
  'create a food (no cache)': { col: 'food', drive: (impl, h) => impl.insert(h.opCtx(), { identifier: 'wi-v3-f'
    , name: 'apple', carbs: 15, date: 1761735600000, app: 'wi-test', utcOffset: 0 }) },
  'create a profile without a subject': { col: 'profile', options: { subject: false }, drive: (impl, h) => impl.insert(h.opCtx()
    , { identifier: 'wi-v3-p', defaultProfile: 'a', date: 1761735600000, app: 'wi-test', utcOffset: 0 }) },
  'create a setting': { col: 'settings', drive: (impl, h) => impl.insert(h.opCtx()
    , { identifier: 'wi-v3-s', date: 1761735600000, app: 'wi-test', utcOffset: 0 }) },

  'PUT a treatment over a stored one (srvCreated carried, duration derived)': { col: 'treatments'
    , stored: storedRecord('treatments'), drive: (impl, h) => impl.replace(h.opCtx(), { identifier: 'wi-v3-stored'
      , created_at: '2026-10-29T10:00:00.000Z', date: 1761732000000, utcOffset: 0, app: 'wi-test', device: 'wi-test'
      , eventType: 'Note', duration: 30, notes: 'replaced' }, storedRecord('treatments')) },
  'PUT a Temporary Target in mmol (BF-194 after the duration)': { col: 'treatments'
    , stored: storedRecord('treatments', { eventType: 'Temporary Target' })
    , drive: (impl, h) => impl.replace(h.opCtx(), Object.assign({ identifier: 'wi-v3-stored'
      , created_at: '2026-10-29T10:00:00.000Z', date: 1761732000000, app: 'wi-test', utcOffset: 0, device: 'wi-test' }, TT_MMOL)
    , storedRecord('treatments', { eventType: 'Temporary Target' })) },
  'POST deduplicated into a stored record without srvCreated': { col: 'entries'
    , stored: storedRecord('entries', { srvCreated: undefined, type: 'sgv', sgv: 100 })
    , drive: (impl, h) => impl.replace(h.opCtx(), { identifier: 'wi-v3-other', type: 'sgv', sgv: 101
      , date: 1761732000000, app: 'wi-test', utcOffset: 0, device: 'wi-test' }
    , storedRecord('entries', { srvCreated: undefined, type: 'sgv', sgv: 100 }), { isDeduplication: true }) },
  'PUT a food whose stored record is gone (upsert, empty matchedCount)': { col: 'food', stored: null
    , drive: (impl, h) => impl.replace(h.opCtx(), { identifier: 'wi-v3-stored', name: 'pear', date: 1761732000000
      , app: 'wi-test', utcOffset: 0, device: 'wi-test' }, storedRecord('food')) },

  'PATCH a treatment: a field set and a null removed': { col: 'treatments', stored: storedRecord('treatments', { carbs: 10 })
    , drive: (impl, h) => impl.patch(h.ctx, h.env, { }, h.col)(h.req({ notes: 'patched', carbs: null }, 'wi-v3-stored'), h.res) },
  'PATCH a duration, WRITE_VALIDATION off (endmills derived)': { col: 'treatments', stored: storedRecord('treatments')
    , drive: (impl, h) => impl.patch(h.ctx, h.env, { }, h.col)(h.req({ duration: 45 }, 'wi-v3-stored'), h.res) },
  'PATCH notes only, WRITE_VALIDATION=reject (no duration derived)': { col: 'treatments'
    , stored: storedRecord('treatments', { duration: 30 }), options: { env: { writeValidation: 'reject' } }
    , drive: (impl, h) => impl.patch(h.ctx, h.env, { }, h.col)(h.req({ notes: 'only' }, 'wi-v3-stored'), h.res) },
  'PATCH a Temporary Target target in mmol (BF-194 against the stored record)': { col: 'treatments'
    , stored: storedRecord('treatments', TT_MMOL)
    , drive: (impl, h) => impl.patch(h.ctx, h.env, { }, h.col)(h.req({ targetTop: 7 }, 'wi-v3-stored'), h.res) },
  'PATCH a device status without a subject': { col: 'devicestatus', stored: storedRecord('devicestatus'), options: { subject: false }
    , drive: (impl, h) => impl.patch(h.ctx, h.env, { }, h.col)(h.req({ note: 'x' }, 'wi-v3-stored'), h.res) },
  'PATCH a deleted record (410, nothing written)': { col: 'treatments', stored: storedRecord('treatments', { isValid: false })
    , drive: (impl, h) => impl.patch(h.ctx, h.env, { }, h.col)(h.req({ notes: 'x' }, 'wi-v3-stored'), h.res) },

  'DELETE a treatment (marked invalid)': { col: 'treatments', stored: storedRecord('treatments')
    , drive: (impl, h) => impl.delete(h.ctx, h.env, { }, h.col)(h.req(undefined, 'wi-v3-stored'), h.res) },
  'DELETE an entry permanently': { col: 'entries', stored: storedRecord('entries', { type: 'sgv', sgv: 100 })
    , drive: (impl, h) => impl.delete(h.ctx, h.env, { }, h.col)(h.req(undefined, 'wi-v3-stored', { permanent: 'true' }), h.res) },
  'DELETE a food without a subject (no cache)': { col: 'food', stored: storedRecord('food'), options: { subject: false }
    , drive: (impl, h) => impl.delete(h.ctx, h.env, { }, h.col)(h.req(undefined, 'wi-v3-stored'), h.res) },
  'DELETE a record not stored (404, nothing written)': { col: 'devicestatus', stored: null
    , drive: (impl, h) => impl.delete(h.ctx, h.env, { }, h.col)(h.req(undefined, 'wi-v3-stored'), h.res) }
};

let clock;
const realNext = srvDates.next;
const realAuthenticate = security.authenticate;

async function run (impl, scenario, state) {
  clock = 1761739200000;
  const options = Object.assign({ }, scenario.options, impl === BEFORE ? { wrapper: MongoCachedCollectionBefore } : { });
  const h = harness(scenario.col, scenario.stored, options);
  Object.assign(h.state, state);
  security.authenticate = async function ( ) { return h.auth; };
  let thrown = null;
  const errors = [ ];
  const realError = console.error;
  console.error = function (err) { errors.push(err && err.message); };
  try {
    await scenario.drive(impl, h);
  } catch (err) {
    thrown = err.message;
  } finally {
    console.error = realError;
  }
  return { calls: h.calls, events: h.events, stored: h.state.stored, status: h.res.statusCode, headers: h.res.headers
    , body: h.res.body, pruned: h.pruned(), thrown, errors };
}

function dataUpdates (outcome) {
  return outcome.events.filter(function (e) { return e[0] === 'data-update'; }).map(function (e) { return e[1]; });
}

describe('write(intent): API v3 create, update, patch and delete (equal to db3b9e4e)', function ( ) {

  beforeEach(function ( ) {
    srvDates.next = function ( ) { return ++clock; };
  });
  afterEach(function ( ) {
    srvDates.next = realNext;
    security.authenticate = realAuthenticate;
  });

  // CHANGED EXPECTATION (ID-FIRST-MATCH slice 5, P4 on API v3 PUT and
  // PATCH): PATCH's identifying read is the step's ('v3-addressed'). It is the
  // same filter and order, but reads the first two records, not normalized
  // (the step normalizes the one it answers), to see whether a second record
  // stores the identifier. That third argument is checked here and lifted;
  // every other call, emission, reply and stored record stays equal.
  function liftAddressedRead (outcome) {
    outcome.calls.forEach(function (call) {
      if (call[0] === 'findOneFilter' && call.length === 4) {
        assert.deepStrictEqual(call[3], { normalize: false, limit: 2 });
        call.pop();
      }
    });
    return outcome;
  }

  Object.keys(SCENARIOS).forEach(function (name) {
    it(name, async function ( ) {
      const before = await run(BEFORE, SCENARIOS[name]);
      const now = liftAddressedRead(await run(NOW, SCENARIOS[name]));
      // CHANGED EXPECTATION (WC-STEP-PATCH release 2, write-contract Q-A):
      // every write method, its identifier and its document as before; the
      // resolve and read-back calls around them are new by design.
      const writes = function (o) {
        // method, identifier, and the document or fields written (a delete
        // has none: its third argument is now the resolved _ids)
        return o.calls.filter(function (c) { return WRITE_METHODS.indexOf(c[0]) !== -1; })
          .map(function (c) { return c.slice(0, c[0] === 'deleteEveryForm' ? 2 : 3); });
      };
      // CHANGED EXPECTATION (maintainer 2026-10-31, compat card B): a POST that
      // matched a stored record replaces it again (replaceOne), as at db3b9e4e,
      // so 'POST deduplicated into a stored record without srvCreated', which
      // slice 4 (ID-Q8) and release 2 compared apart as a merge (updateOne), is
      // compared like every other scenario.
      assert.deepStrictEqual(writes(now), writes(before), name + ': writes');
      assert.deepStrictEqual(Object.assign({ }, now, { calls: null }), Object.assign({ }, before, { calls: null }), name);
    });
  });

  it('the comparison is not vacuous: every scenario that writes calls storage, emits and answers', async function ( ) {
    for (const name of Object.keys(SCENARIOS)) {
      const outcome = await run(NOW, SCENARIOS[name]);
      assert.ok(outcome.status !== null || outcome.thrown !== null, name + ': no reply');
      if (/nothing written/.test(name)) {
        assert.ok(!outcome.calls.some(function (c) { return /^(insert|replace|update|delete)/.test(c[0]); }), name);
        continue;
      }
      assert.ok(outcome.calls.some(function (c) { return /^(insertOne|replaceOne|updateOne|updateEveryForm|deleteEveryForm)$/.test(c[0]); }), name + ': no write');
      assert.ok(outcome.events.some(function (e) { return /^storage-socket-/.test(e[0]); }) || outcome.thrown, name + ': no storage-socket emission');
    }
  });
});

describe('write(intent): API v3, the rules each scenario names ran', function ( ) {

  beforeEach(function ( ) {
    srvDates.next = function ( ) { return ++clock; };
  });
  afterEach(function ( ) {
    srvDates.next = realNext;
    security.authenticate = realAuthenticate;
  });

  it('BF-194: a Temporary Target in mmol is stored in mg/dL on create, PUT and PATCH', async function ( ) {
    for (const name of ['create a Temporary Target in mmol (BF-194)', 'PUT a Temporary Target in mmol (BF-194 after the duration)'
      , 'PATCH a Temporary Target target in mmol (BF-194 against the stored record)']) {
      const stored = (await run(NOW, SCENARIOS[name])).stored;
      assert.equal(stored.units, 'mg/dl', name);
      assert.ok(stored.targetTop > 100 && stored.targetBottom > 90, name);
    }
  });

  it('server dates: srvModified from the one clock, srvCreated new on create and carried on PUT', async function ( ) {
    const created = await run(NOW, SCENARIOS['create a treatment']);
    assert.equal(created.stored.srvModified, 1761739200001);
    assert.equal(created.stored.srvCreated, 1761739200001);
    const put = await run(NOW, SCENARIOS['PUT a treatment over a stored one (srvCreated carried, duration derived)']);
    assert.equal(put.stored.srvModified, 1761739200001);
    assert.equal(put.stored.srvCreated, 1761732000000);
    const dedup = await run(NOW, SCENARIOS['POST deduplicated into a stored record without srvCreated']);
    assert.equal(dedup.stored.srvCreated, 1761739200001);
  });

  it('duration: endmills derived on PUT and PATCH, but not for a notes-only PATCH in reject mode', async function ( ) {
    const put = await run(NOW, SCENARIOS['PUT a treatment over a stored one (srvCreated carried, duration derived)']);
    assert.equal(put.stored.endmills, Date.parse('2026-10-29T10:00:00.000Z') + 30 * 60000);
    const patched = await run(NOW, SCENARIOS['PATCH a duration, WRITE_VALIDATION off (endmills derived)']);
    assert.equal(patched.stored.endmills, Date.parse('2026-10-29T10:00:00.000Z') + 45 * 60000);
    const notes = await run(NOW, SCENARIOS['PATCH notes only, WRITE_VALIDATION=reject (no duration derived)']);
    assert.equal(notes.stored.endmills, undefined);
  });

  it('subject: subject on create and PUT, modifiedBy on PATCH and DELETE, neither without one', async function ( ) {
    assert.equal((await run(NOW, SCENARIOS['create a treatment'])).stored.subject, 'tester');
    assert.equal((await run(NOW, SCENARIOS['create a profile without a subject'])).stored.subject, undefined);
    assert.equal((await run(NOW, SCENARIOS['PATCH a treatment: a field set and a null removed'])).stored.modifiedBy, 'tester');
    assert.equal((await run(NOW, SCENARIOS['PATCH a device status without a subject'])).stored.modifiedBy, undefined);
    assert.equal((await run(NOW, SCENARIOS['DELETE a treatment (marked invalid)'])).stored.modifiedBy, 'tester');
    assert.equal((await run(NOW, SCENARIOS['DELETE a food without a subject (no cache)'])).stored.modifiedBy, undefined);
  });
});

describe('write(intent): API v3 writes by identifier, so the cache hears only the record written', function ( ) {

  beforeEach(function ( ) {
    srvDates.next = function ( ) { return ++clock; };
  });
  afterEach(function ( ) {
    srvDates.next = realNext;
    security.authenticate = realAuthenticate;
  });

  it('never emits a data-update remove with no changes, which empties the caches and reloads them', async function ( ) {
    const reloads = [ ];
    for (const name of Object.keys(SCENARIOS)) {
      const outcome = await run(NOW, SCENARIOS[name]);
      dataUpdates(outcome).forEach(function (e) {
        if (e.op === 'remove' && e.changes === undefined) reloads.push(name + ': ' + JSON.stringify(e));
      });
    }
    assert.deepStrictEqual(reloads, [ ]);
  });

  it('never calls a query-based storage method', async function ( ) {
    for (const name of Object.keys(SCENARIOS)) {
      const outcome = await run(NOW, SCENARIOS[name]);
      const query = outcome.calls.filter(function (c) { return QUERY_METHODS.indexOf(c[0]) !== -1; });
      assert.deepStrictEqual(query, [ ], name);
    }
  });

  it('create: data-update update with the document written, derived for the cache', async function ( ) {
    const outcome = await run(NOW, SCENARIOS['create a treatment']);
    assert.deepStrictEqual(outcome.calls.map(function (c) { return c[0]; }), ['insertOne']);
    assert.deepStrictEqual(outcome.calls[0][2], { normalize: false });
    const updates = dataUpdates(outcome);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].type, 'treatments');
    assert.equal(updates[0].op, 'update');
    assert.equal(updates[0].changes.length, 1);
    assert.equal(updates[0].changes[0].identifier, 'wi-v3-new');
    assert.equal(String(updates[0].changes[0]._id), String(NEW_ID));
    assert.equal(updates[0].changes[0].derived, true);
    assert.equal(updates[0].changes[0].srvModified, clock);
    assert.equal(updates[0].changes[0].subject, 'tester');
  });

  it('PUT: resolved to the stored _id, replaceOne scoped to it, then data-update update with the record as read back', async function ( ) {
    const outcome = await run(NOW, SCENARIOS['PUT a treatment over a stored one (srvCreated carried, duration derived)']);
    assert.deepStrictEqual(outcome.calls.map(function (c) { return c[0]; }), ['resolveOne', 'replaceOne', 'findByIds']);
    assert.equal(outcome.calls[1][1], 'wi-v3-stored');
    assert.equal(String(outcome.calls[1][3]), String(STORED_ID));
    const updates = dataUpdates(outcome);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].op, 'update');
    assert.equal(updates[0].changes.length, 1);
    assert.equal(String(updates[0].changes[0]._id), String(STORED_ID));
    assert.equal(updates[0].changes[0].notes, 'replaced');
    assert.equal(updates[0].changes[0].srvCreated, 1761732000000);
  });

  it('PATCH: updateOne by identifier with the Merge Patch, then data-update update with the record', async function ( ) {
    const outcome = await run(NOW, SCENARIOS['PATCH a treatment: a field set and a null removed']);
    assert.deepStrictEqual(outcome.calls.map(function (c) { return c[0]; }), ['findOneFilter', 'resolveOne', 'updateOne', 'findByIds']);
    assert.equal(outcome.calls[2][1], 'wi-v3-stored');
    assert.deepStrictEqual(outcome.calls[2][3], { carbs: '' });
    assert.equal(String(outcome.calls[2][4]), String(STORED_ID));
    const updates = dataUpdates(outcome);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].op, 'update');
    assert.equal(updates[0].changes[0].notes, 'patched');
    assert.equal(Object.prototype.hasOwnProperty.call(updates[0].changes[0], 'carbs'), false);
  });

  it('DELETE: marked invalid by every form, then data-update remove with the record\'s _id', async function ( ) {
    const outcome = await run(NOW, SCENARIOS['DELETE a treatment (marked invalid)']);
    assert.deepStrictEqual(outcome.calls.map(function (c) { return c[0]; }), ['findOne', 'resolveEveryForm', 'updateEveryForm']);
    assert.deepStrictEqual(Object.keys(outcome.calls[2][2]), ['isValid', 'srvModified', 'modifiedBy']);
    assert.deepStrictEqual(outcome.calls[2][3].map(String), [String(STORED_ID)]);
    assert.deepStrictEqual(dataUpdates(outcome), [{ type: 'treatments', op: 'remove', changes: [String(STORED_ID)] }]);
  });

  it('DELETE permanent: removed by every form, then data-update remove with the record\'s _id', async function ( ) {
    const outcome = await run(NOW, SCENARIOS['DELETE an entry permanently']);
    assert.deepStrictEqual(outcome.calls.map(function (c) { return c[0]; }), ['findOne', 'resolveEveryForm', 'deleteEveryForm']);
    assert.deepStrictEqual(outcome.calls[2][2].map(String), [String(STORED_ID)]);
    assert.deepStrictEqual(dataUpdates(outcome), [{ type: 'entries', op: 'remove', changes: [String(STORED_ID)] }]);
  });

  // Write-contract Q-A (release 2): a record stored in two forms (the v1
  // string and ObjectId twins) is deleted by every form and both are named,
  // where the cached wrapper used to drop the whole cache for more than one.
  it('DELETE of a record stored in two forms: both _ids named, no cache reload', async function ( ) {
    const outcome = await run(NOW, SCENARIOS['DELETE an entry permanently'], { forms: [STORED_ID, TWIN_ID] });
    assert.deepStrictEqual(outcome.calls[2][2].map(String), [String(STORED_ID), String(TWIN_ID)]);
    assert.deepStrictEqual(dataUpdates(outcome), [{ type: 'entries', op: 'remove', changes: [String(STORED_ID), String(TWIN_ID)] }]);
  });

  it('DELETE (marked invalid) of a record stored in two forms: both _ids named, no cache reload', async function ( ) {
    const outcome = await run(NOW, SCENARIOS['DELETE a treatment (marked invalid)'], { forms: [STORED_ID, TWIN_ID] });
    assert.deepStrictEqual(outcome.calls[2][3].map(String), [String(STORED_ID), String(TWIN_ID)]);
    assert.deepStrictEqual(dataUpdates(outcome), [{ type: 'treatments', op: 'remove', changes: [String(STORED_ID), String(TWIN_ID)] }]);
  });

  it('DELETE over the resolve cap: the plain every-form filter, then the collection\'s cache reloads', async function ( ) {
    const outcome = await run(NOW, SCENARIOS['DELETE an entry permanently'], { forms: null });
    assert.equal(outcome.calls[2][2], null);
    assert.deepStrictEqual(dataUpdates(outcome), [{ type: 'entries', op: 'remove', changes: undefined }]);
  });
});

describe('write(intent): the API v3 rule table (slice 4)', function ( ) {
  const RULES = writeIntent.COLLECTION_RULES;

  it('has v3 rules for every API v3 collection, and none for activity', function ( ) {
    ['treatments', 'entries', 'devicestatus', 'profile', 'food', 'settings'].forEach(function (name) {
      const v3 = RULES[name].v3;
      assert.ok(v3, name);
      assert.equal(v3.create.write, 'v3-insert');
      assert.equal(v3.update.write, 'v3-replace');
      assert.equal(v3.patch.write, 'v3-merge');
      assert.equal(v3.delete.forms.mark.write, 'v3-mark-deleted');
      assert.equal(v3.delete.forms.permanent.write, 'v3-delete-every-form');
    });
    assert.equal(RULES.activity.v3, undefined);
  });

  it('stores a Temporary Target in mg/dL on treatments only, at the point each operation did (BF-194)', function ( ) {
    assert.deepStrictEqual(RULES.treatments.v3.create.stamps, ['units', 'dates-created', 'subject']);
    assert.deepStrictEqual(RULES.treatments.v3.update.stamps, ['dates-replaced', 'subject', 'duration', 'units']);
    assert.deepStrictEqual(RULES.treatments.v3.patch.stamps, ['dates-modified', 'modified-by', 'duration-patch', 'units-patch']);
    ['entries', 'devicestatus', 'profile', 'food', 'settings'].forEach(function (name) {
      assert.deepStrictEqual(RULES[name].v3.create.stamps, ['dates-created', 'subject'], name);
      assert.deepStrictEqual(RULES[name].v3.update.stamps, ['dates-replaced', 'subject', 'duration'], name);
      assert.deepStrictEqual(RULES[name].v3.patch.stamps, ['dates-modified', 'modified-by', 'duration-patch'], name);
    });
  });

  it('answers each write with its outcome', async function ( ) {
    const calls = [ ];
    const state = { stored: storedRecord('food') };
    const step = writeIntent.forCollectionResolved(baseStorage(calls, state), 'food', 'v3', { env: { } });
    srvDates.next = function ( ) { return 1761739200001; };
    try {
      const created = await step.write({ op: 'create', docs: [{ identifier: 'a' }] });
      // Q-A (release 2): the item names the _id the document was stored under.
      assert.deepStrictEqual(created.items, [{ index: 0, outcome: 'inserted', _id: NEW_ID, identifier: 'a' }]);
      state.stored = storedRecord('food');
      const replaced = await step.write({ op: 'update', docs: [{ identifier: 'wi-v3-stored' }]
        , target: { identifier: 'wi-v3-stored', stored: storedRecord('food') } });
      assert.equal(replaced.items[0].outcome, 'replaced');
      assert.equal(String(replaced.items[0]._id), String(STORED_ID));
      const patched = await step.write({ op: 'patch', docs: [{ name: 'b' }]
        , target: { identifier: 'wi-v3-stored', stored: storedRecord('food') } });
      assert.equal(patched.items[0].outcome, 'merged');
      assert.equal(patched.patched.name, 'b');
      const marked = await step.write({ op: 'delete', form: 'mark', target: { identifier: 'wi-v3-stored' } });
      assert.equal(marked.items[0].outcome, 'deleted');
      const removed = await step.write({ op: 'delete', form: 'permanent', target: { identifier: 'wi-v3-stored' } });
      assert.equal(removed.items[0].outcome, 'deleted');
      const again = await step.write({ op: 'delete', form: 'permanent', target: { identifier: 'wi-v3-stored' } });
      assert.equal(again.items[0].outcome, 'not-found');
      const gone = await step.write({ op: 'update', docs: [{ identifier: 'wi-v3-stored' }]
        , target: { identifier: 'wi-v3-stored', stored: storedRecord('food') } });
      assert.equal(gone.items[0].outcome, 'inserted');
    } finally {
      srvDates.next = realNext;
    }
  });

  it('refuses a v3 delete without a form it knows, before any write', async function ( ) {
    const calls = [ ];
    const step = writeIntent.forCollection(baseStorage(calls, { stored: null }), 'food', 'v3', { env: { } });
    await assert.rejects(step.write({ op: 'delete', target: { identifier: 'a' } }), /No write rules for delete form/);
    assert.deepStrictEqual(calls, [ ]);
  });
});

// Write-contract Q-U (release 2): autoPrune goes through the write step. Its
// matches are resolved and named to the cache; over the resolve cap the plain
// filter is deleted and the collection's cache reloads, as before.
describe('write(intent): API v3 autoPrune through the step (Q-U)', function ( ) {
  const FILTER = [{ field: 'srvCreated', operator: 'lt', value: 1700000000000 }];

  async function prune (pruned) {
    const h = harness('entries', null);
    h.state.pruned = pruned;
    const written = await writeIntent.forCollectionResolved(h.col.storage, 'entries', 'v3', { env: { } })
      .write({ op: 'prune', target: { filter: FILTER } });
    return { calls: h.calls, updates: h.events.filter(function (e) { return e[0] === 'data-update'; }).map(function (e) { return e[1]; }), written };
  }

  it('names every document it removed, scoped to them', async function ( ) {
    const outcome = await prune([STORED_ID, TWIN_ID]);
    assert.deepStrictEqual(outcome.calls.map(function (c) { return c[0]; }), ['resolveOr', 'deleteManyOr']);
    assert.deepStrictEqual(outcome.calls[1][1], FILTER);
    assert.deepStrictEqual(outcome.calls[1][2].map(String), [String(STORED_ID), String(TWIN_ID)]);
    assert.deepStrictEqual(outcome.updates, [{ type: 'entries', op: 'remove', changes: [String(STORED_ID), String(TWIN_ID)] }]);
    assert.equal(outcome.written.adapter.deleted, 1);
  });

  it('nothing to prune: nothing announced', async function ( ) {
    const outcome = await prune([ ]);
    assert.deepStrictEqual(outcome.updates, [ ]);
  });

  it('over the resolve cap: the plain filter, then the collection\'s cache reloads', async function ( ) {
    const outcome = await prune(null);
    assert.equal(outcome.calls[1][2], null);
    assert.deepStrictEqual(outcome.updates, [{ type: 'entries', op: 'remove', changes: undefined }]);
  });
});
