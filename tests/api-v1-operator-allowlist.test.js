'use strict';

// BF-04 -- API v1's query operator allowlist.
//
// Three things are asserted here, in the order they matter:
//
//   1. the ACCEPT SET, exactly: every operator the v1 surface supports is
//      accepted and every other operator a caller can name is refused. The set
//      is the storage seam's, so that landing this ahead of the seam is one
//      narrowing rather than the first of two.
//   2. every refused operator produces a 400 ON THE WIRE, from every API v1
//      endpoint that accepts `find[...]`, naming the operator. Each of these
//      used to be a 500 blaming MongoDB, or worse.
//   3. the allowed operators still select the right documents, end to end
//      through query.js to the driver.
//
// (2) uses stub storage so the assertion is about the HTTP contract of each
// endpoint rather than about MongoDB; (3) uses a real database and is skipped
// when none is configured.

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const request = require('supertest');

const allowlist = require('../lib/server/query-operator-allowlist');
const buildQuery = require('../lib/server/query');
const runWithCallback = require('../lib/storage/run-with-callback');

// ---------------------------------------------------------------- the tables
//
// REFUSED. Every one of these is a real MongoDB query operator that API v1
// carried straight to the driver before this change, because v1 had no
// allowlist at all. The census of 14 client projects found none of them in any
// client's source -- which is the evidence that refusing them is a security
// fix rather than a compatibility break, read with its limit: the census
// measured client SOURCE, so a filter concatenated at runtime or typed into a
// browser is invisible to it. A strong signal on the operator set, not a proof
// of absence.
const REFUSED = [
  // top level
  ['$expr', {$expr: {$eq: ['$sgv', '$mbg']}}],
  ['$nor', {$nor: [{type: 'sgv'}]}],
  ['$text', {$text: {$search: 'sgv'}}],
  ['$jsonSchema', {$jsonSchema: {required: ['sgv']}}],
  ['$comment', {$comment: 'hello'}],
  ['$sampleRate', {$sampleRate: 0.5}],
  // inside a field predicate
  ['$elemMatch', {devices: {$elemMatch: {name: 'x'}}}],
  ['$near', {loc: {$near: [0, 0]}}],
  ['$nearSphere', {loc: {$nearSphere: [0, 0]}}],
  ['$geoWithin', {loc: {$geoWithin: {$center: [[0, 0], 1]}}}],
  ['$geoIntersects', {loc: {$geoIntersects: { }}}],
  ['$not', {sgv: {$not: {$gt: 100}}}],
  ['$all', {tags: {$all: ['a', 'b']}}],
  ['$size', {tags: {$size: 2}}],
  ['$mod', {sgv: {$mod: [2, 0]}}],
  ['$bitsAllSet', {flags: {$bitsAllSet: 3}}],
  ['$slice', {tags: {$slice: 2}}],
  ['$rand', {sgv: {$rand: { }}}],
  // a plain key sitting in predicate position is not a field name either:
  // there is nowhere for it to go, so it is refused with the same message.
  ['stray', {sgv: {$gt: 1, stray: 2}}],
  // refused wherever it appears, not only at the top
  ['$elemMatch nested in $or', {$or: [{type: 'sgv'}, {devices: {$elemMatch: { }}}]}, '$elemMatch'],
  ['$expr nested in $and', {$and: [{$expr: { }}]}, '$expr']
];

// ALLOWED. This is the whole v1 surface: the eight comparisons, $exists,
// $regex with its $options modifier, and the two logical groups. Everything
// the census measured is in here.
const ALLOWED = [
  ['implicit equality', {type: 'sgv'}],
  ['$eq', {type: {$eq: 'sgv'}}],
  ['$ne', {type: {$ne: 'mbg'}}],
  ['$gt', {sgv: {$gt: 100}}],
  ['$gte', {sgv: {$gte: 100}}],
  ['$lt', {sgv: {$lt: 100}}],
  ['$lte', {sgv: {$lte: 100}}],
  ['$in', {type: {$in: ['sgv', 'mbg']}}],
  ['$nin', {type: {$nin: ['cal']}}],
  ['$exists', {mbg: {$exists: true}}],
  // $type is the one departure from the storage seam's set, and it is here
  // because PR #8737 shipped readTypeOperand() to keep find[sgv][$type]=2
  // reaching MongoDB as the number 2. See the module header.
  ['$type as a BSON code', {sgv: {$type: 2}}],
  ['$type as an alias', {sgv: {$type: 'number'}}],
  ['$regex', {device: {$regex: 'dex'}}],
  ['$regex with $options', {device: {$regex: 'DEX', $options: 'i'}}],
  ['$and', {$and: [{type: 'sgv'}, {sgv: {$gte: 100}}]}],
  ['$or', {$or: [{type: 'sgv'}, {type: 'mbg'}]}],
  ['the indexed group form Trio sends', {$and: [{enteredBy: {$ne: 'a'}}, {enteredBy: {$ne: 'b'}}]}],
  ['a dotted path', {'pump.battery': {$lt: 20}}],
  ['a subdocument literal', {pump: {battery: 20}}],
  ['a native RegExp, which the treatments walker produces', {eventType: /Bolus/}],
  // Values are DATA. An operator name stored as a field name, or as part of a
  // value, must not be mistaken for an operator -- refusing these would be the
  // compatibility break this guard must not introduce.
  ['an operator name as a literal value', {payload: {$eq: {$where: 'literal'}}}],
  ['an operator name in a regex', {notes: {$regex: '\\$where'}}]
];

