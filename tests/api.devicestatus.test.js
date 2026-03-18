'use strict';

var _ = require('lodash');
var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();

describe('Devicestatus API', function ( ) {
  this.timeout(10000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

  var api = require('../lib/api/');
  
  // Use before() instead of beforeEach() for app setup - boots once for all tests
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

  it('post a devicestatus, query, delete, verify gone', function (done) {
    // insert a devicestatus - needs to be unique from example data
    console.log('Inserting devicestatus entry');
    request(self.app)
      .post('/api/devicestatus/')
      .set('api-secret', known || '')
      .send({
        device: 'xdripjs://rigName'
        , xdripjs: {
          state: 6
          , stateString: 'OK'
          , txStatus: 0
          , txStatusString: 'OK'
        }
        , created_at: '2018-12-16T01:00:52Z'
      })
      .expect(200)
      .end(function (err) {
        if (err) {
          done(err);
        } else {
          // make sure devicestatus was inserted successfully
          console.log('Ensuring devicestatus entry was inserted successfully');
          request(self.app)
            .get('/api/devicestatus/')
            .query('find[created_at][$gte]=2018-12-16')
            .query('find[created_at][$lte]=2018-12-17')
            .set('api-secret', known || '')
            .expect(200)
            .expect(function (response) {
              console.log(JSON.stringify(response.body[0]));
              response.body[0].xdripjs.state.should.equal(6);
              response.body[0].utcOffset.should.equal(0);
            })
            .end(function (err) {
              if (err) {
                done(err);
              } else {
                // delete the treatment
                console.log('Deleting test treatment entry');
                request(self.app)
                  .delete('/api/devicestatus/')
                  .query('find[created_at][$gte]=2018-12-16')
                  .set('api-secret', known || '')
                  .expect(200)
                  .end(function (err) {
                    if (err) {
                      done(err);
                    } else {
                      // make sure it was deleted
                      console.log('Testing if devicestatus was deleted');
                      request(self.app)
                        .get('/api/devicestatus/')
                        .query('find[created_at][$lte]=2018-12-16')
                        .set('api-secret', known || '')
                        .expect(200)
                        .expect(function (response) {
                          response.body.length.should.equal(0);
                        })
                        .end(done);
                    }
                  });
              }
            });
        }
      });
  });

  // _id validation tests (prevent silent data corruption and ensure 400 on invalid)
  describe('_id validation', function() {

    it('should return 400 for POST with invalid UUID _id', function(done) {
      var status_with_uuid = {
        "_id": "my-uuid-12345",
        "device": "test-device",
        "created_at": "2024-01-01T00:00:00Z"
      };

      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', known || '')
        .send(status_with_uuid)
        .expect(400)
        .expect(function(response) {
          response.body.should.have.property('status', 400);
          response.body.should.have.property('message');
          response.body.message.should.match(/Invalid _id format/i);
        })
        .end(done);
    });

    it('should return 400 for POST with short _id', function(done) {
      var status_short_id = {
        "_id": "abc",
        "device": "test-device",
        "created_at": "2024-01-01T00:00:00Z"
      };

      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', known || '')
        .send(status_short_id)
        .expect(400)
        .end(done);
    });

    it('should return 400 for DELETE with invalid _id', function(done) {
      request(self.app)
        .delete('/api/devicestatus/invalid-uuid-here')
        .set('api-secret', known || '')
        .expect(400)
        .expect(function(response) {
          response.body.message.should.match(/Invalid _id format/i);
        })
        .end(done);
    });

    it('should accept POST with valid 24-hex _id', function(done) {
      // Use a unique ID that doesn't conflict with other tests
      var testId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
      var status_valid_id = {
        "_id": testId,
        "device": "test-device-valid",
        "created_at": "2024-01-02T00:00:00Z"
      };

      // First, try to delete any existing document with this _id (cleanup from previous runs)
      request(self.app)
        .delete('/api/devicestatus/' + testId)
        .set('api-secret', known || '')
        .end(function() {
          // Ignore errors (document may not exist)
          request(self.app)
            .post('/api/devicestatus/')
            .set('api-secret', known || '')
            .send(status_valid_id)
            .expect(200)
            .expect(function(response) {
              response.body.should.be.an.Array();
              response.body.length.should.equal(1);
              response.body[0]._id.should.equal(testId);
            })
            .end(function(err) {
              if (err) return done(err);
              // Clean up
              request(self.app)
                .delete('/api/devicestatus/' + testId)
                .set('api-secret', known || '')
                .expect(200)
                .end(done);
            });
        });
    });

    it('should accept POST without _id (auto-generate)', function(done) {
      var status_no_id = {
        "device": "test-device-autogen",
        "created_at": "2024-01-03T00:00:00Z"
      };

      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', known || '')
        .send(status_no_id)
        .expect(200)
        .expect(function(response) {
          response.body.should.be.an.Array();
          response.body.length.should.equal(1);
          response.body[0].should.have.property('_id');
          // Verify auto-generated _id is valid ObjectId format
          response.body[0]._id.toString().should.match(/^[a-fA-F0-9]{24}$/);
        })
        .end(function(err, res) {
          if (err) return done(err);
          // Clean up
          var createdId = res.body[0]._id;
          request(self.app)
            .delete('/api/devicestatus/' + createdId)
            .set('api-secret', known || '')
            .expect(200)
            .end(done);
        });
    });

    it('should return 400 for array POST with one invalid _id', function(done) {
      var statuses_mixed = [
        { "device": "device1", "created_at": "2024-01-01T00:00:00Z" },
        { "_id": "bad-uuid", "device": "device2", "created_at": "2024-01-02T00:00:00Z" }
      ];

      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', known || '')
        .send(statuses_mixed)
        .expect(400)
        .expect(function(response) {
          response.body.message.should.match(/Invalid _id format/i);
        })
        .end(done);
    });

    it('should allow DELETE with wildcard _id', function(done) {
      // First insert a test record
      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', known || '')
        .send({ "device": "delete-wildcard-test", "created_at": "2020-01-01T00:00:00Z" })
        .expect(200)
        .end(function(err) {
          if (err) return done(err);
          // Wildcard delete with date filter should work
          request(self.app)
            .delete('/api/devicestatus/*')
            .query('find[created_at][$lte]=2020-01-02')
            .set('api-secret', known || '')
            .expect(200)
            .end(done);
        });
    });
  });
});
