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
    // The cached wrapper's read-back after a write by identifier.
    findOne: record('findOne', function ( ) { return snap(state.found || [ ]); }),
    // ID-FIRST-MATCH slice 5: the records that store the identifier, read when
    // the identifying read lands on one (P4); state.named, else what was found.
    findFiltered: record('findFiltered', function ( ) { return snap(state.named || state.found || [ ]); }),
    insertOne: record('insertOne', function (doc) {
      if (doc._id === undefined) doc._id = NEW_ID;
      return doc.identifier || String(doc._id);
    }),
    replaceOne: record('replaceOne', function ( ) { return 1; }),
    updateOne: record('updateOne', function ( ) { return { updated: 1 }; })
  };
}

function harness (colName, found, fallbackFields, named) {
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
  const storage = new MongoCachedCollection(ctx, { }, colName, baseStorage(calls, { found, named }));
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
  // CHANGED EXPECTATION (slice 2, ID-Q6): the refusal 9919f8ef made is now
  // WRITE_IDENTIFIER=strict's; under lenient the identifier is treated as absent
  // (tests/api3.create.operation.test.js, tests/api.identifier-format.test.js).
  'a setting with an operator-shaped identifier is refused before any read (strict)': { col: 'settings', found: [ ]
    , body: body({ identifier: { $ne: null } }), env: { write: { identifier: 'strict' } } },
  'a storage that answers nothing is an error (500), as it was': { col: 'treatments', found: undefined
    , body: body({ eventType: 'Note' }) }
};

let clock;
const realNext = srvDates.next;
const realAuthenticate = security.authenticate;

async function runCreate (impl, scenario) {
  clock = 1761739200000;
  const h = harness(scenario.col, scenario.found, scenario.fallback, scenario.named);
  security.authenticate = async function ( ) { return { shiros: [{ check: function ( ) { return true; } }], subject: { name: 'tester' } }; };
  const errors = [ ];
  const realError = console.error;
  console.error = function (err) { errors.push(err && err.message); };
  const doc = snap(scenario.body);
  Object.keys(doc).forEach(function (key) { if (doc[key] === undefined) delete doc[key]; });
  try {
    await impl(h.ctx, scenario.env || { }, { }, h.col)({ body: doc, params: { }, query: { }, baseUrl: '/api/v3', path: '/' + scenario.col
      , get: function ( ) { return undefined; } }, h.res);
  } finally {
    console.error = realError;
  }
  return { calls: h.calls, events: h.events, status: h.res.statusCode, body: h.res.body, headers: h.res.headers, errors };
}