describe('API v1 query operator allowlist', function ( ) {

  // ----------------------------------------------------------- the accept set
  describe('accepts exactly the supported set', function ( ) {

    ALLOWED.forEach(function (row) {
      it('allows ' + row[0], function ( ) {
        assert.doesNotThrow(function ( ) { allowlist(row[1]); });
      });
    });

    REFUSED.forEach(function (row) {
      const name = row[0], find = row[1], operator = row[2] || row[0];
      it('refuses ' + name, function ( ) {
        const error = caught(function ( ) { allowlist(find); });
        assert.equal(error.name, 'MongoQueryValidationError');
        assert.equal(error.status, 400);
        assert.equal(error.statusCode, 400);
        assert.equal(error.operator, operator);
        assert.match(error.message,
          new RegExp('^Query operator ' + escapeRegExp(operator) + ' is not supported'));
        // The error has to say what IS supported, or a client author is stuck.
        assert.match(error.message, /Supported operators: \$and \$or \(top level\)/);
      });
    });

    it('checks the caller input, not the date bound and _id rewrites create() adds afterwards', function ( ) {
      // create() injects its own $gte and, for a UUID _id, a $or. Those must
      // be measured against the allowlist as a design rule, not by accident of
      // running the guard late.
      const built = buildQuery({find: { }}, {dateField: 'date', useEpoch: true, walker: { }});
      assert.doesNotThrow(function ( ) { allowlist(built); });
      assert.equal(typeof built.date.$gte, 'number');
    });

    it('is reached from lib/server/query.js, which every v1 module goes through', function ( ) {
      const error = caught(function ( ) {
        buildQuery({find: {devices: {$elemMatch: { }}}}, {walker: { }});
      });
      assert.equal(error.name, 'MongoQueryValidationError');
      assert.match(error.message, /^Query operator \$elemMatch is not supported/);
    });

    it('leaves $where to the JavaScript guard, which runs first and says more', function ( ) {
      const error = caught(function ( ) { buildQuery({find: {$where: 'this.sgv > 100'}}, { }); });
      assert.equal(error.name, 'MongoQueryValidationError');
      assert.equal(error.status, 400);
      assert.equal(error.message, 'Server-side JavaScript is not allowed in database queries');
    });
  });

  // -------------------------------------------------------- the wire contract
  describe('answers 400 on the wire, naming the operator', function ( ) {
    const env = {settings: { }, name: 'test', version: '0', DISPLAY_UNITS: 'mg/dl'};
    let app, reached;

    function stubList (queryOpts) {
      return function (params, callback) {
        return runWithCallback(function ( ) {
          reached.push(buildQuery(params, queryOpts));
          return [ ];
        }, callback);
      };
    }

    beforeEach(function ( ) {
      reached = [ ];
      app = express();
      require('../lib/middleware/configure-request')(app);
      const wares = require('../lib/middleware/')(env);
      const permit = {isPermitted: function ( ) { return function (req, res, next) { next(); }; }};
      const entriesList = stubList({dateField: 'date', useEpoch: true, walker: { }});
      const ctx = {
        authorization: permit
        , cache: {
          treatments: [ ], devicestatus: [ ], entries: [ ]
          , getData: function ( ) { return [ ]; }
          , getDataRef: function ( ) {
            throw new Error('Queries requiring storage must not read the entries cache');
          }
        }
        , ddata: {sgvs: [ ]}
        , purifier: {purifyObject: function ( ) { }}
        , entries: Object.assign(function ( ) { }, {
          list: entriesList
          , remove: entriesList
          , getEntry: function (id, cb) { cb(null, null); }
          , aggregate: function (opts, cb) {
            return runWithCallback(function ( ) {
              reached.push(buildQuery(opts, {dateField: 'date', useEpoch: true, walker: { }}));
              return 0;
            }, cb);
          }
        })
        , treatments: {list: stubList({dateField: 'created_at', walker: { }})}
        , devicestatus: {list: stubList({dateField: 'created_at', walker: { }})}
        , activity: {list: stubList({dateField: 'created_at', walker: { }})}
        , profile: {list_query: stubList({dateField: 'startDate', walker: { }})}
      };
      app.enable('api');
      app.use('/api/v1', require('../lib/api/entries')(app, wares, ctx, env));
      app.use('/api/v1', require('../lib/api/treatments')(app, wares, ctx, env));
      app.use('/api/v1', require('../lib/api/devicestatus')(app, wares, ctx, env));
      app.use('/api/v1', require('../lib/api/activity')(app, wares, ctx, env));
      app.use('/api/v1', require('../lib/api/profile')(app, wares, ctx, env));
    });

    // One representative refusal of each kind -- a top-level operator and a
    // field-predicate operator -- against every endpoint that takes `find`.
    // The exhaustive operator list is covered above; what varies here is the
    // endpoint's error path, and each of these used to be a 500.
    const routes = ['/api/v1/entries', '/api/v1/treatments', '/api/v1/devicestatus'
      , '/api/v1/activity', '/api/v1/profiles/'];

    routes.forEach(function (route) {
      [['$expr', {$expr: {$eq: [1, 1]}}], ['$elemMatch', {devices: {$elemMatch: {name: 'x'}}}]]
        .forEach(function (row) {
          it('GET ' + route + ' refuses ' + row[0], async function ( ) {
            const response = await request(app)
              .get(route + '?' + encodeFind(row[1]))
              .expect('Content-Type', /json/)
              .expect(400);
            assert.equal(response.body.status, 400);
            assert.match(response.body.message,
              new RegExp('^Query operator ' + escapeRegExp(row[0]) + ' is not supported'));
            assert.equal(reached.length, 0, 'the query must not reach storage');
          });
        });

      it('GET ' + route + ' still serves an allowed filter', async function ( ) {
        await request(app).get(route + '?' + encodeFind({sgv: {$gte: '100'}})).expect(200);
        assert.equal(reached.length, 1);
      });
    });

    it('DELETE /api/v1/entries refuses instead of handing express a 500', async function ( ) {
      const response = await request(app)
        .delete('/api/v1/entries/?' + encodeFind({devices: {$elemMatch: {name: 'x'}}}))
        .expect(400);
      assert.match(response.body.message, /^Query operator \$elemMatch is not supported/);
    });

    it('GET /api/v1/count/entries/where returns 400 for a refused filter', async function ( ) {
      const response = await request(app)
        .get('/api/v1/count/entries/where?' + encodeFind({sgv: {$mod: [2, 0]}}))
        .expect(400);
      assert.match(response.body.message, /^Query operator \$mod is not supported/);
    });
  });

  // ------------------------------------------------------------- end to end
  //
  // The one place the allowed operators are proved to still SELECT correctly,
  // all the way through query.js to the driver. Skipped without a database;
  // CI has one.
  const mongoUrl = process.env.CUSTOMCONNSTR_mongo;
  (mongoUrl ? describe : describe.skip)('selects the right documents for every allowed operator', function ( ) {
    this.timeout(15000);
    const collectionName = 'operator_allowlist_' + randomUUID().replace(/-/g, '');
    let client, col, entries;

    before(async function ( ) {
      const { MongoClient } = require('mongodb');
      client = new MongoClient(mongoUrl);
      await client.connect();
      const db = client.db();
      col = db.collection(collectionName);
      await col.insertMany([
        {date: 1700000000000, type: 'sgv', sgv: 90, device: 'Dexcom G6', pump: {battery: 15}}
        , {date: 1700000300000, type: 'sgv', sgv: 150, device: 'share2', pump: {battery: 80}}
        , {date: 1700000600000, type: 'mbg', mbg: 120, device: 'xdrip'}
      ]);
      entries = require('../lib/server/entries')({entries_collection: collectionName}
        , {store: db, bus: {emit: function ( ) { }}});
    });

    after(async function ( ) {
      try { if (col) await col.drop(); } finally { if (client) await client.close(); }
    });

    const expectations = [
      ['implicit equality', {type: 'sgv'}, [1700000300000, 1700000000000]]
      , ['$eq', {type: {$eq: 'mbg'}}, [1700000600000]]
      , ['$ne', {type: {$ne: 'sgv'}}, [1700000600000]]
      , ['$gt', {sgv: {$gt: '100'}}, [1700000300000]]
      , ['$gte', {sgv: {$gte: '90'}}, [1700000300000, 1700000000000]]
      , ['$lt', {sgv: {$lt: '100'}}, [1700000000000]]
      , ['$lte', {sgv: {$lte: '90'}}, [1700000000000]]
      , ['$in', {type: {$in: ['mbg', 'cal']}}, [1700000600000]]
      , ['$nin', {type: {$nin: ['sgv']}}, [1700000600000]]
      // $exists is asserted on `pump`, which is NOT in the entries type walker.
      // On a walked field the walker runs parseInt over the operator's BOOLEAN
      // argument and produces $exists: NaN, which MongoDB reads as true. That
      // is BF-40, repaired on bf/coercion (PR #8737), not a property of the
      // allowlist -- so it is not papered over with a fixture that agrees.
      , ['$exists', {pump: {$exists: true}}, [1700000300000, 1700000000000]]
      , ['$regex', {device: {$regex: 'share'}}, [1700000300000]]
      , ['$regex with $options', {device: {$regex: 'DEXCOM', $options: 'i'}}, [1700000000000]]
      // Numbers, not strings, inside $and/$or. API v1's type walker only visits
      // TOP-LEVEL find[field] keys, so a numeric comparison nested in a logical
      // group is never converted and reaches MongoDB as a string, where BSON
      // type ordering puts every number below every string and the clause
      // matches nothing. That is older than this change; it is reported rather
      // than worked around, and these rows exercise the operators themselves
      // with values the walker would have produced.
      , ['$and', {$and: [{type: 'sgv'}, {sgv: {$gte: 100}}]}, [1700000300000]]
      , ['$or', {$or: [{type: 'mbg'}, {sgv: {$lt: 100}}]}, [1700000600000, 1700000000000]]
      , ['a dotted path', {'pump.battery': {$lt: 20}}, [1700000000000]]
    ];

    expectations.forEach(function (row) {
      it('reads ' + row[0] + ' end to end', async function ( ) {
        // The fixture is older than create()'s default two-day bound, so every
        // case carries its own date constraint -- exactly as a real client does.
        const find = Object.assign({date: {$gte: '1699999999999'}}, row[1]);
        const rows = await new Promise(function (resolve, reject) {
          entries.list({find: find, count: 10}, function (err, result) {
            return err ? reject(err) : resolve(result);
          });
        });
        assert.deepEqual(rows.map(function (r) { return r.date; }), row[2]);
      });
    });

    it('refuses a refused operator before MongoDB is asked anything', async function ( ) {
      await assert.rejects(new Promise(function (resolve, reject) {
        entries.list({find: {date: {$gte: '1699999999999'}, devices: {$elemMatch: {name: 'x'}}}, count: 10}
          , function (err, result) { return err ? reject(err) : resolve(result); });
      }), function (error) {
        return error.name === 'MongoQueryValidationError' && error.status === 400;
      });
    });
  });
});

