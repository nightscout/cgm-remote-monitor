'use strict';

var request = require('supertest');
var language = require('../lib/language')();

require('should');

const FIVE_MINUTES = 1000 * 60 * 5
  , STORED = 24
  , API_SECRET = 'this is my long pass phrase'
  // the api-secret header value for API_SECRET, as the other API tests use it
  , known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1'
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
    process.env.API_SECRET = API_SECRET;
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    self.app = require('express')();
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

  // EXPECTATION CHANGED 2026-09-23 (maintainer decision for 15.0.9): `count=0`
  // is no longer refused.  It was in this list, expecting HTTP 400; it is now
  // a valid request for no documents and is answered 200 with an empty list -
  // see 'a request for zero documents' below.  Every other spelling here is
  // still refused.
  [
    ['a negative number', '-3']
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

  // EXPECTATION CHANGED 2026-09-23 (maintainer decision for 15.0.9): this
  // test was 'refuses count=0 on profiles' and expected HTTP 400.  count=0 now
  // asks for no documents and gets 200 with an empty list.
  it('answers count=0 on profiles, which has no cache to fall back on, with no profiles', function (done) {
    request(self.app)
      .get('/api/v1/profiles.json?count=0')
      .expect(200)
      .end(function (err, res) {
        if (err) return done(err);
        res.body.should.eql([]);
        done();
      });
  });

  // EXPECTATION CHANGED 2026-09-23 (maintainer decision for 15.0.9): this
  // test was 'refuses count=0 on treatments' and expected HTTP 400.  count=0
  // now asks for no documents and gets 200 with an empty list.
  it('answers count=0 on treatments with no treatments', function (done) {
    request(self.app)
      .get('/api/v1/treatments.json?count=0')
      .expect(200)
      .end(function (err, res) {
        if (err) return done(err);
        res.body.should.eql([]);
        done();
      });
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

  // Decided 2026-09-23 for 15.0.9: `count=0` is a request for no documents.
  // Its answer is an empty list - never an error, and never the whole
  // collection, which is what MongoDB's `.limit(0)` would have produced.
  // Every collection below holds documents the filter matches, so a read that
  // lost its bound would show up as a non-empty answer.
  describe('a request for zero documents', function () {
    const SEEDED = 3;

    before(async function () {
      const now = Date.now();
      const docs = function (make) {
        const out = [];
        for (let i = 0; i < SEEDED; i++) out.push(make(new Date(now - FIVE_MINUTES * i).toISOString(), i));
        return out;
      };
      await self.ctx.treatments().insertMany(docs(function (at, i) { return { eventType: 'Note', notes: 'zero ' + i, created_at: at }; }));
      await self.ctx.devicestatus().insertMany(docs(function (at) { return { device: 'count-zero', created_at: at }; }));
      await self.ctx.profile().insertMany(docs(function (at) { return { defaultProfile: 'Default', startDate: at, created_at: at, store: { } }; }));
      await self.ctx.activity().insertMany(docs(function (at, i) { return { created_at: at, steps: i }; }));
    });

    after(async function () {
      await self.ctx.treatments().deleteMany({ });
      await self.ctx.devicestatus().deleteMany({ });
      await self.ctx.profile().deleteMany({ });
      await self.ctx.activity().deleteMany({ });
    });

    [
      ['entries, read from the database', '/api/v1/entries.json?' + TO_DATABASE + 'count=0']
      , ['entries, written with a leading zero', '/api/v1/entries.json?' + TO_DATABASE + 'count=00']
      , ['entries by type', '/api/v1/entries/sgv.json?' + TO_DATABASE + 'count=0']
      , ['treatments, read from the database', '/api/v1/treatments.json?find[eventType]=Note&count=0']
      , ['devicestatus, read from the database', '/api/v1/devicestatus.json?find[device]=count-zero&count=0']
      , ['devicestatus, served from the cache', '/api/v1/devicestatus.json?count=0']
      , ['profiles', '/api/v1/profiles.json?count=0']
      , ['profile', '/api/v1/profile.json?count=0']
      , ['activity', '/api/v1/activity.json?count=0']
    ].forEach(function ([label, path]) {
      it('answers with an empty list, not the whole collection: ' + label, function (done) {
        request(self.app)
          .get(path)
          .expect(200)
          .end(function (err, res) {
            if (err) return done(err);
            res.body.should.be.instanceof(Array).and.have.lengthOf(0);
            done();
          });
      });
    });

    it('is answered with nothing by the storage layer too, whatever form the zero takes', async function () {
      for (const count of ['0', 0, '00']) {
        const found = await new Promise(function (resolve, reject) {
          self.archive.list({ count: count, find: { sgv: { $gte: 1 } } }, function (err, rows) {
            return err ? reject(err) : resolve(rows);
          });
        });
        found.should.be.instanceof(Array).and.have.lengthOf(0);
      }
    });
  });

  // Decided 2026-09-23 for 15.0.9: a save or an update does not use `count`,
  // so one that carries one - valid or not - is carried out exactly as if it
  // did not.  A delete that carries a count it cannot read is refused, as
  // #8738 made it on dev - see 'a delete that carries a count' below.
  describe('a write that carries a count', function () {

    ['abc', '0', '-3'].forEach(function (value) {
      it('stores posted entries regardless: count=' + value, function (done) {
        const device = 'count-write-' + value;
        request(self.app)
          .post('/api/v1/entries/?count=' + value)
          .set('api-secret', known)
          .send([{ type: 'sgv', sgv: 90, date: Date.now(), device: device }])
          .expect(200)
          .end(async function (err) {
            if (err) return done(err);
            try {
              (await self.archive( ).countDocuments({ device: device })).should.equal(1);
              done();
            } catch (e) { done(e); }
          });
      });

      it('stores a posted devicestatus regardless: count=' + value, function (done) {
        const device = 'count-write-' + value;
        request(self.app)
          .post('/api/v1/devicestatus/?count=' + value)
          .set('api-secret', known)
          .send({ device: device, created_at: new Date().toISOString() })
          .expect(200)
          .end(async function (err) {
            if (err) return done(err);
            try {
              (await self.ctx.devicestatus( ).countDocuments({ device: device })).should.equal(1);
              await self.ctx.devicestatus( ).deleteMany({ device: device });
              done();
            } catch (e) { done(e); }
          });
      });
    });
  });

  // A delete removes everything its filter matches; `count` has never limited
  // it.  One that carries a count it cannot read is refused and deletes
  // nothing: `count=0` in particular must not be read as "delete nothing" and
  // then delete everything.
  describe('a delete that carries a count', function () {

    ['abc', '0', '00', '-3', '2.5'].forEach(function (value) {
      it('is refused and deletes nothing: count=' + value, function (done) {
        request(self.app)
          .delete('/api/v1/entries/?find[sgv][$gte]=1&count=' + value)
          .set('api-secret', known)
          .expect(400)
          .end(async function (err, res) {
            if (err) return done(err);
            try {
              res.body.message.should.equal('Bad count');
              (await self.archive( ).countDocuments({ })).should.equal(STORED);
              done();
            } catch (e) { done(e); }
          });
      });
    });

    it('is refused and deletes nothing by id either: count=0', function (done) {
      self.archive( ).findOne({ }).then(function (entry) {
        request(self.app)
          .delete('/api/v1/entries/' + entry._id + '?count=0')
          .set('api-secret', known)
          .expect(400)
          .end(async function (err) {
            if (err) return done(err);
            try {
              (await self.archive( ).countDocuments({ })).should.equal(STORED);
              done();
            } catch (e) { done(e); }
          });
      }, done);
    });

    it('still deletes everything its filter matches with a valid count, which it does not limit', function (done) {
      request(self.app)
        .delete('/api/v1/entries/?find[sgv][$gte]=1&count=2')
        .set('api-secret', known)
        .expect(200)
        .end(async function (err) {
          if (err) return done(err);
          try {
            (await self.archive( ).countDocuments({ })).should.equal(0);
            done();
          } catch (e) { done(e); }
        });
    });

    it('still deletes everything its filter matches with no count', function (done) {
      request(self.app)
        .delete('/api/v1/entries/?find[sgv][$gte]=1')
        .set('api-secret', known)
        .expect(200)
        .end(async function (err) {
          if (err) return done(err);
          try {
            (await self.archive( ).countDocuments({ })).should.equal(0);
            done();
          } catch (e) { done(e); }
        });
    });
  });
});
