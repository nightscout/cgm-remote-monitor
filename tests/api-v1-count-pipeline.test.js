'use strict';

// BF-70. lib/server/aggregate.js built its aggregation as
//
//   [{$match: <find>}].concat(conf.pipeline || []).concat(opts.pipeline || [])
//                                                          ^^^^^^^^^^^^^^
// and `opts` is the caller's parsed query string: count_records in
// lib/api/entries/index.js passes req.query straight to storage.aggregate().
// So GET /api/v1/count/:storage/where accepted arbitrary AGGREGATION stages
// from the URL.
//
// That is a wider surface than the `find` filter. Aggregation carries $lookup,
// which reads a collection the endpoint is not about, and the trailing
// {$group: {count: {$sum: 1}}} the module appends turns the joined result into
// a number the caller can read -- an oracle over another collection, answered
// under HTTP 200 to whatever role can read entries. AUTH_DEFAULT_ROLES ships
// as `readable`, which is granted without a token.
//
// Reproduced 2026-09-18 against mongod 7.0 through the booted v1 app with no
// api-secret header. The reproduction is deliberately not committed: this
// repository is public and the defect is live on the current release. See the
// backfix register entry for how to obtain it.
//
// $out and $merge, which WRITE, are blocked by accident rather than by design
// -- both must be the last stage, and the module appends its $group after the
// caller's stages -- so this is a read, not a write. That accident is not a
// property anything asserts, which is its own reason to close the parameter.

const assert = require('node:assert/strict');
const qs = require('qs');
const express = require('express');
const request = require('supertest');

const createAggregate = require('../lib/server/aggregate');
const runWithCallback = require('../lib/storage/run-with-callback');
const buildQuery = require('../lib/server/query');

function refused (error) {
  assert.equal(error.name, 'MongoQueryValidationError');
  assert.equal(error.status, 400);
  assert.equal(error.statusCode, 400);
  return true;
}

