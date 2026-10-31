'use strict';

const should = require('should');
const express = require('express');
const request = require('supertest');

const dataloaderInit = require('../lib/data/dataloader');
const createDData = require('../lib/data/ddata');
const ddataEndpoints = require('../lib/data/endpoints');

// Storage stubs answer on a later tick, as the database driver does, and
// record the queries the loader sends.
function makeCtx (queries, stored) {
  function later (callback, result) {
    setImmediate(function () { callback(null, result); });
  }
  // Answers each query with the stored documents its time range admits.
  function lister (name) {
    return function (query, callback) {
      queries.push({ collection: name, query: query });
      const range = query.find && (query.find.date || query.find.created_at);
      const type = query.find && query.find.eventType;
      const wanted = type && typeof type === 'object' ? type.$eq : type;
      const found = ((stored && stored[name]) || []).filter(function (doc) {
        if (wanted !== undefined && doc.eventType !== wanted) return false;
        if (!range) return true;
        const field = query.find.date ? doc.date : doc.created_at;
        return (range.$gte === undefined || field >= range.$gte)
          && (range.$lte === undefined || field <= range.$lte);
      });
      later(callback, JSON.parse(JSON.stringify(found)));
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

describe('ddata at a past time (BF-204)', function () {
  const HOUR = 60 * 60 * 1000;
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

  function sgv (id, date) {
    return { _id: id, type: 'sgv', sgv: 120, date: date, dateString: new Date(date).toISOString() };
  }
  function treatment (id, mills) {
    return { _id: id, eventType: 'Note', created_at: new Date(mills).toISOString() };
  }
  function status (id, mills) {
    return { _id: id, device: 'test', created_at: new Date(mills).toISOString() };
  }

  // Readings, treatments and device statuses every 5 minutes for the last
  // 4 days; the live cache is filled from the newest of them first.
  function seed (now) {
    const stored = { entries: [], treatments: [], devicestatus: [] };
    for (let t = now - 96 * HOUR, i = 0; t <= now; t += 5 * 60 * 1000, i++) {
      stored.entries.push(sgv('e' + i, t));
      stored.treatments.push(treatment('t' + i, t));
      stored.devicestatus.push(status('d' + i, t));
    }
    return stored;
  }

  it('answers with the frame ending at the requested time, not the live window, and leaves the cache as it was', function (done) {
    const now = Date.now();
    const queries = [];
    const setup = makeCtx(queries, seed(now));
    setup.ctx.dataloader.update(setup.ctx.ddata, function liveLoaded () {
      const cached = {
        entries: setup.ctx.cache.getData('entries').length,
        treatments: setup.ctx.cache.getData('treatments').length,
        devicestatus: setup.ctx.cache.getData('devicestatus').length
      };
      cached.entries.should.be.above(500);

      const at = now - 72 * HOUR;
      const atSpec = new Date(at).toISOString();
      request(makeApp(setup))
        .get('/api/v2/ddata/at/' + atSpec)
        .expect(200)
        .then(function (res) {
          res.body.sgvs.length.should.be.above(0);
          res.body.sgvs.filter(function (s) { return s.mills > at; }).should.have.length(0);
          res.body.sgvs.filter(function (s) { return s.mills < at - 48 * HOUR - 1; }).should.have.length(0);
          res.body.treatments.length.should.be.above(0);
          res.body.treatments.filter(function (t) { return t.mills > at; }).should.have.length(0);
          res.body.devicestatus.length.should.be.above(0);
          res.body.devicestatus.filter(function (d) { return d.mills > at; }).should.have.length(0);

          setup.ctx.cache.getData('entries').length.should.equal(cached.entries);
          setup.ctx.cache.getData('treatments').length.should.equal(cached.treatments);
          setup.ctx.cache.getData('devicestatus').length.should.equal(cached.devicestatus);
          done();
        })
        .catch(done);
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
