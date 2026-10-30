'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ObjectId } = require('mongodb');

const writeIntent = require('../lib/storage/write-intent');
const MongoCachedCollection = require('../lib/api3/storage/mongoCachedCollection');
const utils = require('../lib/api3/storage/mongoCollection/utils');
const security = require('../lib/api3/security');
const srvDates = require('../lib/server/srv-dates');

// identifier-match (ID-FIRST-MATCH slice 1; design note 2026-10-29 §1.1): one
// rule for the stored records a client `identifier` names, used by every path
// that already matched on identifier. Slice 1 changes no outcome, so this file
// checks that each path asks the rule for exactly the query it built before,
// and that API v3's identifying read, moved from
// lib/api3/generic/create/operation.js into the step, makes the same storage
// calls and gives the same reply as that module at 9919f8ef
// (tests/fixtures/write-intent/api3-create-9919f8ef.js).
//
// Synthetic values only.

const NOW_CREATE = require('../lib/api3/generic/create/operation');
const BEFORE_CREATE = require('./fixtures/write-intent/api3-create-9919f8ef');

const ID = 'f1d2c3b4-0000-4000-8000-00000000b001';
const HEX = '5f00000000000000000000c1';
const STORED_ID = new ObjectId('5f00000000000000000000a1');
const NEW_ID = new ObjectId('5f00000000000000000000b2');

describe('write(intent): identifier-match, the rule each path asks', function ( ) {
  const { identifierMatch } = writeIntent;

  it('v1 / in-process treatments and entries: the identifier, under UUID_HANDLING also a record stored with it as its _id', function ( ) {
    const condition = { $eq: ID };
    assert.deepStrictEqual(identifierMatch(condition, 'uuid-id', { uuidHandling: true })
      , [{ identifier: condition }, { _id: condition }]);
    assert.deepStrictEqual(identifierMatch(condition, 'uuid-id', { uuidHandling: false })
      , [{ identifier: condition }]);
  });

  it('v1 / in-process device status and the treatments batch reply: the identifier alone', function ( ) {
    const condition = { $in: [ID, 'other'] };
    assert.deepStrictEqual(identifierMatch(condition, 'none', { uuidHandling: true }), [{ identifier: condition }]);
  });

  it('API v3: the identifier, and a record without one whose _id it is, in either stored form', function ( ) {
    assert.deepStrictEqual(identifierMatch({ $eq: HEX }, 'shown-id', { })
      , [{ identifier: { $eq: HEX } }].concat(utils.filterForEveryForm(HEX).$or.slice(1)));
    assert.deepStrictEqual(identifierMatch({ $eq: ID }, 'shown-id', { }).length, 2);
  });

  it('refuses a rule it does not know, before any query is built', function ( ) {
    assert.throws(function ( ) { identifierMatch({ $eq: ID }, 'nearest', { }); }, /Unknown identifier-match rule: nearest/);
  });

  it('every path that matches on identifier names its rule in the rule table', function ( ) {
    const rules = writeIntent.COLLECTION_RULES;
    assert.equal(rules.treatments['v1/internal'].create.forms.batch.identifier.also, 'uuid-id');
    assert.equal(rules.treatments['v1/internal'].create.forms.one.identifier.also, 'uuid-id');
    assert.equal(rules.treatments['v1/internal'].update.identifier.also, 'uuid-id');
    assert.equal(rules.entries['v1/internal'].create.identifier.also, 'uuid-id');
    assert.equal(rules.devicestatus['v1/internal'].create.identifier.also, 'none');
    ['treatments', 'entries', 'devicestatus', 'profile', 'food', 'settings'].forEach(function (name) {
      assert.equal(rules[name].v3.create.identifier.also, 'shown-id', name);
    });
  });
});

// ---------------------------------------------------------------------------
// API v3 create: the identifying read, before and after the move.

function snap (value) {
  if (Array.isArray(value)) return value.map(snap);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = { };
    Object.keys(value).forEach(function (key) { out[key] = snap(value[key]); });
    return out;
  }
  return value;
}

