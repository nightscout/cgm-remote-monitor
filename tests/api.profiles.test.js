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
  beforeEach(function (done) {
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
});