describe('write(intent): API v3 create\'s identifying read, moved into the step', function ( ) {
  beforeEach(function ( ) { srvDates.next = function ( ) { clock += 1; return clock; }; });
  afterEach(function ( ) { srvDates.next = realNext; security.authenticate = realAuthenticate; });

  // CHANGED EXPECTATION (slice 5, ID-Q5): when the identifying read lands on a
  // record that stores the identifier, a second read (findFiltered) takes every
  // record that stores it, for P4. With one such record nothing else changes:
  // the same calls apart from that read, the same emissions and reply.
  Object.keys(CREATES).forEach(function (label) {
    it(label + ': the same storage calls, emissions and reply as at 9919f8ef', async function ( ) {
      const before = await runCreate(BEFORE_CREATE, CREATES[label]);
      const now = await runCreate(NOW_CREATE, CREATES[label]);
      const p4Reads = now.calls.filter(function (call) { return call[0] === 'findFiltered'; });
      const found = CREATES[label].found;
      const reread = Boolean(found && found.length && found[0].identifier && found[0].identifier === CREATES[label].body.identifier);
      assert.equal(p4Reads.length, reread ? 1 : 0);
      if (reread) {
        assert.deepStrictEqual(p4Reads[0].slice(1), [require('../lib/server/storage-reads').toFilter({ identifier: { $eq: ID } })
          , { sort: { _id: -1 }, v1: true, options: { normalize: false } }]);
      }
      now.calls = now.calls.filter(function (call) { return call[0] !== 'findFiltered'; });
      if (label === 'a device status re-sent with its identifier is acknowledged') {
        // CHANGED EXPECTATION (ID-FIRST-MATCH slice 4, ID-Q2): a device status
        // matched by its identifier is written into the stored one, answered
        // with the deduplication reply of a write, and announced; it was
        // acknowledged with no write. The identifying read is the same.
        // CHANGED EXPECTATION (maintainer 2026-10-31, compat card B): the write is a
        // replace (replaceOne by identifier, then the cache's read-back), as on
        // 15.0.9; slice 4 had it merged (updateOne).
        assert.deepStrictEqual(now.calls.slice(0, before.calls.length), before.calls);
        assert.deepStrictEqual(now.calls.slice(before.calls.length).map(function (call) { return call[0]; }), ['replaceOne', 'findOne']);
        assert.equal(now.calls[before.calls.length][1], ID);
        assert.equal(now.status, 200);
        assert.equal(before.status, 200);
        assert.deepStrictEqual(Object.keys(now.body).filter(function (key) { return now.body[key] !== undefined; })
          , ['status', 'lastModified', 'identifier', 'isDeduplication']);
        assert.deepStrictEqual(now.events.map(function (event) { return event[0]; })
          , ['data-update', 'storage-socket-update', 'data-received']);
        assert.deepStrictEqual(before.events, [ ]);
        return;
      }
      assert.deepStrictEqual(now, before);
    });
  });

  it('two records store the identifier: the re-send replaces the one P4 picks, by its _id (slice 5, ID-Q5)', async function ( ) {
    const a = stored({ _id: STORED_ID, eventType: 'Note', notes: 'a' });
    const b = stored({ _id: NEW_ID, created_at: '2026-10-29T10:02:00.000Z', date: 1761732120000, eventType: 'Note', notes: 'b' });
    // API v3's own order names B (the newest); the re-send carries A's time.
    const now = await runCreate(NOW_CREATE, { col: 'treatments', found: [b], named: [b, a]
      , body: body({ eventType: 'Note', notes: 'a again' }) });
    assert.equal(now.status, 200);
    const replace = now.calls.find(function (call) { return call[0] === 'replaceOne'; });
    assert.equal(replace[1], ID);
    assert.equal(replace[2].notes, 'a again');
    assert.deepStrictEqual(replace[3], STORED_ID);
  });

  it('two records store the identifier, neither at the re-send\'s time: the newest, by its _id', async function ( ) {
    const a = stored({ _id: STORED_ID, eventType: 'Note', notes: 'a' });
    const b = stored({ _id: NEW_ID, eventType: 'Note', notes: 'b' });
    const now = await runCreate(NOW_CREATE, { col: 'treatments', found: [b], named: [b, a]
      , body: body({ eventType: 'Note', notes: 'later' , created_at: '2026-10-29T11:00:00.000Z' }) });
    const replace = now.calls.find(function (call) { return call[0] === 'replaceOne'; });
    assert.deepStrictEqual(replace[3], NEW_ID);
  });

  it('gate G2: create, PUT and PATCH read by identifier only through the step; a direct read put back fails', function ( ) {
    const { checkMatchReads, MATCHED } = require('../scripts/check-write-intent');
    // CHANGED EXPECTATION (ID-FIRST-MATCH slice 5, P4 on API v3 PUT and
    // PATCH): their identifying read moved into the step ('v3-addressed'), so
    // the gate holds them to it as it holds create.
    assert.deepEqual(MATCHED, ['lib/api3/generic/create/operation.js', 'lib/api3/generic/update/operation.js'
      , 'lib/api3/generic/patch/operation.js']);
    for (const file of MATCHED) {
      const source = require('node:fs').readFileSync(require.resolve('../' + file), 'utf8');
      assert.deepEqual(checkMatchReads(source), [ ], file);
      const lines = source.split('\n').length;
      for (const bypass of ['col.storage.findOneFilter(col.storage.identifyingFilter(doc.identifier, doc, []), { });']) {
        const issues = checkMatchReads(source + '\n' + bypass + '\n');
        assert.equal(issues.length, 2, file + ': ' + issues.join('; '));
        assert(issues.every(issue => issue.endsWith('line ' + (lines + 1))), issues.join('; '));
      }
    }
  });

});