// The storage below the cached wrapper, one record deep, recording every
// call. findOneFilter answers state.found (undefined: the storage failed to
// answer, which create reports as an error).
function baseStorage (calls, state) {
  const record = function (name, answer) {
    return async function (...args) {
      calls.push([name].concat(snap(args)));
      return answer(...args);
    };
  };
  return {
    identifyingFilter: utils.identifyingFilter,
    findOneFilter: record('findOneFilter', function ( ) { return state.found === undefined ? undefined : snap(state.found); }),
    insertOne: record('insertOne', function (doc) {
      if (doc._id === undefined) doc._id = NEW_ID;
      return doc.identifier || String(doc._id);
    }),
    replaceOne: record('replaceOne', function ( ) { return 1; }),
    updateOne: record('updateOne', function ( ) { return { updated: 1 }; })
  };
}

function harness (colName, found, fallbackFields) {
  const calls = [ ];
  const events = [ ];
  const bus = new EventEmitter();
  ['data-update', 'data-received', 'storage-socket-create', 'storage-socket-update']
    .forEach(function (name) { bus.on(name, function (e) { events.push([name, snap(e)]); }); });
  const ctx = {
    bus,
    cache: { treatments: [ ], entries: [ ], devicestatus: [ ] },
    ddata: { processRawDataForRuntime: function (docs) { return docs; } },
    purifier: { purifyObject: function (o) { return o; } }
  };
  const storage = new MongoCachedCollection(ctx, { }, colName, baseStorage(calls, { found }));
  const col = {
    colName,
    storage,
    autoPrune: function ( ) { },
    resolveDates: function (doc) { return new Date(doc.srvModified); },
    parseDate: function ( ) { },
    dedupFallbackFields: fallbackFields || [ ]
  };
  const res = {
    statusCode: null, body: null, headers: { }, headersSent: false,
    setHeader: function (key, value) { this.headers[key] = value; },
    status: function (status) { this.statusCode = status; return this; },
    json: function (body) { this.body = snap(body); this.headersSent = true; return this; }
  };
  return { calls, events, ctx, col, res };
}

function stored (extra) {
  return Object.assign({ _id: STORED_ID, identifier: ID, created_at: '2026-10-29T10:00:00.000Z', date: 1761732000000
    , utcOffset: 0, app: 'wi-test', device: 'wi-test', srvCreated: 1761732000000, srvModified: 1761732001000 }, extra);
}

function body (extra) {
  return Object.assign({ identifier: ID, created_at: '2026-10-29T10:00:00.000Z', date: 1761732000000, utcOffset: 0
    , app: 'wi-test', device: 'wi-test' }, extra);
}

// Each scenario: the collection, what findOneFilter answers, the fallback
// fields, and the body POSTed.
const CREATES = {
  'a new treatment is inserted': { col: 'treatments', found: [ ], body: body({ eventType: 'Note', notes: 'new' }) },
  'a treatment re-sent with its identifier replaces the stored one': { col: 'treatments'
    , found: [stored({ eventType: 'Note', notes: 'old' })], body: body({ eventType: 'Note', notes: 'again' }) },
  'an entry re-sent by the record its 24-hex identifier shows (no identifier stored)': { col: 'entries'
    , found: [stored({ _id: new ObjectId(HEX), identifier: undefined, type: 'sgv', sgv: 100 })]
    , body: body({ identifier: HEX, type: 'sgv', sgv: 101 }), fallback: ['date', 'type'] },
  'an entry without an identifier, matched on its fallback fields': { col: 'entries'
    , found: [stored({ identifier: undefined, type: 'sgv', sgv: 100 })]
    , body: body({ identifier: undefined, type: 'sgv', sgv: 102 }), fallback: ['date', 'type'] },
  'a device status re-sent with its identifier is acknowledged': { col: 'devicestatus', found: [stored({ })]
    , body: body({ }), fallback: ['created_at', 'device'] },
  'a device status matched on created_at and device replaces': { col: 'devicestatus'
    , found: [stored({ identifier: undefined })], body: body({ identifier: undefined, uploaderBattery: 50 })
    , fallback: ['created_at', 'device'] },
  'a food with only some fallback fields is inserted': { col: 'food', found: [ ]
    , body: body({ created_at: undefined, name: 'apple' }), fallback: ['created_at'] },
  'a setting with an operator-shaped identifier is refused before any read': { col: 'settings', found: [ ]
    , body: body({ identifier: { $ne: null } }) },
  'a storage that answers nothing is an error (500), as it was': { col: 'treatments', found: undefined
    , body: body({ eventType: 'Note' }) }
};

