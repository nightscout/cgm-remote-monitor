'use strict';

// A failed storage read reaches the API v1 read callbacks from a promise
// handler (lib/storage/run-with-callback.js). A callback that reads the null
// result there throws an unhandled rejection, which ends the process. These
// tests fail the read the same way and check the request is answered and the
// server keeps serving.

var request = require('supertest');
require('should');
var language = require('../lib/language')();
var runWithCallback = require('../lib/storage/run-with-callback');

describe('API v1 reads when storage fails', function () {
  this.timeout(15000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.app.use('/api', require('../lib/api/')(self.env, ctx));
      done();
    });
  });

  // Stands in for a storage call whose promise rejects, delivered the way the
  // storage modules deliver it.
  function failingRead () {
    var fn = Array.prototype.slice.call(arguments).find(function (arg) { return typeof arg === 'function'; });
    return runWithCallback(function () { throw new Error('storage unavailable at db.internal:27017'); }, fn);
  }

  function expectAnsweredAndAlive (path, done) {
    request(self.app)
      .get(path)
      .set('api-secret', known)
      .timeout(5000)
      .expect(500)
      .end(function (err, res) {
        if (err) return done(err);
        JSON.stringify(res.body).should.not.match(/db\.internal|27017|storage unavailable/);
        request(self.app)
          .get('/api/status.json')
          .timeout(5000)
          .expect(200)
          .end(done);
      });
  }

  describe('GET /api/v1/activity', function () {
    var original;
    before(function () { original = self.ctx.activity.list; self.ctx.activity.list = failingRead; });
    after(function () { self.ctx.activity.list = original; });

    it('answers 500 without the storage error text, and the server keeps serving', function (done) {
      expectAnsweredAndAlive('/api/activity/', done);
    });
  });

  describe('GET /api/v1/profile/current', function () {
    var original;
    before(function () { original = self.ctx.profile.last; self.ctx.profile.last = failingRead; });
    after(function () { self.ctx.profile.last = original; });

    it('answers 500 without the storage error text, and the server keeps serving', function (done) {
      expectAnsweredAndAlive('/api/profile/current', done);
    });
  });
});
