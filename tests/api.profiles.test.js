'use strict';

var _ = require('lodash');
var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();

describe('Profiles API', function ( ) {
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

  it('put a profile, query, delete, verify gone', function (done) {
    // insert a sample profile - needs to be unique from example data
    var sample_profile = {"defaultProfile":"Default","store":{"Default":{"dia":3,"carbratio":[{"time":"00:00","value":30,"timeAsSeconds":0}],"carbs_hr":20,"delay":20,"sens":[{"time":"00:00","value":100,"timeAsSeconds":0}],"timezone":"US/Pacific","basal":[{"time":"00:00","value":0.1,"timeAsSeconds":0}],"target_low":[{"time":"00:00","value":100,"timeAsSeconds":0}],"target_high":[{"time":"00:00","value":100,"timeAsSeconds":0}],"units":"mg/dl"}},"startDate":"2024-10-19T23:00:00.000Z","mills":0,"created_at":"2024-10-26T20:32:49.173Z","srvModified":1732653169173,"units":"mg/dl"};
    console.log('Inserting profile entry');
    request(self.app)
      .put('/api/profile/')
      .set('api-secret', known || '')
      .send(sample_profile)
      .expect(200)
      .end(function (err) {
        if (err) {
          done(err);
        } else {
          // make sure devicestatus was inserted successfully
          console.log('Ensuring profile was inserted successfully');
          request(self.app)
            .get('/api/profile/')
            .query('find[created_at][$gte]=2024-10-27T20:32&find[created_at][$lte]=2024-10-25T20:322')
            .set('api-secret', known || '')
            .expect(200)
            .expect(function (response) {
              console.log(JSON.stringify(response.body[0]));
            })
            .end(function (err, res) {
              if (err) {
                done(err);
              } else {
                // delete the treatment
                console.log('Deleting test profile entry', res.body.length);
                var profile_to_delete = res.body[0]._id;
                var total_profiles_available = res.body.length;
                request(self.app)
                  .delete('/api/profile/' + profile_to_delete)
                  .set('api-secret', known || '')
                  .expect(200)
                  .end(function (err) {
                    if (err) {
                      done(err);
                    } else {
                      // make sure it was deleted
                      console.log('Testing if profile was deleted');
                      request(self.app)
                        // .get('/api/profile/' + profile_to_delete)
                        .get('/api/profile/')
                        // TODO: apparently profile does not accept search params
                        .query('find[created_at][$gte]=2024-10-27T20:32&find[created_at][$lte]=2024-10-25T20:322')
                        .set('api-secret', known || '')
                        .expect(200)
                        .expect(function (response) {
                          response.body.length.should.equal(total_profiles_available - 1);
                        })
                        .end(done);
                    }
                  });
              }
            });
        }
      });
  });
  it('post a profile, query, delete, verify gone', function (done) {
    // insert a sample profile - needs to be unique from example data
    var sample_profile = {"defaultProfile":"Default","store":{"Default":{"dia":3,"carbratio":[{"time":"00:00","value":30,"timeAsSeconds":0}],"carbs_hr":20,"delay":20,"sens":[{"time":"00:00","value":100,"timeAsSeconds":0}],"timezone":"US/Pacific","basal":[{"time":"00:00","value":0.1,"timeAsSeconds":0}],"target_low":[{"time":"00:00","value":100,"timeAsSeconds":0}],"target_high":[{"time":"00:00","value":100,"timeAsSeconds":0}],"units":"mg/dl"}},"startDate":"2024-10-19T23:00:00.000Z","mills":0,"created_at":"2024-10-26T20:32:49.173Z","srvModified":1732653169173,"units":"mg/dl"};
    console.log('Inserting profile entry');
    request(self.app)
      .post('/api/profile/')
      .set('api-secret', known || '')
      .send(sample_profile)
      .expect(200)
      .end(function (err) {
        if (err) {
          done(err);
        } else {
          // make sure devicestatus was inserted successfully
          console.log('Ensuring profile was inserted successfully');
          request(self.app)
            .get('/api/profile/')
            .query('find[created_at][$gte]=2024-10-27T20:32&find[created_at][$lte]=2024-10-25T20:322')
            .set('api-secret', known || '')
            .expect(200)
            .expect(function (response) {
              console.log(JSON.stringify(response.body[0]));
            })
            .end(function (err, res) {
              if (err) {
                done(err);
              } else {
                // delete the treatment
                console.log('Deleting test profile entry', res.body.length);
                var profile_to_delete = res.body[0]._id;
                var total_profiles_available = res.body.length;
                request(self.app)
                  .delete('/api/profile/' + profile_to_delete)
                  .set('api-secret', known || '')
                  .expect(200)
                  .end(function (err) {
                    if (err) {
                      done(err);
                    } else {
                      // make sure it was deleted
                      console.log('Testing if profile was deleted');
                      request(self.app)
                        // .get('/api/profile/' + profile_to_delete)
                        .get('/api/profile/')
                        // TODO: apparently profile does not accept search params
                        .query('find[created_at][$gte]=2024-10-27T20:32&find[created_at][$lte]=2024-10-25T20:322')
                        .set('api-secret', known || '')
                        .expect(200)
                        .expect(function (response) {
                          response.body.length.should.equal(total_profiles_available - 1);
                        })
                        .end(done);
                    }
                  });
              }
            });
        }
      });
  });

  // _id validation tests (prevent 500 errors from invalid ObjectId)
  describe('_id validation', function() {

    it('should return 400 for POST with invalid UUID _id', function(done) {
      var profile_with_uuid = {
        "_id": "my-uuid-12345",
        "defaultProfile": "Default",
        "store": { "Default": { "dia": 3 } },
        "startDate": "2024-10-19T23:00:00.000Z"
      };

      request(self.app)
        .post('/api/profile/')
        .set('api-secret', known || '')
        .send(profile_with_uuid)
        .expect(400)
        .expect(function(response) {
          response.body.should.have.property('status', 400);
          response.body.should.have.property('message');
          response.body.message.should.match(/Invalid _id format/i);
        })
        .end(done);
    });

    it('should return 400 for POST with short _id', function(done) {
      var profile_short_id = {
        "_id": "abc",
        "defaultProfile": "Default",
        "store": { "Default": { "dia": 3 } },
        "startDate": "2024-10-19T23:00:00.000Z"
      };

      request(self.app)
        .post('/api/profile/')
        .set('api-secret', known || '')
        .send(profile_short_id)
        .expect(400)
        .end(done);
    });

    it('should return 400 for PUT with invalid _id', function(done) {
      var profile_invalid = {
        "_id": "not-a-valid-object-id",
        "defaultProfile": "Default",
        "store": { "Default": { "dia": 3 } },
        "startDate": "2024-10-19T23:00:00.000Z"
      };

      request(self.app)
        .put('/api/profile/')
        .set('api-secret', known || '')
        .send(profile_invalid)
        .expect(400)
        .end(done);
    });

    it('should return 400 for DELETE with invalid _id', function(done) {
      request(self.app)
        .delete('/api/profile/invalid-uuid-here')
        .set('api-secret', known || '')
        .expect(400)
        .end(done);
    });

    it('should accept POST with valid 24-hex _id', function(done) {
      // Use a unique ID that doesn't conflict with other tests
      var testId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
      var profile_valid_id = {
        "_id": testId,
        "defaultProfile": "Default",
        "store": { "Default": { "dia": 3 } },
        "startDate": "2024-10-19T23:00:00.000Z"
      };

      // First, try to delete any existing document with this _id (cleanup from previous runs)
      request(self.app)
        .delete('/api/profile/' + testId)
        .set('api-secret', known || '')
        .end(function() {
          // Ignore errors (document may not exist)
          request(self.app)
            .post('/api/profile/')
            .set('api-secret', known || '')
            .send(profile_valid_id)
            .expect(200)
            .expect(function(response) {
              response.body.should.be.an.Array();
              response.body.length.should.equal(1);
              response.body[0]._id.should.equal(testId);
            })
            .end(function(err) {
              if (err) return done(err);
              // Clean up: delete the profile we just created
              request(self.app)
                .delete('/api/profile/' + testId)
                .set('api-secret', known || '')
                .expect(200)
                .end(done);
            });
        });
    });

    it('should accept POST without _id (auto-generate)', function(done) {
      var profile_no_id = {
        "defaultProfile": "Default",
        "store": { "Default": { "dia": 3 } },
        "startDate": "2024-10-20T23:00:00.000Z"
      };

      request(self.app)
        .post('/api/profile/')
        .set('api-secret', known || '')
        .send(profile_no_id)
        .expect(200)
        .expect(function(response) {
          response.body.should.be.an.Array();
          response.body.length.should.equal(1);
          response.body[0].should.have.property('_id');
          // Verify auto-generated _id is valid format
          response.body[0]._id.toString().should.match(/^[a-fA-F0-9]{24}$/);
        })
        .end(function(err, res) {
          if (err) return done(err);
          // Clean up
          var createdId = res.body[0]._id;
          request(self.app)
            .delete('/api/profile/' + createdId)
            .set('api-secret', known || '')
            .expect(200)
            .end(done);
        });
    });

    it('should return 400 for array POST with one invalid _id', function(done) {
      var profiles_mixed = [
        { "defaultProfile": "Default1", "store": { "Default": { "dia": 3 } }, "startDate": "2024-10-19T23:00:00.000Z" },
        { "_id": "bad-uuid", "defaultProfile": "Default2", "store": { "Default": { "dia": 3 } }, "startDate": "2024-10-20T23:00:00.000Z" }
      ];

      request(self.app)
        .post('/api/profile/')
        .set('api-secret', known || '')
        .send(profiles_mixed)
        .expect(400)
        .expect(function(response) {
          response.body.message.should.match(/Invalid _id format/i);
        })
        .end(done);
    });
  });
});