// Operator names are interpolated into assertion patterns, and every one of
// them starts with `$` -- which is an anchor in a regular expression, not a
// dollar sign. Two earlier spellings here got that half-right and CodeQL was
// right to flag one of them:
//
//   operator.replace('$', '\\$')          escapes only the FIRST occurrence
//   '^Query operator \\' + row[0]         prepends one backslash and relies on
//                                        row[0] happening to start with `$`
//
// Both worked only because every name in the tables above contains exactly one
// `$` and it is the first character. A name like `$elemMatch nested in $or` --
// which the REFUSED table does carry, in its label column -- breaks the first,
// and any operator reached by a different path breaks the second. Escape
// properly instead of relying on the shape of the current fixtures.
function escapeRegExp (value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// assert.throws() does not hand back the error it caught, and every refusal
// here is asserted field by field, so catch it directly.
function caught (fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({message: 'expected the call to throw, and it did not'});
}

// The v1 wire format: qs-style bracket nesting, which is what clients send and
// what express's default query parser parses back.
function encodeFind (find) {
  const pairs = [ ];
  walk('find', find);
  return pairs.join('&');

  function walk (prefix, value) {
    if (Array.isArray(value)) {
      value.forEach(function (item, i) { walk(prefix + '[' + i + ']', item); });
      return;
    }
    if (value !== null && typeof value === 'object') {
      Object.keys(value).forEach(function (key) { walk(prefix + '[' + key + ']', value[key]); });
      return;
    }
    pairs.push(encodeURIComponent(prefix) + '=' + encodeURIComponent(String(value)));
  }
}
