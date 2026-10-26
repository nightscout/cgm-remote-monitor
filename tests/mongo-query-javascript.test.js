'use strict';

// BF-04. API v1 has no operator allowlist: `find[...]` is parsed by qs,
// type-walked by lib/server/query.js and handed to the driver as a MongoDB
// filter document, so whatever operator a caller names travels with it.
//
// This file covers the narrowest and worst part of that -- the operators that
// make MongoDB EXECUTE JavaScript. Measured on mongod 7.0 against the two
// documents [{_id: 1, sgv: 100}, {_id: 2}]:
//
//   db.c.find({$where: "this.sgv == 100"})  ->  [{_id: 1, sgv: 100}]
//
// and `GET /api/v1/entries.json?find[$where]=...` produces exactly that filter
// on origin/dev, for a caller holding only the `readable` role, which is what
// AUTH_DEFAULT_ROLES grants by default.
//
// The whole set of operators outside the supported list is refused by
// tests/api-v1-operator-allowlist.test.js. $where, $function and $accumulator
// keep their own guard and their own message because 'server-side JavaScript
// is not allowed' says more to a client author than 'unsupported operator'.

const assert = require('node:assert/strict');
const guard = require('../lib/storage/assert-no-query-javascript');
const query = require('../lib/server/query');
const find = require('../lib/api3/storage/mongoCollection/find');
const modify = require('../lib/api3/storage/mongoCollection/modify');
const { ObjectId } = require('mongodb');

function rejected (error) {
  assert.equal(error.name, 'MongoQueryValidationError');
  assert.equal(error.statusCode, 400);
  assert.equal(error.status, 400);
  // The refused code must never be echoed back to the caller.
  assert(!error.message.includes('owned-expression'));
  return true;
}