describe('API v1 count endpoint pipeline parameter', function ( ) {

  // aggregate.js builds its filter through the collection's own query_for,
  // which reaches lib/server/query.js and its guards, and counts through the
  // storage interface. The stub interface records each count() it is asked
  // for and answers `n`.
  function stubAggregate (sink, n) {
    const api = function ( ) { };
    api.query_for = function (opts) {
      return buildQuery(opts, {dateField: 'date', useEpoch: true, walker: { }});
    };
    const store = function ( ) {
      return {count: async function (ast, opts) { sink.push({ast, opts}); return n || 0; }};
    };
    return createAggregate(api, store);
  }

  it('refuses a caller-supplied pipeline instead of splicing it in', async function ( ) {
    const sent = [ ];
    const aggregate = stubAggregate(sent);
    const opts = qs.parse('find[date][$gte]=0'
      + '&pipeline[0][$lookup][from]=auth_subjects'
      + '&pipeline[0][$lookup][localField]=nope'
      + '&pipeline[0][$lookup][foreignField]=nope'
      + '&pipeline[0][$lookup][as]=hit');
    await assert.rejects(new Promise(function (resolve, reject) {
      aggregate(opts, function (err, result) { return err ? reject(err) : resolve(result); });
    }), refused);
    assert.equal(sent.length, 0, 'MongoDB must not be asked anything');
  });

  it('refuses an empty pipeline too, rather than only a populated one', async function ( ) {
    const sent = [ ];
    const aggregate = stubAggregate(sent);
    await assert.rejects(new Promise(function (resolve, reject) {
      aggregate(qs.parse('find[date][$gte]=0&pipeline[0]='), function (err, r) {
        return err ? reject(err) : resolve(r);
      });
    }), refused);
    assert.equal(sent.length, 0);
  });

  it('still counts normally when no pipeline is named', async function ( ) {
    for (const [n, expected] of [[3, [{_id: null, count: 3}]], [0, [ ]]]) {
      const sent = [ ];
      const aggregate = stubAggregate(sent, n);
      const rows = await new Promise(function (resolve, reject) {
        aggregate(qs.parse('find[date][$gte]=0'), function (err, r) {
          return err ? reject(err) : resolve(r);
        });
      });
      assert.deepEqual(rows, expected);
      // One count over the caller's filter, in the API v1 dialect.
      assert.equal(sent.length, 1);
      assert.equal(sent[0].ast.field, 'date');
      assert.equal(sent[0].ast.op, 'gte');
      assert.equal(sent[0].opts.v1, true);
    }
  });

  it('cannot be built without a storage interface', function ( ) {
    const api = Object.assign(function ( ) { }, {query_for: ( ) => ({ })});
    assert.throws(( ) => createAggregate(api), TypeError);
  });

  it('answers 400 on the wire, and storage is never asked', async function ( ) {
    const env = {settings: { }, name: 'test', version: '0', DISPLAY_UNITS: 'mg/dl'};
    const sent = [ ];
    const app = express();
    require('../lib/middleware/configure-request')(app);
    const wares = require('../lib/middleware/')(env);
    const ctx = {
      authorization: {isPermitted: function ( ) { return function (req, res, next) { next(); }; }}
      , cache: {treatments: [ ], devicestatus: [ ], entries: [ ], getData: function ( ) { return [ ]; }}
      , ddata: {sgvs: [ ]}
      , purifier: {purifyObject: function ( ) { }}
      , entries: Object.assign(function ( ) { }, {
        list: function (params, cb) { return runWithCallback(function ( ) { return [ ]; }, cb); }
        , remove: function (params, cb) { return runWithCallback(function ( ) { return [ ]; }, cb); }
        , getEntry: function (id, cb) { cb(null, null); }
        , aggregate: stubAggregate(sent)
      })
    };
    app.enable('api');
    app.use('/api/v1', require('../lib/api/entries')(app, wares, ctx, env));

    const response = await request(app)
      .get('/api/v1/count/entries/where?find[date][$gte]=0'
        + '&pipeline[0][$lookup][from]=auth_subjects'
        + '&pipeline[0][$lookup][localField]=nope'
        + '&pipeline[0][$lookup][foreignField]=nope'
        + '&pipeline[0][$lookup][as]=hit')
      .expect('Content-Type', /json/)
      .expect(400);
    assert.equal(response.body.status, 400);
    assert.match(response.body.message, /^The pipeline parameter is not supported/);
    assert.equal(sent.length, 0);
  });

  it('still answers the ordinary count over HTTP', async function ( ) {
    const env = {settings: { }, name: 'test', version: '0', DISPLAY_UNITS: 'mg/dl'};
    const sent = [ ];
    const app = express();
    require('../lib/middleware/configure-request')(app);
    const wares = require('../lib/middleware/')(env);
    const ctx = {
      authorization: {isPermitted: function ( ) { return function (req, res, next) { next(); }; }}
      , cache: {treatments: [ ], devicestatus: [ ], entries: [ ], getData: function ( ) { return [ ]; }}
      , ddata: {sgvs: [ ]}
      , purifier: {purifyObject: function ( ) { }}
      , entries: Object.assign(function ( ) { }, {
        list: function (params, cb) { return runWithCallback(function ( ) { return [ ]; }, cb); }
        , remove: function (params, cb) { return runWithCallback(function ( ) { return [ ]; }, cb); }
        , getEntry: function (id, cb) { cb(null, null); }
        , aggregate: stubAggregate(sent)
      })
    };
    app.enable('api');
    app.use('/api/v1', require('../lib/api/entries')(app, wares, ctx, env));

    await request(app).get('/api/v1/count/entries/where?find[date][$gte]=0').expect(200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].opts.v1, true);
  });

  it('is unreachable through the find filter as well', function ( ) {
    // The same $lookup expressed as a filter is refused by the operator
    // allowlist, so closing the pipeline parameter does not leave a second door.
    assert.throws(function ( ) {
      buildQuery(qs.parse('find[$lookup][from]=auth_subjects'), {walker: { }});
    }, refused);
  });
});
