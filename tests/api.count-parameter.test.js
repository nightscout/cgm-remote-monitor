'use strict';

var request = require('supertest');
var language = require('../lib/language')();

require('should');

const FIVE_MINUTES = 1000 * 60 * 5
  , STORED = 24
  ;

// `?count=` is how every v1 read says how many documents it wants. A request
// that asks for a number of documents must never turn into a read with no
// bound at all, and must never quietly return a different number than the one
// asked for.
describe('API v1 ?count= parameter', function () {
  var api = require('../lib/api/');
  var self = this;

  this.timeout(15000);

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    self.app = require('express')();
    require('../lib/middleware/configure-request')(self.app);
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.app.use('/api/v1', api(self.env, ctx));
      self.archive = require('../lib/server/entries')(self.env, ctx);
      done();
    });
  });

  beforeEach(function (done) {
    var creating = [];
    for (let i = 0; i < STORED; i++) {
      creating.push({ type: 'sgv', sgv: 100 + i, date: Date.now() - FIVE_MINUTES * i });
    }
    self.archive.create(creating, function () { setTimeout(done, 100); });
  });

  afterEach(async function () {
    await self.archive( ).deleteMany({ });
  });

  // A `find` that the runtime cache cannot answer forces the request down to
  // the database, which is where an unbounded read would actually happen.
  const TO_DATABASE = 'find[sgv][$gte]=1&';

  [
    ['zero', '0']
    , ['a negative number', '-3']
    , ['a non-number', 'abc']
    , ['exponent notation, which parseInt truncates', '1e2']
    , ['hex notation, which parseInt reads as zero', '0x10']
    , ['a fraction', '2.5']
  ].forEach(function ([label, value]) {
    it('refuses ' + label + ' rather than guessing: count=' + value, function (done) {
      request(self.app)
        .get('/api/v1/entries.json?' + TO_DATABASE + 'count=' + value)
        .expect(400)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.status.should.equal(400);
          done();
        });
    });
  });

  it('refuses count=0 on profiles, which has no cache to fall back on', function (done) {
    request(self.app)
      .get('/api/v1/profiles.json?count=0')
      .expect(400, done);
  });

  it('refuses count=0 on treatments', function (done) {
    request(self.app)
      .get('/api/v1/treatments.json?count=0')
      .expect(400, done);
  });

  it('still returns exactly the number asked for', function (done) {
    request(self.app)
      .get('/api/v1/entries.json?' + TO_DATABASE + 'count=5')
      .expect(200)
      .end(function (err, res) {
        if (err) return done(err);
        res.body.should.be.instanceof(Array).and.have.lengthOf(5);
        done();
      });
  });

  it('still allows the very large counts clients send deliberately', function (done) {
    request(self.app)
      .get('/api/v1/entries.json?' + TO_DATABASE + 'count=9999999')
      .expect(200)
      .end(function (err, res) {
        if (err) return done(err);
        res.body.should.be.instanceof(Array).and.have.lengthOf(STORED);
        done();
      });
  });

  it('still defaults when no count is given', function (done) {
    request(self.app)
      .get('/api/v1/entries.json?' + TO_DATABASE)
      .expect(200)
      .end(function (err, res) {
        if (err) return done(err);
        res.body.should.be.instanceof(Array).and.have.lengthOf(10);
        done();
      });
  });

  it('still treats an empty count as no count at all', function (done) {
    request(self.app)
      .get('/api/v1/entries.json?' + TO_DATABASE + 'count=')
      .expect(200)
      .end(function (err, res) {
        if (err) return done(err);
        res.body.should.be.instanceof(Array).and.have.lengthOf(10);
        done();
      });
  });

  // The storage layer is a published interface of its own, reachable without
  // going through the route that now rejects a bad count.  Whatever it is
  // handed, it must never ask the driver for `limit(0)`, which means *no
  // limit* and which also makes the driver abandon its read batch bound.
  it('never asks the driver for limit(0), whatever count it is handed', async function () {
    const limits = [];
    const realCollection = self.ctx.store.collection;

    self.ctx.store.collection = function spyCollection (name) {
      const collection = realCollection.call(self.ctx.store, name);
      const realFind = collection.find.bind(collection);
      collection.find = function spyFind () {
        const cursor = realFind.apply(null, arguments);
        const realLimit = cursor.limit.bind(cursor);
        cursor.limit = function spyLimit (n) { limits.push(n); return realLimit(n); };
        return cursor;
      };
      return collection;
    };

    try {
      for (const count of ['0', 0, '-3', '1e2', '', '7']) {
        await new Promise(function (resolve) {
          self.archive.list({ count: count, find: { sgv: { $gte: 1 } } }, resolve);
        });
      }
    } finally {
      self.ctx.store.collection = realCollection;
    }

    // Only the one usable count reached the driver as a limit at all.
    limits.should.eql([7]);
  });
});
