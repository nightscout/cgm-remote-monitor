'use strict';

var request = require('supertest');
var bootevent = require('../lib/server/bootevent');
var language = require('../lib/language')();

require('should');

const FIVE_MINUTES = 1000 * 60 * 5;

// `GET /api/v1/count/:storage/where` must count the same documents that
// `GET /api/v1/:storage` would list.  The two paths build their filter from the
// same query string, so a difference between them is always a defect.
describe('Count REST api', function ( ) {
  var entries = require('../lib/api/entries/');
  var self = this;

  this.timeout(10000);

  before(function (done) {
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')( );
    self.env.settings.authDefaultRoles = 'readable';
    self.wares = require('../lib/middleware/')(self.env);
    self.app = require('express')( );
    self.app.enable('api');
    bootevent(self.env, language).boot(function booted (ctx) {
      self.app.use('/', entries(self.app, self.wares, ctx, self.env));
      self.archive = require('../lib/server/entries')(self.env, ctx);
      self.treatments = ctx.treatments;
      self.ctx = ctx;
      done();
    });
  });

  beforeEach(function (done) {
    var creating = [];
    for (let i = 0; i < 20; i++) {
      creating.push({ type: 'sgv', sgv: 100 + i, date: Date.now() - FIVE_MINUTES * i });
    }
    var treating = [];
    for (let i = 0; i < 5; i++) {
      treating.push({
        eventType: 'Correction Bolus'
        , insulin: 1
        , created_at: new Date(Date.now() - FIVE_MINUTES * i).toISOString()
      });
    }

    self.archive.create(creating, function () {
      self.treatments.create(treating, function () { setTimeout(done, 100); });
    });
  });

  afterEach(async function () {
    await self.archive( ).deleteMany({ });
    await self.treatments( ).deleteMany({ });
  });

  after(async function () {
    await self.archive( ).deleteMany({ });
    await self.treatments( ).deleteMany({ });
  });

  function countOf (body) {
    return body && body.length ? body[0].count : 0;
  }

  it('counts the recent entries the list endpoint returns', function (done) {
    request(self.app)
      .get('/count/entries/where')
      .expect(200)
      .end(function (err, res) {
        if (err) return done(err);
        countOf(res.body).should.equal(20);
        done();
      });
  });

  it('agrees with the list endpoint over the same query', function (done) {
    var since = Date.now() - FIVE_MINUTES * 10;
    request(self.app)
      .get('/entries.json?count=1000&find[date][$gte]=' + since)
      .expect(200)
      .end(function (err, listed) {
        if (err) return done(err);
        listed.body.length.should.be.above(0);
        request(self.app)
          .get('/count/entries/where?find[date][$gte]=' + since)
          .expect(200)
          .end(function (err2, counted) {
            if (err2) return done(err2);
            countOf(counted.body).should.equal(listed.body.length);
            done();
          });
      });
  });

  it('counts treatments against the date field treatments are stored with', function (done) {
    // treatments are bounded on `created_at`, not on `date`.
    request(self.app)
      .get('/count/treatments/where')
      .expect(200)
      .end(function (err, res) {
        if (err) return done(err);
        countOf(res.body).should.equal(5);
        done();
      });
  });

  it('does not write the filter it built to stdout', function (done) {
    // A filter can carry values a deployment would rather not have in its logs.
    var logged = [];
    var realLog = console.log;
    console.log = function () { logged.push(Array.prototype.slice.call(arguments)); };

    request(self.app)
      .get('/count/entries/where?find[date][$gte]=0')
      .expect(200)
      .end(function (err) {
        console.log = realLog;
        if (err) return done(err);
        JSON.stringify(logged).should.not.match(/\$match query|AGGREGATE/);
        done();
      });
  });

  it('counts entries older than the default window when asked for them', function (done) {
    // An explicit lower bound replaces the implicit two-day window; the bound
    // has to be injected as the epoch number `entries.date` is stored as.
    request(self.app)
      .get('/count/entries/where?find[date][$gte]=0')
      .expect(200)
      .end(function (err, res) {
        if (err) return done(err);
        countOf(res.body).should.equal(20);
        done();
      });
  });
});
