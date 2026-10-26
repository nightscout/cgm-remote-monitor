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

  function stubCollection (sink) {
    const api = function ( ) {
      return {aggregate: function (pipeline) {
        sink.push(pipeline);
        return {toArray: async function ( ) { return [{_id: null, count: 0}]; }};
      }};
    };
    // aggregate.js builds its $match through lib/server/query.js either
    // directly or, once bf/reads (PR #8738, BF-01) lands, through the
    // collection's own query_for. Both reach the same guards; the stub carries
    // query_for so this file does not have to care which branch it is on.
    api.query_for = function (opts) {
      return buildQuery(opts, {dateField: 'date', useEpoch: true, walker: { }});
    };
    return api;
  }

  it('refuses a caller-supplied pipeline instead of splicing it in', async function ( ) {
    const sent = [ ];
    const aggregate = createAggregate({ }, stubCollection(sent));
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
    const aggregate = createAggregate({ }, stubCollection(sent));
    await assert.rejects(new Promise(function (resolve, reject) {
      aggregate(qs.parse('find[date][$gte]=0&pipeline[0]='), function (err, r) {
        return err ? reject(err) : resolve(r);
      });
    }), refused);
    assert.equal(sent.length, 0);
  });

  it('still counts normally when no pipeline is named', async function ( ) {
    const sent = [ ];
    const aggregate = createAggregate({ }, stubCollection(sent));
    const rows = await new Promise(function (resolve, reject) {
      aggregate(qs.parse('find[date][$gte]=0'), function (err, r) {
        return err ? reject(err) : resolve(r);
      });
    });
    assert.deepEqual(rows, [{_id: null, count: 0}]);
    assert.equal(sent.length, 1);
    // $match, then the count template. Nothing between them any more.
    assert.equal(sent[0].length, 2);
    assert.deepEqual(Object.keys(sent[0][0]), ['$match']);
    assert.deepEqual(Object.keys(sent[0][1]), ['$group']);
  });

  it('keeps the server-side conf.pipeline hook working', async function ( ) {
    const sent = [ ];
    const aggregate = createAggregate({pipeline: [{$match: {type: 'sgv'}}]}, stubCollection(sent));
    await new Promise(function (resolve, reject) {
      aggregate(qs.parse('find[date][$gte]=0'), function (err, r) {
        return err ? reject(err) : resolve(r);
      });
    });
    assert.equal(sent[0].length, 3);
    assert.deepEqual(sent[0][1], {$match: {type: 'sgv'}});
  });

  it('refuses JavaScript reaching the pipeline from the conf side', async function ( ) {
    const sent = [ ];
    const aggregate = createAggregate({pipeline: [{$match: {$where: 'owned-expression'}}]}
      , stubCollection(sent));
    await assert.rejects(new Promise(function (resolve, reject) {
      aggregate(qs.parse('find[date][$gte]=0'), function (err, r) {
        return err ? reject(err) : resolve(r);
      });
    }), refused);
    assert.equal(sent.length, 0);
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
        , aggregate: createAggregate({ }, stubCollection(sent))
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
        , aggregate: createAggregate({ }, stubCollection(sent))
      })
    };
    app.enable('api');
    app.use('/api/v1', require('../lib/api/entries')(app, wares, ctx, env));

    await request(app).get('/api/v1/count/entries/where?find[date][$gte]=0').expect(200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].length, 2);
  });

  it('is unreachable through the find filter as well', function ( ) {
    // The same $lookup expressed as a filter is refused by the operator
    // allowlist, so closing the pipeline parameter does not leave a second door.
    assert.throws(function ( ) {
      buildQuery(qs.parse('find[$lookup][from]=auth_subjects'), {walker: { }});
    }, refused);
  });
});
