'use strict';

// A filter the storage interface refuses on an API v1 read must reach the
// client exactly as a filter the v1 operator allowlist refuses does: HTTP 400,
// {status: 400, message: 'Query operator ... is not supported ...'}, never a
// 500. Today nothing the allowlist admits is refused by the interface's v1
// dialect (tests/storage.filter.test.js), so the refusal is forced here by
// making the dialect throw, once per v1 module that reads a client filter.

const assert = require('node:assert/strict');
const request = require('supertest');
const language = require('../lib/language')();
const filter = require('../lib/storage/filter');
const allowlist = require('../lib/server/query-operator-allowlist');

describe('API v1 reads refuse an inexpressible filter as a 400', function ( ) {
  this.timeout(15000);
  const known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  const day = new Date().toISOString().slice(0, 10);
  let app, saved, probe;
  const original = filter.fromMongo;

  before(function (done) {
    // tests/env.test.js deletes INSECURE_USE_HTTP; set it here so this file
    // does not depend on the order the files run in.
    saved = { API_SECRET: process.env.API_SECRET, INSECURE_USE_HTTP: process.env.INSECURE_USE_HTTP };
    process.env.API_SECRET = 'this is my long pass phrase';
    process.env.INSECURE_USE_HTTP = 'true';
    const env = require('../lib/server/env')();
    env.settings.authDefaultRoles = 'readable';
    env.settings.enable = ['careportal', 'api'];
    app = require('express')();
    require('../lib/middleware/configure-request')(app);
    app.enable('api');
    require('../lib/server/bootevent')(env, language).boot(function booted (ctx) {
      ctx.ddata = require('../lib/data/ddata')();
      app.use('/api/v1', require('../lib/api/')(env, ctx));
      done();
    });
    filter.fromMongo = function (f, options) {
      if (probe && options && options.v1) throw probe;
      return original.apply(this, arguments);
    };
  });

  after(function ( ) {
    filter.fromMongo = original;
    for (const [k, v] of Object.entries(saved || { })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  afterEach(function ( ) { probe = null; });

  function operatorProbe ( ) {
    const err = new TypeError("unsupported operator '$probe' on field 'sgv'");
    err.operator = '$probe';
    return err;
  }

  // Every v1 read that takes a client `find`, by module.
  const ROUTES = [
    ['entries', '/api/v1/entries.json?find[sgv][$gte]=1']
    , ['entries', '/api/v1/entries/sgv.json?find[sgv][$gte]=1']
    , ['entries', '/api/v1/times/' + day + '.json']
    , ['entries', '/api/v1/slice/entries/dateString/sgv/' + day + '.json']
    , ['entries', '/api/v1/entries/5f1e3a2b4c5d6e7f80910a1b.json']
    , ['treatments', '/api/v1/treatments.json?find[insulin][$gte]=1']
    , ['devicestatus', '/api/v1/devicestatus.json?find[device]=x']
    , ['activity', '/api/v1/activity.json?find[steps][$gte]=1']
    , ['profile', '/api/v1/profiles.json?find[units]=mmol']
    , ['profile', '/api/v1/profile/current']
  ];

  ROUTES.forEach(function ([module, route]) {
    it(module + ': ' + route.split('?')[0] + ' answers the allowlist\'s 400', async function ( ) {
      probe = operatorProbe();
      const res = await request(app).get(route).set('api-secret', known).expect('Content-Type', /json/);
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { status: 400, message: allowlist.refusal('$probe', 'query').message });
    });
  });

  it('answers a refused operator the same way the allowlist does', async function ( ) {
    // The shape above is the allowlist's own, measured on the same endpoint.
    const res = await request(app).get('/api/v1/entries.json?find[$expr][$eq]=1')
      .set('api-secret', known).expect(400);
    assert.deepEqual(res.body, { status: 400, message: allowlist.refusal('$expr', 'query').message });
  });

  it('answers a refusal that names no operator as a 400 too', async function ( ) {
    probe = new TypeError('filter must be an object');
    const res = await request(app).get('/api/v1/treatments.json?find[insulin][$gte]=1')
      .set('api-secret', known).expect(400);
    assert.deepEqual(res.body, { status: 400
      , message: 'Query is not supported by the Nightscout API v1: filter must be an object' });
  });

  it('still answers 200 when nothing is refused', async function ( ) {
    await request(app).get('/api/v1/treatments.json?find[insulin][$gte]=1').set('api-secret', known).expect(200);
  });
});
