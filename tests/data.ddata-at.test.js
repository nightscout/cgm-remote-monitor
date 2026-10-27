'use strict';

const should = require('should');
const express = require('express');
const request = require('supertest');

const dataloaderInit = require('../lib/data/dataloader');
const createDData = require('../lib/data/ddata');
const ddataEndpoints = require('../lib/data/endpoints');

// Storage stubs answer on a later tick, as the database driver does, and
// record the queries the loader sends.
function makeCtx (queries) {
  function later (callback, result) {
    setImmediate(function () { callback(null, result); });
  }
  function lister (name) {
    return function (query, callback) {
      queries.push({ collection: name, query: query });
      later(callback, []);
    };
  }
  const ctx = {
    settings: {},
    bus: new (require('events').EventEmitter)(),
    language: { translate: function (value) { return value; } },
    ddata: createDData(),
    entries: { list: lister('entries') },
    treatments: { list: lister('treatments') },
    devicestatus: { list: lister('devicestatus') },
    activity: { list: lister('activity') },
    profile: { last: function (callback) { later(callback, []); } },
    food: { list: function (callback) { later(callback, []); } },
    store: { db: { stats: function () { return Promise.resolve({ dataSize: 1, indexSize: 1 }); } } },
    authorization: {
      isPermitted: function () { return function (req, res, next) { next(); }; }
    }
  };
  ctx.ddata.processTreatments = function () {};
  const env = {
    settings: {
      isEnabled: function () { return false; },
      units: 'mg/dl'
    },
    extendedSettings: {}
  };
  ctx.cache = require('../lib/server/cache')(env, ctx);
  ctx.dataloader = dataloaderInit(env, ctx);
  return { ctx: ctx, env: env };
}

function makeApp (setup) {
  const app = express();
  require('../lib/middleware/configure-request')(app);
  app.use('/api/v2/ddata', ddataEndpoints(setup.env, setup.ctx));
  return app;
}

describe('ddata at endpoint', function () {
  let originalError;
  let originalLog;

  beforeEach(function () {
    originalError = console.error;
    originalLog = console.log;
    console.error = console.log = function () {};
  });

  afterEach(function () {
    console.error = originalError;
    console.log = originalLog;
  });

  it('answers 400 for a time it cannot parse and does not start a load', function () {
    const queries = [];
    const setup = makeCtx(queries);
    return request(makeApp(setup))
      .get('/api/v2/ddata/at/1700000000000')
      .expect(400)
      .then(function (res) {
        res.body.status.should.equal(400);
        queries.should.have.length(0);
      });
  });

  it('loads the frame ending at a parseable time', function () {
    const queries = [];
    const setup = makeCtx(queries);
    const at = '2023-11-14T22:13:20.000Z';
    return request(makeApp(setup))
      .get('/api/v2/ddata/at/' + at)
      .expect(200)
      .then(function (res) {
        res.body.lastUpdated.should.equal(1700000000000);
        const entries = queries.filter(function (q) { return q.collection === 'entries'; });
        entries.should.have.length(1);
        entries[0].query.find.date.$lte.should.equal(1700000000000);
        const switches = queries.filter(function (q) {
          return q.collection === 'treatments' && q.query.find.eventType === 'Profile Switch';
        });
        switches.should.have.length(1);
        switches[0].query.find.created_at.$lte.should.equal(at);
      });
  });
});

describe('dataloader time guard', function () {
  [NaN, -8639999913600000, 8.64e15 + 1].forEach(function (time) {
    it('reports an error instead of throwing for lastUpdated=' + time, function (done) {
      const queries = [];
      const setup = makeCtx(queries);
      const ddata = setup.ctx.ddata.clone();
      setup.ctx.dataloader.update(ddata, { lastUpdated: time, frame: true }, function (err) {
        should.exist(err);
        queries.should.have.length(0);
        // let any loader that was started anyway run to completion
        setImmediate(done);
      });
    });
  });
});
