'use strict';

var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();

describe('API Shape Handling - Single Object vs Array Input', function () {
  this.timeout(15000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

  var api = require('../lib/api/');
  
  // Use before() instead of beforeEach() for server boot - boots once for all tests
  // Data cleanup happens in nested beforeEach() hooks to maintain test isolation
  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    this.wares = require('../lib/middleware/')(self.env);
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(function booted(ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.app.use('/api', api(self.env, ctx));
      done();
    });
  });

  describe('Treatments API - /api/treatments/', function () {
    
    beforeEach(function (done) {
      self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        done();
      });
    });

    it('POST accepts single object', function (done) {
      var now = new Date().toISOString();
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', known)
        .send({ eventType: 'Note', created_at: now, notes: 'single object test' })
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.be.greaterThanOrEqual(1);
          res.body[0].notes.should.equal('single object test');
          done();
        });
    });

    it('POST accepts array with single element', function (done) {
      var now = new Date().toISOString();
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', known)
        .send([{ eventType: 'Note', created_at: now, notes: 'array single element test' }])
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.be.greaterThanOrEqual(1);
          res.body[0].notes.should.equal('array single element test');
          done();
        });
    });

    it('POST accepts array with multiple elements', function (done) {
      var now = new Date().toISOString();
      var later = new Date(Date.now() + 1000).toISOString();
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', known)
        .send([
          { eventType: 'Note', created_at: now, notes: 'first treatment' },
          { eventType: 'BG Check', created_at: later, glucose: 120, glucoseType: 'Finger', units: 'mg/dl' }
        ])
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.equal(2);
          done();
        });
    });

    it('POST handles large batch array', function (done) {
      var treatments = [];
      var baseTime = Date.now();
      for (var i = 0; i < 10; i++) {
        treatments.push({
          eventType: 'Note',
          created_at: new Date(baseTime + i * 1000).toISOString(),
          notes: 'batch item ' + i
        });
      }
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', known)
        .send(treatments)
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.equal(10);
          done();
        });
    });
  });

  describe('Devicestatus API - /api/devicestatus/', function () {
    
    beforeEach(function (done) {
      self.ctx.devicestatus.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        done();
      });
    });

    it('POST accepts single object', function (done) {
      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', known)
        .send({
          device: 'test-device',
          created_at: new Date().toISOString(),
          uploaderBattery: 85
        })
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.equal(1);
          res.body[0].uploaderBattery.should.equal(85);
          done();
        });
    });

    it('POST accepts array with single element', function (done) {
      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', known)
        .send([{
          device: 'test-device-array',
          created_at: new Date().toISOString(),
          uploaderBattery: 90
        }])
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.equal(1);
          res.body[0].uploaderBattery.should.equal(90);
          done();
        });
    });

    it('POST accepts array with multiple elements', function (done) {
      var now = Date.now();
      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', known)
        .send([
          { device: 'device-1', created_at: new Date(now).toISOString(), uploaderBattery: 80 },
          { device: 'device-2', created_at: new Date(now + 1000).toISOString(), uploaderBattery: 75 },
          { device: 'device-3', created_at: new Date(now + 2000).toISOString(), uploaderBattery: 70 }
        ])
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.equal(3);
          done();
        });
    });

    it('POST handles large batch array', function (done) {
      var statuses = [];
      var baseTime = Date.now();
      for (var i = 0; i < 10; i++) {
        statuses.push({
          device: 'batch-device-' + i,
          created_at: new Date(baseTime + i * 1000).toISOString(),
          uploaderBattery: 50 + i
        });
      }
      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', known)
        .send(statuses)
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.equal(10);
          done();
        });
    });
  });

  describe('Response Shape Consistency', function () {
    
    beforeEach(function (done) {
      self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        self.ctx.devicestatus.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
          done();
        });
      });
    });

    it('treatments single object input returns array response', function (done) {
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', known)
        .send({ eventType: 'Note', created_at: new Date().toISOString(), notes: 'response shape test' })
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          done();
        });
    });

    it('treatments array input returns array response', function (done) {
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', known)
        .send([{ eventType: 'Note', created_at: new Date().toISOString(), notes: 'response shape test array' }])
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          done();
        });
    });

    it('devicestatus single object input returns array response', function (done) {
      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', known)
        .send({ device: 'test', created_at: new Date().toISOString() })
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          done();
        });
    });

    it('devicestatus array input returns array response', function (done) {
      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', known)
        .send([{ device: 'test', created_at: new Date().toISOString() }])
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          done();
        });
    });
  });

  describe('Edge Cases - Empty and Malformed Input', function () {
    
    it('treatments POST with empty object', function (done) {
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', known)
        .send({})
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          done();
        });
    });

    it('treatments POST with empty array', function (done) {
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', known)
        .send([])
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.equal(0);
          done();
        });
    });

    it('devicestatus POST with empty object', function (done) {
      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', known)
        .send({})
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          done();
        });
    });

    it('devicestatus POST with empty array', function (done) {
      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', known)
        .send([])
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.equal(0);
          done();
        });
    });
  });

  describe('Mixed Array Content Types', function () {
    
    beforeEach(function (done) {
      self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        done();
      });
    });

    it('treatments array with different eventTypes', function (done) {
      var now = Date.now();
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', known)
        .send([
          { eventType: 'Note', created_at: new Date(now).toISOString(), notes: 'a note' },
          { eventType: 'BG Check', created_at: new Date(now + 1000).toISOString(), glucose: 100, glucoseType: 'Finger', units: 'mg/dl' },
          { eventType: 'Meal Bolus', created_at: new Date(now + 2000).toISOString(), carbs: 30, insulin: 2 },
          { eventType: 'Correction Bolus', created_at: new Date(now + 3000).toISOString(), insulin: 1.5 }
        ])
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.equal(4);
          done();
        });
    });
  });

  describe('Entries API - /api/entries/', function () {
    
    beforeEach(function (done) {
      self.ctx.entries().deleteMany({}, function () {
        done();
      });
    });

    afterEach(function (done) {
      self.ctx.entries().deleteMany({}, function () {
        done();
      });
    });

    it('POST accepts single SGV entry object', function (done) {
      var now = Date.now();
      request(self.app)
        .post('/api/entries/')
        .set('api-secret', known)
        .send({ type: 'sgv', sgv: 120, date: now, dateString: new Date(now).toISOString() })
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.be.greaterThanOrEqual(1);
          res.body[0].sgv.should.equal(120);
          done();
        });
    });

    it('POST accepts array with single SGV entry', function (done) {
      var now = Date.now();
      request(self.app)
        .post('/api/entries/')
        .set('api-secret', known)
        .send([{ type: 'sgv', sgv: 115, date: now, dateString: new Date(now).toISOString() }])
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.be.greaterThanOrEqual(1);
          res.body[0].sgv.should.equal(115);
          done();
        });
    });

    it('POST accepts array with multiple SGV entries', function (done) {
      var now = Date.now();
      request(self.app)
        .post('/api/entries/')
        .set('api-secret', known)
        .send([
          { type: 'sgv', sgv: 100, date: now, dateString: new Date(now).toISOString() },
          { type: 'sgv', sgv: 110, date: now + 300000, dateString: new Date(now + 300000).toISOString() },
          { type: 'sgv', sgv: 120, date: now + 600000, dateString: new Date(now + 600000).toISOString() }
        ])
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.equal(3);
          done();
        });
    });

    it('POST accepts single MBG entry object', function (done) {
      var now = Date.now();
      request(self.app)
        .post('/api/entries/')
        .set('api-secret', known)
        .send({ type: 'mbg', mbg: 95, date: now, dateString: new Date(now).toISOString() })
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.be.greaterThanOrEqual(1);
          res.body[0].mbg.should.equal(95);
          done();
        });
    });

    it('POST accepts mixed entry types in array', function (done) {
      var now = Date.now();
      request(self.app)
        .post('/api/entries/')
        .set('api-secret', known)
        .send([
          { type: 'sgv', sgv: 110, date: now, dateString: new Date(now).toISOString() },
          { type: 'mbg', mbg: 100, date: now + 60000, dateString: new Date(now + 60000).toISOString() }
        ])
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.equal(2);
          done();
        });
    });

    it('POST handles large batch of entries', function (done) {
      var entries = [];
      var baseTime = Date.now();
      for (var i = 0; i < 10; i++) {
        entries.push({
          type: 'sgv',
          sgv: 100 + i,
          date: baseTime + i * 300000,
          dateString: new Date(baseTime + i * 300000).toISOString()
        });
      }
      request(self.app)
        .post('/api/entries/')
        .set('api-secret', known)
        .send(entries)
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.equal(10);
          done();
        });
    });

    it('POST with empty array returns empty array', function (done) {
      request(self.app)
        .post('/api/entries/')
        .set('api-secret', known)
        .send([])
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.equal(0);
          done();
        });
    });

    it('single entry input returns array response', function (done) {
      var now = Date.now();
      request(self.app)
        .post('/api/entries/')
        .set('api-secret', known)
        .send({ type: 'sgv', sgv: 105, date: now, dateString: new Date(now).toISOString() })
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          done();
        });
    });

    it('array input returns array response', function (done) {
      var now = Date.now();
      request(self.app)
        .post('/api/entries/')
        .set('api-secret', known)
        .send([{ type: 'sgv', sgv: 108, date: now, dateString: new Date(now).toISOString() }])
        .expect(200)
        .end(function (err, res) {
          if (err) return done(err);
          res.body.should.be.instanceof(Array);
          done();
        });
    });
  });
});