let clock;
const realNext = srvDates.next;
const realAuthenticate = security.authenticate;

async function runCreate (impl, scenario) {
  clock = 1761739200000;
  const h = harness(scenario.col, scenario.found, scenario.fallback);
  security.authenticate = async function ( ) { return { shiros: [{ check: function ( ) { return true; } }], subject: { name: 'tester' } }; };
  const errors = [ ];
  const realError = console.error;
  console.error = function (err) { errors.push(err && err.message); };
  const doc = snap(scenario.body);
  Object.keys(doc).forEach(function (key) { if (doc[key] === undefined) delete doc[key]; });
  try {
    await impl(h.ctx, { }, { }, h.col)({ body: doc, params: { }, query: { }, baseUrl: '/api/v3', path: '/' + scenario.col
      , get: function ( ) { return undefined; } }, h.res);
  } finally {
    console.error = realError;
  }
  return { calls: h.calls, events: h.events, status: h.res.statusCode, body: h.res.body, headers: h.res.headers, errors };
}

describe('write(intent): API v3 create\'s identifying read, moved into the step', function ( ) {
  beforeEach(function ( ) { srvDates.next = function ( ) { clock += 1; return clock; }; });
  afterEach(function ( ) { srvDates.next = realNext; security.authenticate = realAuthenticate; });

  Object.keys(CREATES).forEach(function (label) {
    it(label + ': the same storage calls, emissions and reply as at 9919f8ef', async function ( ) {
      const before = await runCreate(BEFORE_CREATE, CREATES[label]);
      const now = await runCreate(NOW_CREATE, CREATES[label]);
      assert.deepStrictEqual(now, before);
    });
  });

  it('gate G2: create/operation.js reads by identifier only through the step; a direct read put back fails', function ( ) {
    const { checkMatchReads, MATCHED } = require('../scripts/check-write-intent');
    assert.deepEqual(MATCHED, ['lib/api3/generic/create/operation.js']);
    const source = require('node:fs').readFileSync(require.resolve('../lib/api3/generic/create/operation'), 'utf8');
    assert.deepEqual(checkMatchReads(source), [ ]);
    const lines = source.split('\n').length;
    for (const bypass of ['col.storage.findOneFilter(col.storage.identifyingFilter(doc.identifier, doc, []), { });']) {
      const issues = checkMatchReads(source + '\n' + bypass + '\n');
      assert.equal(issues.length, 2, issues.join('; '));
      assert(issues.every(issue => issue.endsWith('line ' + (lines + 1))), issues.join('; '));
    }
  });

});

// ---------------------------------------------------------------------------
// The socket's dbUpdate, dbUpdateUnset and dbRemove addressed by identifier
// (decision 4, ID-Q10), at the step: which record an edit lands on (P4), and
// what a delete reaches. tests/websocket.identifier-address.test.js runs the
// same end to end against MongoDB.

const reads = require('../lib/server/storage-reads');

// Storage that answers findFiltered with `stored` and records the writes.
function socketStorage (stored) {
  const calls = [ ];
  return {
    calls,
    findFiltered: async function (ast, opts) { calls.push(['findFiltered', ast, opts]); return stored.map(snap); },
    updateMany: async function (ast, changes, opts) { calls.push(['updateMany', ast, changes, opts]); return { matchedCount: 1 }; },
    deleteMany: async function (ast, opts) { calls.push(['deleteMany', ast, opts]); return { deletedCount: stored.length }; }
  };
}

const A_ID = new ObjectId('5f00000000000000000000d1');
const B_ID = new ObjectId('5f00000000000000000000d2');
const A = { _id: A_ID, identifier: ID, created_at: '2019-05-11T07:40:00.000Z', notes: 'a' };
const B = { _id: B_ID, identifier: ID, created_at: '2019-05-11T07:42:00.000Z', notes: 'b' };

async function socketEdit (form, stored, fields) {
  const storage = socketStorage(stored);
  const step = writeIntent.forCollection(storage, 'treatments', 'socket', { env: { } });
  const planned = step.plan({ op: 'update', form: form, target: { identifier: ID }, fields: fields });
  assert.equal(planned.match, null);
  const written = await step.write(planned);
  return { storage, planned, written };
}

