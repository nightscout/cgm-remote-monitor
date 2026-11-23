'use strict';

var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();

describe('_id Validation API Tests', function() {
  this.timeout(10000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

  var api = require('../lib/api/');

  before(function(done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    this.wares = require('../lib/middleware/')(self.env);
    self.app = require('express')();
    self.app.enable('api');
    self.app.enable('careportal');
    require('../lib/server/bootevent')(self.env, language).boot(function booted(ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.app.use('/api', api(self.env, ctx));
      done();
    });
  });

  describe('Activity API _id validation', function() {
    it('should return 400 for POST with invalid UUID _id', function(done) {
      request(self.app)
        .post('/api/activity/')
        .set('api-secret', known)
        .send({ "_id": "my-uuid-12345", "created_at": "2024-01-01T00:00:00Z", "steps": 1000 })
        .expect(400)
        .expect(function(response) {
          response.body.should.have.property('status', 400);
          response.body.message.should.match(/Invalid _id format/i);
        })
        .end(done);
    });

    it('should return 400 for PUT with invalid _id', function(done) {
      request(self.app)
        .put('/api/activity/')
        .set('api-secret', known)
        .send({ "_id": "not-valid", "created_at": "2024-01-01T00:00:00Z", "steps": 1000 })
        .expect(400)
        .end(done);
    });

    it('should return 400 for DELETE with invalid _id', function(done) {
      request(self.app)
        .delete('/api/activity/invalid-id')
        .set('api-secret', known)
        .expect(400)
        .end(done);
    });

    it('should accept POST without _id (auto-generate)', function(done) {
      request(self.app)
        .post('/api/activity/')
        .set('api-secret', known)
        .send({ "created_at": "2024-01-01T00:00:00Z", "steps": 1000 })
        .expect(200)
        .end(done);
    });
  });

  describe('Food API _id validation', function() {
    it('should return 400 for POST with invalid UUID _id', function(done) {
      request(self.app)
        .post('/api/food/')
        .set('api-secret', known)
        .send({ "_id": "my-uuid-12345", "name": "Apple", "type": "food", "carbs": 15 })
        .expect(400)
        .expect(function(response) {
          response.body.should.have.property('status', 400);
          response.body.message.should.match(/Invalid _id format/i);
        })
        .end(done);
    });

    it('should return 400 for PUT with invalid _id', function(done) {
      request(self.app)
        .put('/api/food/')
        .set('api-secret', known)
        .send({ "_id": "not-valid", "name": "Apple", "type": "food", "carbs": 15 })
        .expect(400)
        .end(done);
    });

    it('should return 400 for DELETE with invalid _id', function(done) {
      request(self.app)
        .delete('/api/food/invalid-id')
        .set('api-secret', known)
        .expect(400)
        .end(done);
    });

    it('should accept POST without _id (auto-generate)', function(done) {
      request(self.app)
        .post('/api/food/')
        .set('api-secret', known)
        .send({ "name": "Banana", "type": "food", "carbs": 27 })
        .expect(200)
        .expect(function(response) {
          // Food API returns array (consistent with treatments pattern)
          response.body.should.be.an.Array();
          response.body.length.should.equal(1);
          response.body[0].should.have.property('name', 'Banana');
        })
        .end(done);
    });
  });
});
