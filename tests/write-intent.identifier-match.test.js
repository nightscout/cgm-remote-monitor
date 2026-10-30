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