// ---------------------------------------------------------------------------
// API v3 PUT and PATCH /{identifier} (ID-FIRST-MATCH slice 5, ID-Q5, ID-Q10):
// their identifying read is the step's ('v3-addressed'). Of two or more
// records that store the route's identifier, the write lands on the one P4
// picks by the body's time key, else the newest, by its _id, and the cache
// reads back that one. tests/api3.identifier-p4.test.js runs the same against
// MongoDB.

const NOW_UPDATE = require('../lib/api3/generic/update/operation');
const NOW_PATCH = require('../lib/api3/generic/patch/operation');

async function runAddressed (impl, scenario) {
  clock = 1761739200000;
  const h = harness(scenario.col, scenario.found, [ ], scenario.named);
  security.authenticate = async function ( ) { return { shiros: [{ check: function ( ) { return true; } }], subject: { name: 'tester' } }; };
  const errors = [ ];
  const realError = console.error;
  const realWarn = console.warn;
  const warnings = [ ];
  console.error = function (err) { errors.push(err && err.message); };
  console.warn = function (...args) { warnings.push(args.join(' ')); };
  try {
    await impl(h.ctx, { }, { }, h.col)({ body: snap(scenario.body), params: { identifier: ID }, query: { }
      , get: function ( ) { return undefined; } }, h.res);
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
  return { calls: h.calls, events: h.events, status: h.res.statusCode, errors, warnings };
}

describe('write(intent): API v3 PUT and PATCH /{identifier} land on the record P4 picks', function ( ) {
  beforeEach(function ( ) { srvDates.next = function ( ) { clock += 1; return clock; }; });
  afterEach(function ( ) { srvDates.next = realNext; security.authenticate = realAuthenticate; });

  const A_TIME = { created_at: '2026-10-29T10:00:00.000Z', date: 1761732000000 };
  const B_TIME = { created_at: '2026-10-29T10:02:00.000Z', date: 1761732120000 };
  const a = stored(Object.assign({ _id: STORED_ID, eventType: 'Note', notes: 'a' }, A_TIME));
  const b = stored(Object.assign({ _id: NEW_ID, eventType: 'Note', notes: 'b' }, B_TIME));
  const names = function (outcome) { return outcome.calls.map(function (call) { return call[0]; }); };

  it('the rules name the read and the pick: update and patch match \'v3-addressed\' with pick \'p4\'', function ( ) {
    for (const name of ['treatments', 'entries', 'devicestatus', 'profile', 'food', 'settings']) {
      for (const op of ['update', 'patch']) {
        const rule = writeIntent.COLLECTION_RULES[name].v3[op];
        assert.equal(rule.match, 'v3-addressed', name + ' ' + op);
        assert.deepStrictEqual(rule.identifier, { also: 'shown-id', pick: 'p4' }, name + ' ' + op);
      }
    }
  });

  it('PUT with A\'s time, the newest being B: replaces A by its _id; the cache reads back A', async function ( ) {
    const now = await runAddressed(NOW_UPDATE, { col: 'treatments', found: [b, a], named: [b, a]
      , body: body(Object.assign({ eventType: 'Note', notes: 'a edited' }, A_TIME)) });
    assert.equal(now.status, 200, JSON.stringify(now.errors));
    assert.deepStrictEqual(names(now), ['findOneFilter', 'findFiltered', 'replaceOne', 'findOneFilter']);
    assert.deepStrictEqual(now.calls[0][3], { normalize: false, limit: 2 });
    const replace = now.calls[2];
    assert.equal(replace[1], ID);
    assert.equal(replace[2].notes, 'a edited');
    assert.deepStrictEqual(replace[3], STORED_ID);
    assert.deepStrictEqual(now.calls[3].slice(1), [{ _id: STORED_ID }, null, { normalize: false }]);
    assert.equal(now.warnings.length, 1);
    assert.ok(now.warnings[0].indexOf('treatments v3 PUT: identifier names 2 records; the write lands on '
      + String(STORED_ID) + ' (same time)') !== -1, now.warnings[0]);
    assert.equal(now.warnings[0].indexOf(ID), -1);
  });

  it('PATCH with B\'s time: updates B by its _id', async function ( ) {
    const now = await runAddressed(NOW_PATCH, { col: 'treatments', found: [b, a], named: [b, a]
      , body: { created_at: B_TIME.created_at, notes: 'b edited' } });
    assert.equal(now.status, 200, JSON.stringify(now.errors));
    const update = now.calls.find(function (call) { return call[0] === 'updateOne'; });
    assert.equal(update[1], ID);
    assert.equal(update[2].notes, 'b edited');
    assert.deepStrictEqual(update[4], NEW_ID);
    assert.ok(now.warnings[0].indexOf('treatments v3 PATCH') !== -1 && now.warnings[0].indexOf('(same time)') !== -1);
  });

  it('PATCH with A\'s time: updates A, which the newest-only read refused (immutable date)', async function ( ) {
    const now = await runAddressed(NOW_PATCH, { col: 'treatments', found: [b, a], named: [b, a]
      , body: { date: A_TIME.date, created_at: A_TIME.created_at, notes: 'a edited' } });
    assert.equal(now.status, 200, JSON.stringify(now.errors));
    const update = now.calls.find(function (call) { return call[0] === 'updateOne'; });
    assert.deepStrictEqual(update[4], STORED_ID);
  });

  it('PATCH with no time key: updates the newest (B), as before, by its _id', async function ( ) {
    const now = await runAddressed(NOW_PATCH, { col: 'treatments', found: [b, a], named: [b, a]
      , body: { notes: 'edited' } });
    assert.equal(now.status, 200, JSON.stringify(now.errors));
    const update = now.calls.find(function (call) { return call[0] === 'updateOne'; });
    assert.deepStrictEqual(update[4], NEW_ID);
    assert.ok(now.warnings[0].indexOf('(newest)') !== -1, now.warnings[0]);
  });

  it('one record stores the identifier: one read, the write by identifier, nothing logged', async function ( ) {
    for (const [impl, input] of [[NOW_UPDATE, body(Object.assign({ eventType: 'Note', notes: 'edited' }, A_TIME))]
      , [NOW_PATCH, { notes: 'edited' }]]) {
      const now = await runAddressed(impl, { col: 'treatments', found: [a], body: input });
      assert.equal(now.status, 200, JSON.stringify(now.errors));
      const write = impl === NOW_UPDATE ? 'replaceOne' : 'updateOne';
      assert.deepStrictEqual(names(now), ['findOneFilter', write, 'findOne']);
      assert.equal(now.calls[1].length, impl === NOW_UPDATE ? 3 : 4, 'no _id passed to ' + write);
      assert.deepStrictEqual(now.warnings, [ ]);
    }
  });

  it('the first record stores the identifier, the second is shown by its _id: no P4 read', async function ( ) {
    const shownById = stored({ _id: NEW_ID, identifier: undefined, eventType: 'Note' });
    const now = await runAddressed(NOW_PATCH, { col: 'treatments', found: [a, shownById], body: { notes: 'edited' } });
    assert.equal(now.status, 200, JSON.stringify(now.errors));
    assert.deepStrictEqual(names(now), ['findOneFilter', 'updateOne', 'findOne']);
  });

  it('a picked record that is soft deleted is answered 410 and nothing is written', async function ( ) {
    const deletedA = stored(Object.assign({ _id: STORED_ID, eventType: 'Note', isValid: false }, A_TIME));
    const now = await runAddressed(NOW_PATCH, { col: 'treatments', found: [b, deletedA], named: [b, deletedA]
      , body: { created_at: A_TIME.created_at, notes: 'edited' } });
    assert.equal(now.status, 410);
    assert.deepStrictEqual(names(now), ['findOneFilter', 'findFiltered']);
  });

  it('no record: PUT inserts, PATCH answers 404, as before', async function ( ) {
    const put = await runAddressed(NOW_UPDATE, { col: 'treatments', found: [ ]
      , body: body(Object.assign({ eventType: 'Note' }, A_TIME)) });
    assert.equal(put.status, 201, JSON.stringify(put.errors));
    assert.deepStrictEqual(names(put).slice(0, 2), ['findOneFilter', 'insertOne']);
    const patch = await runAddressed(NOW_PATCH, { col: 'treatments', found: [ ], body: { notes: 'x' } });
    assert.equal(patch.status, 404);
  });
});

// ---------------------------------------------------------------------------
// The socket's dbUpdate, dbUpdateUnset and dbRemove addressed by identifier
// (decision 4, ID-Q10), at the step: which record an edit lands on (P4), and
// what a delete reaches. tests/websocket.identifier-address.test.js runs the
// same end to end against MongoDB.

const reads = require('../lib/server/storage-reads');

// Storage that answers findFiltered with `stored` and records the writes.
// ID-FIRST-MATCH slice 3: the on-deleted read is answered with the deleted
// records of `stored` and kept apart, in `deletedReads` (tests/lib/on-deleted-read.js).
function socketStorage (stored) {
  const calls = [ ];
  const deletedReads = [ ];
  return {
    calls,
    deletedReads,
    findFiltered: async function (ast, opts) {
      if (isOnDeletedRead(ast)) {
        deletedReads.push(ast);
        return stored.filter(function (doc) { return doc.isValid === false; }).map(snap);
      }
      calls.push(['findFiltered', ast, opts]);
      return stored.map(snap);
    },
    updateMany: async function (ast, changes, opts) { calls.push(['updateMany', ast, changes, opts]); return { matchedCount: 1 }; },
    deleteMany: async function (ast, opts) { calls.push(['deleteMany', ast, opts]); return { deletedCount: stored.length }; }
  };
}

const { isOnDeletedRead } = require('./lib/on-deleted-read');
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

  // ID-FIRST-MATCH slice 3 (ID-Q3): an edit addressed by identifier that
  // lands on a soft-deleted record is not applied (WRITE_DELETED_EDIT=ignore).
  it('one soft-deleted record: dbUpdate by identifier is not applied, and nothing is written', async function ( ) {
    const deletedA = Object.assign({ }, A, { isValid: false });
    const { storage, written } = await socketEdit('merge', [deletedA], { notes: 'x' });
    assert.equal(storage.deletedReads.length, 1);
    assert.deepStrictEqual(storage.calls.map(function (c) { return c[0]; }), ['findFiltered', 'findFiltered']);
    assert.deepStrictEqual(written.items, [{ index: 0, outcome: 'unchanged', _id: A_ID, identifier: ID
      , reason: writeIntent.DELETED_REASON }]);
  });

  it('no record: not-found, and nothing is written', async function ( ) {
    const { storage, planned, written } = await socketEdit('merge', [ ], { notes: 'x' });
    assert.equal(planned.match, null);
    assert.deepStrictEqual(storage.calls.map(function (c) { return c[0]; }), ['findFiltered']);
    assert.deepStrictEqual(written.items, [{ index: 0, outcome: 'not-found', _id: undefined, identifier: ID }]);
  });

  it('dbRemove: reads the _ids identifier-match names, deletes those, and returns them as removed', async function ( ) {
    const storage = socketStorage([B, A]);
    const written = await writeIntent.forCollection(storage, 'treatments', 'socket', { env: { } })
      .write({ op: 'delete', target: { identifier: ID } });
    assert.deepStrictEqual(storage.calls, [
      ['findFiltered', reads.toFilter({ identifier: { $eq: ID } }), { projection: { _id: 1 }, v1: true, options: { normalize: false } }]
      , ['deleteMany', reads.toFilter({ $and: [{ identifier: { $eq: ID } }, { _id: { $in: [B_ID, A_ID] } }] }), { v1: true }]]);
    assert.deepStrictEqual(written.items, [{ index: 0, outcome: 'deleted', _id: undefined, identifier: ID }]);
    assert.deepStrictEqual(written.removed, [B_ID, A_ID]);
  });

  it('dbRemove: an identifier that names nothing deletes nothing and removes none', async function ( ) {
    const storage = socketStorage([ ]);
    const written = await writeIntent.forCollection(storage, 'treatments', 'socket', { env: { } })
      .write({ op: 'delete', target: { identifier: ID } });
    assert.deepStrictEqual(storage.calls.map(function (c) { return c[0]; }), ['findFiltered']);
    assert.deepStrictEqual(written.removed, [ ]);
    assert.deepStrictEqual(written.items, [{ index: 0, outcome: 'not-found', _id: undefined, identifier: ID }]);
  });

  it('an _id still decides when it is sent, and a target with neither is refused as before', function ( ) {
    const step = writeIntent.forCollection(socketStorage([ ]), 'treatments', 'socket', { env: { } });
    const byId = step.plan({ op: 'update', form: 'merge', target: { _id: A_ID.toHexString(), identifier: ID }, fields: { } });
    assert.equal(byId.identifier, undefined);
    assert.deepStrictEqual(byId.match.filter, { _id: { $in: require('../lib/server/object-id-forms').idForms(A_ID.toHexString()) } });
    assert.throws(function ( ) { step.plan({ op: 'update', form: 'merge', target: { }, fields: { } }); }, /update needs target._id/);
  });

  // CHANGED EXPECTATION (slice 2, ID-Q6, ID-PLACEHOLDER-LIST): socket addressing
  // uses the shared identifier-format check (isValidIdentifier) instead of
  // slice 1's own list, so `unknown`, whitespace-only values and case variants
  // of a placeholder address nothing either.
  it('addresses only by an identifier of 1 to 256 characters that is not a placeholder', function ( ) {
    const ok = writeIntent.isValidIdentifier;
    assert.equal(ok(ID), true);
    assert.equal(ok('x'.repeat(256)), true);
    ['', '   ', 'undefined', 'Undefined', 'null', 'NULL', 'invalid', 'NaN', 'nan', 'unknown', 'x'.repeat(257), 42, null
      , undefined, { $ne: null }, [ID]]
      .forEach(function (value) { assert.equal(ok(value), false, JSON.stringify(value)); });
  });
});

