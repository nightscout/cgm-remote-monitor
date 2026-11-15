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

  // EXPECTATION CHANGED 2026-09-24 (maintainer decision for 15.0.9): a read
  // with `count=0` was answered with an empty list here (decided 2026-09-23).
  // GluPredKit sends `count=0` with a date range meaning "everything in the
  // range", and 15.0.8 answered it that way, so 15.0.9 does too: `count=0`
  // with a `find` that bounds a date field from both sides reads everything
  // in the window, and `count=0` without one reads as if no count had been
  // given.  Both carry a deprecation warning.  It is still never an error,
  // and never the whole collection unless a window asks for it.
  describe('a read with count=0', function () {
    const SEEDED = 3;
    const WINDOW = function (field, from, to) {
      return 'find[' + field + '][$gte]=' + encodeURIComponent(from) + '&find[' + field + '][$lte]=' + encodeURIComponent(to) + '&';
    };
    let from, to;

    before(async function () {
      const now = Date.now();
      from = new Date(now - FIVE_MINUTES * 200).toISOString();
      to = new Date(now + FIVE_MINUTES).toISOString();
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

    function expectDeprecated (res) {
      res.headers.should.have.property('deprecation', 'true');
      res.headers.should.have.property('warning');
      res.headers.warning.should.match(/^299 - "count=0 is deprecated/);
    }

    it('reads the endpoint default without a date window, not an empty list', function (done) {
      request(self.app)
        .get('/api/v1/entries.json?' + TO_DATABASE + 'count=0')
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array).and.have.lengthOf(10);
          expectDeprecated(res);
          done();
        });
    });

    it('reads the endpoint default when the window is open on one side', function (done) {
      request(self.app)
        .get('/api/v1/entries.json?find[date][$gte]=1&count=0')
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array).and.have.lengthOf(10);
          done();
        });
    });

    it('reads everything inside a date window, as 15.0.8 did: entries', function (done) {
      request(self.app)
        .get('/api/v1/entries.json?find[date][$gte]=1&find[date][$lte]=' + (Date.now() + FIVE_MINUTES) + '&count=0')
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array).and.have.lengthOf(STORED);
          expectDeprecated(res);
          done();
        });
    });

    it('reads everything inside a date window with an exclusive bound: entries by type', function (done) {
      request(self.app)
        .get('/api/v1/entries/sgv.json?find[date][$gt]=1&find[date][$lt]=' + (Date.now() + FIVE_MINUTES) + '&count=00')
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array).and.have.lengthOf(STORED);
          done();
        });
    });

    [
      ['treatments, read from the database', function () { return '/api/v1/treatments.json?find[eventType]=Note&count=0'; }]
      , ['treatments in a window', function () { return '/api/v1/treatments.json?' + WINDOW('created_at', from, to) + 'count=0'; }]
      , ['devicestatus, read from the database', function () { return '/api/v1/devicestatus.json?find[device]=count-zero&count=0'; }]
      , ['devicestatus, served from the cache', function () { return '/api/v1/devicestatus.json?count=0'; }]
      , ['devicestatus in a window', function () { return '/api/v1/devicestatus.json?' + WINDOW('created_at', from, to) + 'count=0'; }]
      , ['profiles', function () { return '/api/v1/profiles.json?count=0'; }]
      , ['profiles in a window', function () { return '/api/v1/profiles.json?' + WINDOW('startDate', from, to) + 'count=0'; }]
      , ['profile', function () { return '/api/v1/profile.json?count=0'; }]
      , ['profile in a window, as GluPredKit asks', function () { return '/api/v1/profile?' + WINDOW('created_at', from, to) + 'count=0'; }]
      , ['activity', function () { return '/api/v1/activity.json?count=0'; }]
    ].forEach(function ([label, path]) {
      it('is answered with the stored documents, not an empty list: ' + label, function (done) {
        request(self.app)
          .get(path())
          .expect(200)
          .end(function (err, res) {
            if (err) return done(err);
            res.body.should.be.instanceof(Array).and.have.lengthOf(SEEDED);
            expectDeprecated(res);
            done();
          });
      });
    });

    it('is still answered with nothing by the storage layer, whatever form the zero takes', async function () {
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

  // Decided 2026-09-24 for 15.0.9: oref0's `ns-get.sh` appends its credential
  // to the query with a second `?`, so its `count=1` arrives as
  // `1?<credential>` or `1?token=<token>`.  15.0.8 read the leading number;
  // 15.0.9 reads it the same way, with a deprecation warning, and only when
  // the number is followed by `?`.
  describe('a count followed by ?, as oref0 sends it', function () {
    const TOKEN = 'oref0-shaped-token-value';

    [
      ['token mode', '1?token=' + TOKEN]
      , ['hashed-secret mode', '1?' + known]
    ].forEach(function ([label, value]) {
      it('reads the leading number in ' + label, function (done) {
        request(self.app)
          .get('/api/v1/entries.json?' + TO_DATABASE + 'count=' + encodeURIComponent(value).replace(/%3F/g, '?'))
          .expect(200)
          .end(function (err, res) {
            if (err) return done(err);
            res.body.should.be.instanceof(Array).and.have.lengthOf(1);
            res.headers.should.have.property('deprecation', 'true');
            res.headers.warning.should.match(/^299 - "a count followed by other text is deprecated/);
            done();
          });
      });
    });

    it('reads a larger leading number exactly', function (done) {
      request(self.app)
        .get('/api/v1/entries.json?' + TO_DATABASE + 'count=5?token=' + TOKEN)
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array).and.have.lengthOf(5);
          done();
        });
    });

    it('never echoes or logs what follows the ?', function (done) {
      const logged = [];
      const realWarn = console.warn;
      console.warn = function () { logged.push(Array.prototype.join.call(arguments, ' ')); };
      request(self.app)
        .get('/api/v1/entries.json?' + TO_DATABASE + 'count=2?token=' + TOKEN)
        .expect(200)
        .end(function (err, res) {
          console.warn = realWarn;
          if (err) return done(err);
          JSON.stringify(res.headers).should.not.containEql(TOKEN);
          logged.join('\n').should.not.containEql(TOKEN);
          done();
        });
    });

    [
      ['a negative number', '-3?token=' + TOKEN]
      , ['exponent notation', '1e2?token=' + TOKEN]
      , ['a fraction', '2.5?token=' + TOKEN]
      , ['a non-number', 'abc?1']
      , ['text before the number', 'x1?token=' + TOKEN]
    ].forEach(function ([label, value]) {
      it('still refuses ' + label + ' followed by ?: count=' + value, function (done) {
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

    it('is not accepted on a delete, which still refuses a count it cannot read', function (done) {
      request(self.app)
        .delete('/api/v1/entries.json?' + TO_DATABASE + 'count=1?token=' + TOKEN)
        .set('api-secret', known)
        .expect(400)
        .end(function (err) {
          if (err) return done(err);
          self.archive( ).countDocuments({ }).then(function (n) {
            n.should.equal(STORED);
            done();
          }, done);
        });
    });
  });

  // Decided 2026-09-24 for 15.0.9: each tolerance above has its own setting,
  // on by default, so a later release can turn it off.  With a setting off,
  // that shape meets #8748's rule exactly as `dev` answered it before.
  describe('with a count compatibility setting turned off', function () {
    afterEach(function () {
      delete self.env.apiV1CountLeadingNumber;
      delete self.env.apiV1CountZeroWindow;
    });

    it('refuses 1?token=... when API_V1_COUNT_LEADING_NUMBER is false', function (done) {
      self.env.apiV1CountLeadingNumber = false;
      request(self.app)
        .get('/api/v1/entries.json?' + TO_DATABASE + 'count=1?token=abc')
        .expect(400)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.message.should.equal('Bad count');
          res.headers.should.not.have.property('deprecation');
          done();
        });
    });

    it('answers count=0 with an empty list when API_V1_COUNT_ZERO_WINDOW is false, window or not', function (done) {
      self.env.apiV1CountZeroWindow = false;
      request(self.app)
        .get('/api/v1/entries.json?find[date][$gte]=1&find[date][$lte]=' + (Date.now() + FIVE_MINUTES) + '&count=0')
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array).and.have.lengthOf(0);
          res.headers.should.not.have.property('deprecation');
          request(self.app)
            .get('/api/v1/entries.json?' + TO_DATABASE + 'count=0')
            .expect(200)
            .end(function (err2, res2) {
              if (err2) return done(err2);
              res2.body.should.be.instanceof(Array).and.have.lengthOf(0);
              done();
            });
        });
    });

    it('keeps the other tolerance when only one is turned off', function (done) {
      self.env.apiV1CountZeroWindow = false;
      request(self.app)
        .get('/api/v1/entries.json?' + TO_DATABASE + 'count=3?token=abc')
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array).and.have.lengthOf(3);
          done();
        });
    });

    it('reads 0?token=... as an empty list when only the zero-window tolerance is off', function (done) {
      self.env.apiV1CountZeroWindow = false;
      request(self.app)
        .get('/api/v1/entries.json?' + TO_DATABASE + 'count=0?token=abc')
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array).and.have.lengthOf(0);
          done();
        });
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