describe('write(intent): the socket\'s edit and remove addressed by identifier (decision 4)', function ( ) {

  it('reads the records identifier-match names, newest _id first, soft-deleted ones included', async function ( ) {
    const { storage } = await socketEdit('merge', [B, A], { notes: 'x' });
    assert.deepStrictEqual(storage.calls[0], ['findFiltered', reads.toFilter({ identifier: { $eq: ID } })
      , { sort: { _id: -1 }, v1: true, options: { normalize: false } }]);
  });

  it('one record: dbUpdate writes it by every stored form of its _id, as an edit by that _id', async function ( ) {
    const { storage, planned, written } = await socketEdit('merge', [A], { notes: 'x' });
    assert.deepStrictEqual(planned.match, { filter: { _id: { $in: require('../lib/server/object-id-forms').idForms(A_ID) } }, many: true });
    assert.equal(storage.calls[1][0], 'updateMany');
    assert.deepStrictEqual(storage.calls[1][1], reads.toFilter(planned.match.filter));
    assert.deepStrictEqual(written.items, [{ index: 0, outcome: 'merged', _id: undefined, identifier: ID }]);
  });

  it('two records: dbUpdate with the created_at of the older lands on it (P4, time key)', async function ( ) {
    const { planned } = await socketEdit('merge', [B, A], { created_at: A.created_at, notes: 'x' });
    assert.deepStrictEqual(planned.match.filter, { _id: { $in: require('../lib/server/object-id-forms').idForms(A_ID) } });
  });

  it('two records: dbUpdate without a matching time lands on the newest by _id (P4)', async function ( ) {
    const { planned } = await socketEdit('merge', [B, A], { created_at: '2019-05-11T08:00:00.000Z', notes: 'x' });
    assert.deepStrictEqual(planned.match.filter, { _id: { $in: require('../lib/server/object-id-forms').idForms(B_ID) } });
  });

  it('two records: dbUpdateUnset lands on the newest by _id (P4)', async function ( ) {
    const { planned, storage } = await socketEdit('unset', [B, A], { notes: 1 });
    assert.deepStrictEqual(planned.match.filter, { _id: { $in: require('../lib/server/object-id-forms').idForms(B_ID) } });
    assert.equal(storage.calls[1][0], 'updateMany');
  });

  it('no record: not-found, and nothing is written', async function ( ) {
    const { storage, planned, written } = await socketEdit('merge', [ ], { notes: 'x' });
    assert.equal(planned.match, null);
    assert.deepStrictEqual(storage.calls.map(function (c) { return c[0]; }), ['findFiltered']);
    assert.deepStrictEqual(written.items, [{ index: 0, outcome: 'not-found', _id: undefined, identifier: ID }]);
  });

  it('dbRemove: one deleteMany of every record identifier-match names', async function ( ) {
    const storage = socketStorage([A, B]);
    const written = await writeIntent.forCollection(storage, 'treatments', 'socket', { env: { } })
      .write({ op: 'delete', target: { identifier: ID } });
    assert.deepStrictEqual(storage.calls, [['deleteMany', reads.toFilter({ identifier: { $eq: ID } }), { v1: true }]]);
    assert.deepStrictEqual(written.items, [{ index: 0, outcome: 'deleted', _id: undefined, identifier: ID }]);
  });

  it('an _id still decides when it is sent, and a target with neither is refused as before', function ( ) {
    const step = writeIntent.forCollection(socketStorage([ ]), 'treatments', 'socket', { env: { } });
    const byId = step.plan({ op: 'update', form: 'merge', target: { _id: A_ID.toHexString(), identifier: ID }, fields: { } });
    assert.equal(byId.identifier, undefined);
    assert.deepStrictEqual(byId.match.filter, { _id: { $in: require('../lib/server/object-id-forms').idForms(A_ID.toHexString()) } });
    assert.throws(function ( ) { step.plan({ op: 'update', form: 'merge', target: { }, fields: { } }); }, /update needs target._id/);
  });

  it('addresses only by an identifier of 1 to 256 characters that is not a placeholder', function ( ) {
    const ok = writeIntent.isAddressableIdentifier;
    assert.equal(ok(ID), true);
    assert.equal(ok('x'.repeat(256)), true);
    ['', 'undefined', 'null', 'invalid', 'NaN', 'x'.repeat(257), 42, null, undefined, { $ne: null }, [ID]]
      .forEach(function (value) { assert.equal(ok(value), false, JSON.stringify(value)); });
  });
});