describe('MongoDB query JavaScript boundary', function ( ) {

  const dangerous = [
    {$where: 'owned-expression'},
    {$and: [{date: {$gt: 0}}, {$or: [{$where: 'owned-expression'}]}]},
    {$expr: {$function: {body: 'owned-expression', args: [], lang: 'js'}}},
    {$expr: {$eq: [{$function: {body: 'owned-expression', args: [], lang: 'js'}}, true]}},
    {items: {$all: [{$elemMatch: {$where: 'owned-expression'}}]}},
    {$expr: {$accumulator: {init: 'owned-expression', accumulate: 'owned-expression', lang: 'js'}}}
  ];

  dangerous.forEach(function (filter, index) {
    it('refuses executable filter shape ' + index + ' before query conversion', function ( ) {
      assert.throws(function ( ) { query({find: filter}); }, rejected);
    });
  });

  it('refuses $where through the shape a query string actually produces', function ( ) {
    // qs.parse('find[$where]=this.sgv>100'), which is what express hands the
    // v1 handlers. The guard has to fire on the parsed object, not on a
    // hand-built filter that happens to have the same keys.
    const qs = require('qs');
    assert.throws(function ( ) {
      query(qs.parse('find[$where]=' + encodeURIComponent('this.sgv > 100')), { });
    }, rejected);
  });

  it('preserves normal filters and explicit literal data without mutation', function ( ) {
    const objectId = new ObjectId();
    const filter = {
      _id: objectId
      , $and: [{sgv: {$gte: 80, $lt: 200}}, {type: {$in: ['sgv', 'mbg']}}]
      , notes: {$regex: 'literal \\$where and function', $options: 'i'}
      , obj: {$eq: {$where: 'literal document field'}}
      , schema: {$jsonSchema: {properties: {$where: {bsonType: 'string'}}}}
    };
    const snapshot = JSON.stringify(filter);
    assert.equal(guard(filter), filter);
    assert.equal(filter._id, objectId);
    assert.equal(JSON.stringify(filter), snapshot);
  });

  it('treats an operator name stored as DATA as data', function ( ) {
    // {payload: {$eq: {$where: 'literal'}}} asks whether the stored document
    // has a field literally named $where. Refusing it would be a compatibility
    // break invented by the guard, which is the one failure mode it must not
    // have.
    assert.doesNotThrow(function ( ) { guard({payload: {$eq: {$where: 'literal'}}}); });
    assert.doesNotThrow(function ( ) { guard({notes: {$regex: '\\$where'}}); });
  });

  it('preserves an operator name inside $literal in an expression', function ( ) {
    const filter = {$expr: {$eq: [{$literal: {$function: 'literal document field'}}, '$payload']}};
    const snapshot = JSON.stringify(filter);
    assert.equal(guard(filter), filter);
    assert.equal(JSON.stringify(filter), snapshot);
  });

  it('preserves literal values inside nested aggregation match stages', function ( ) {
    const pipeline = {$expr: {$facet: {rows: [{$match: {payload: {$eq: {$where: 'literal'}}}}]}}};
    assert.equal(guard(pipeline), pipeline);
    pipeline.$expr.$facet.rows.push({$match: {$where: 'owned-expression'}});
    assert.throws(function ( ) { guard(pipeline); }, rejected);
  });

  it('checks cyclic objects in both query and expression contexts', function ( ) {
    const shared = {$eq: {$function: {body: 'owned-expression'}}};
    const root = {literal: shared, $expr: shared};
    root.self = root;
    assert.throws(function ( ) { guard(root); }, rejected);
    const benign = {sgv: 100};
    benign.self = benign;
    assert.equal(guard(benign), benign);
  });

  it('leaves a query with no find at all alone', function ( ) {
    assert.doesNotThrow(function ( ) { query({ }, { }); });
    assert.doesNotThrow(function ( ) { query(undefined, { }); });
  });

  it('refuses API v3 filters, projections and delete filters before database I/O', async function ( ) {
    const col = {find: () => assert.fail('find must not run'), deleteMany: () => assert.fail('delete must not run')};
    for (const filter of dangerous) {
      await assert.rejects(find.findMany(col, {filter}), rejected);
      await assert.rejects(find.findOneFilter(col, filter, {}), rejected);
      await assert.rejects(modify.deleteManyOr(col, filter), rejected);
    }
    const projection = {computed: {$function: {body: 'owned-expression', args: [], lang: 'js'}}};
    await assert.rejects(find.findMany(col, {projection}), rejected);
    await assert.rejects(find.findOneFilter(col, {}, projection), rejected);
    await assert.rejects(find.findOne(col, new ObjectId().toHexString(), projection), rejected);
  });

  // lib/server/aggregate.js refuses a caller's `pipeline` outright (BF-70), so
  // the JavaScript guard is reached through the caller's `find` and through
  // the constructor's own pipeline, which is the backstop.
  function aggregateOver (confPipeline) {
    const api = Object.assign(function ( ) {
      return {aggregate: () => assert.fail('aggregate must not run')};
    }, {query_for: function (opts) { return query(opts, { }); }});
    return require('../lib/server/aggregate')({pipeline: confPipeline}, api);
  }

  it('reports an aggregate refusal through its callback once', async function ( ) {
    const aggregate = aggregateOver([ ]);
    let calls = 0;
    await new Promise((resolve, reject) => {
      aggregate({find: {$where: 'owned-expression'}}, error => {
        try { calls++; rejected(error); resolve(); } catch (failure) { reject(failure); }
      });
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
  });

  it('refuses aggregate JavaScript in every stage before calling MongoDB', async function ( ) {
    for (const stage of [{$match: {$where: 'owned-expression'}},
      {$project: {value: {$function: {body: 'owned-expression', args: [], lang: 'js'}}}},
      {$group: {_id: null, value: {$accumulator: {init: 'owned-expression', lang: 'js'}}}}]) {
      await assert.rejects(aggregateOver([stage])({ }), rejected);
    }
  });

  // ------------------------------------------------------- the wire contract
  //
  // Stub storage: each module's list() runs the REAL lib/server/query.js, which
  // is where the guard lives, and then answers with an empty result. So a 400
  // here proves the refusal travelled from query.js out to the client through
  // that endpoint's own error path, with no database involved. Every one of
  // these answered 500 'Mongo Error' / 'Query Error' before -- or, on
  // /activity and /profiles/, threw or served 200 with an undefined body.
  describe('answers 400 on the wire rather than blaming the database', function ( ) {
    const express = require('express');
    const request = require('supertest');
    const runWithCallback = require('../lib/storage/run-with-callback');
    const env = {settings: { }, name: 'test', version: '0', DISPLAY_UNITS: 'mg/dl'};
    let app, reached;

    function stubList (queryOpts) {
      return function (params, callback) {
        return runWithCallback(function ( ) {
          reached.push(query(params, queryOpts));
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
        // Non-type filters must bypass the entries cache and reach query.js.
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
              reached.push(query(opts, {dateField: 'date', useEpoch: true, walker: { }}));
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

    const routes = ['/api/v1/entries', '/api/v1/treatments', '/api/v1/devicestatus'
      , '/api/v1/activity', '/api/v1/profiles/'];

    routes.forEach(function (route) {
      it('GET ' + route + ' refuses $where with a 400, and storage is never asked', async function ( ) {
        const response = await request(app)
          .get(route + '?find[$where]=' + encodeURIComponent('this.sgv > 100'))
          .expect('Content-Type', /json/)
          .expect(400);
        assert.equal(response.body.status, 400);
        assert.equal(response.body.message, 'Server-side JavaScript is not allowed in database queries');
        assert.equal(reached.length, 0, 'the query must not reach storage');
      });

      it('GET ' + route + ' still serves an ordinary filter', async function ( ) {
        await request(app).get(route + '?find[sgv][$gte]=100').expect(200);
        assert.equal(reached.length, 1);
      });
    });

    it('DELETE /api/v1/entries refuses $where instead of handing express a 500', async function ( ) {
      const response = await request(app)
        .delete('/api/v1/entries/?find[$where]=' + encodeURIComponent('1'))
        .expect(400);
      assert.equal(response.body.message, 'Server-side JavaScript is not allowed in database queries');
    });

    it('GET /api/v1/count/entries/where refuses $where', async function ( ) {
      const response = await request(app)
        .get('/api/v1/count/entries/where?find[$where]=' + encodeURIComponent('1'))
        .expect(400);
      assert.equal(response.body.message, 'Server-side JavaScript is not allowed in database queries');
    });
  });
});