// ---------------------------------------------------------------------------
// P4 (ID-FIRST-MATCH slice 5, ID-Q5, ID-Q10): of the records one identifier
// names, newest _id first, the one a write lands on.

describe('write(intent): P4, the pick between records that share an identifier', function ( ) {
  const { p4Pick, P4_TIME_KEYS } = writeIntent;
  const OLD = { _id: new ObjectId('5f00000000000000000000e1'), identifier: ID, created_at: '2019-05-11T07:40:00.000Z' };
  const NEW = { _id: new ObjectId('5f00000000000000000000e2'), identifier: ID, created_at: '2019-05-11T07:42:00.000Z' };
  let warnings;
  const realWarn = console.warn;
  beforeEach(function ( ) { warnings = [ ]; console.warn = function (line) { warnings.push(String(line)); }; });
  afterEach(function ( ) { console.warn = realWarn; });

  it('every path that matches on identifier picks by P4', function ( ) {
    const rules = writeIntent.COLLECTION_RULES;
    assert.equal(rules.treatments['v1/internal'].create.forms.batch.identifier.pick, 'p4');
    assert.equal(rules.treatments['v1/internal'].create.forms.one.identifier.pick, 'p4');
    assert.equal(rules.treatments['v1/internal'].update.identifier.pick, 'p4');
    assert.equal(rules.entries['v1/internal'].create.identifier.pick, 'p4');
    assert.equal(rules.devicestatus['v1/internal'].create.identifier.pick, 'p4');
    ['treatments', 'entries', 'devicestatus', 'profile', 'food', 'settings'].forEach(function (name) {
      assert.equal(rules[name].v3.create.identifier.pick, 'p4', name);
    });
    ['treatments', 'entries', 'devicestatus', 'profile', 'food', 'activity'].forEach(function (name) {
      assert.deepStrictEqual(rules[name].socket.update.forms.merge.identifier.timeKeys, P4_TIME_KEYS[name], name);
    });
  });

  it('the time keys per collection', function ( ) {
    assert.deepStrictEqual(P4_TIME_KEYS, { treatments: ['created_at'], devicestatus: ['created_at'], food: ['created_at']
      , activity: ['created_at'], entries: ['sysTime', 'date'], profile: ['startDate'], settings: [ ] });
  });

  it('equal time key: the record at the write\'s time, though another is newer', function ( ) {
    assert.equal(p4Pick([NEW, OLD], { created_at: OLD.created_at }, P4_TIME_KEYS.treatments, 'treatments test'), OLD);
    assert.equal(p4Pick([NEW, OLD], { created_at: NEW.created_at }, P4_TIME_KEYS.treatments, 'treatments test'), NEW);
  });

  it('equal time key spelled another way (offset, precision): the same moment', function ( ) {
    assert.equal(p4Pick([NEW, OLD], { created_at: '2019-05-11T09:40:00+02:00' }, ['created_at'], 'x'), OLD);
    assert.equal(p4Pick([NEW, OLD], { created_at: '2019-05-11T07:40:00Z' }, ['created_at'], 'x'), OLD);
    const entries = [{ _id: NEW._id, date: 1557560520000 }, { _id: OLD._id, date: 1557560400000, sysTime: '2019-05-11T07:40:00.000Z' }];
    assert.equal(p4Pick(entries, { date: 1557560400000 }, P4_TIME_KEYS.entries, 'x'), entries[1]);
    assert.equal(p4Pick(entries, { sysTime: '2019-05-11T07:40:00.000Z' }, P4_TIME_KEYS.entries, 'x'), entries[1]);
  });

  it('two records at the write\'s time: the newer of them', function ( ) {
    const twin = Object.assign({ }, OLD, { _id: new ObjectId('5f00000000000000000000e3') });
    assert.equal(p4Pick([twin, NEW, OLD], { created_at: OLD.created_at }, ['created_at'], 'x'), twin);
  });

  it('a differing time key: the newest by _id', function ( ) {
    assert.equal(p4Pick([NEW, OLD], { created_at: '2019-05-11T08:00:00.000Z' }, P4_TIME_KEYS.treatments, 'x'), NEW);
  });

  it('no time key in the write, or none for the collection (settings): the newest by _id', function ( ) {
    assert.equal(p4Pick([NEW, OLD], { notes: 'x' }, P4_TIME_KEYS.treatments, 'x'), NEW);
    assert.equal(p4Pick([NEW, OLD], { created_at: OLD.created_at }, P4_TIME_KEYS.settings, 'x'), NEW);
    assert.equal(p4Pick([NEW, OLD], { created_at: null }, P4_TIME_KEYS.treatments, 'x'), NEW);
    assert.equal(p4Pick([NEW, OLD], undefined, P4_TIME_KEYS.treatments, 'x'), NEW);
  });

  it('food: API v1 overwrites created_at with the server time, so a re-send falls back to the newest', function ( ) {
    const a = { _id: OLD._id, identifier: ID, created_at: OLD.created_at, carbs: 10 };
    const b = { _id: NEW._id, identifier: ID, created_at: NEW.created_at, carbs: 15 };
    const resent = { identifier: ID, carbs: 10, created_at: new Date(Date.UTC(2026, 9, 30, 12)).toISOString() };
    assert.equal(p4Pick([b, a], resent, P4_TIME_KEYS.food, 'food v1/internal re-send'), b);
  });

  it('no record: null, and nothing logged; one record: that one, and nothing logged', function ( ) {
    assert.equal(p4Pick([ ], { created_at: OLD.created_at }, ['created_at'], 'x'), null);
    assert.equal(p4Pick([OLD], { created_at: NEW.created_at }, ['created_at'], 'x'), OLD);
    assert.deepStrictEqual(warnings, [ ]);
  });

  it('logs every ambiguous match: the path, the count and the picked _id, never the identifier', function ( ) {
    p4Pick([NEW, OLD], { created_at: OLD.created_at }, ['created_at'], 'treatments v1/internal re-send');
    p4Pick([NEW, OLD], { created_at: 'never' }, ['created_at'], 'treatments v1/internal re-send');
    assert.equal(warnings.length, 2);
    assert(warnings[0].includes('treatments v1/internal re-send: identifier names 2 records; the write lands on '
      + OLD._id.toHexString() + ' (same time)'), warnings[0]);
    assert(warnings[1].endsWith(NEW._id.toHexString() + ' (newest)'), warnings[1]);
    warnings.forEach(function (line) { assert(!line.includes(ID), line); });
  });

  it('a string _id (UUID_HANDLING stored the identifier there) is logged by its kind only', function ( ) {
    const legacy = { _id: ID, created_at: OLD.created_at };
    assert.equal(p4Pick([NEW, legacy], { created_at: OLD.created_at }, ['created_at'], 'x'), legacy);
    assert.equal(warnings.length, 1);
    assert(warnings[0].endsWith('a string _id (same time)'), warnings[0]);
    assert(!warnings[0].includes(ID), warnings[0]);
  });
});
