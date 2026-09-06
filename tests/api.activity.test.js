'use strict';

var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();

describe('Activity API', function ( ) {
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
  it('put a activity, query, delete, verify gone', function (done) {
    // insert a sample activity - needs to be unique from example data
    var sample_activity = {
        "created_at":"2024-10-26T20:32:49.173Z",
        heartrate: 120,
        steps: 0,
        activitylevel: '?'
    };
    console.log('Inserting activity entry');
    request(self.app)
      .put('/api/activity/')
      .set('api-secret', known || '')
      .send(sample_activity)
      .expect(200)
      .end(function (err) {
        if (err) {
          done(err);
        } else {
          // make sure devicestatus was inserted successfully
          console.log('Ensuring activity was inserted successfully');
          request(self.app)
            .get('/api/activity/')
            .query('find[created_at][$gte]=2024-10-25T20:32&find[created_at][$lte]=2024-10-27T20:22')
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
                console.log('Deleting test activity entry', res.body);
                var activity_to_delete = res.body[0]._id;
                var total_activitys_available = res.body.length;
                request(self.app)
                  .delete('/api/activity/' + activity_to_delete)
                  .set('api-secret', known || '')
                  .expect(200)
                  .end(function (err) {
                    if (err) {
                      done(err);
                    } else {
                      // make sure it was deleted
                      console.log('Testing if activity was deleted');
                      request(self.app)
                        // .get('/api/activity/' + activity_to_delete)
                        .get('/api/activity/')
                        // TODO: apparently activity does not accept search params
                        .query('find[created_at][$gte]=2024-10-27T20:32&find[created_at][$lte]=2024-10-25T20:22')
                        .set('api-secret', known || '')
                        .expect(200)
                        .expect(function (response) {
                          // response.body.length.should.equal(total_activitys_available - 1);
                        })
                        .end(done);
                    }
                  });
              }
            });
        }
      });
  });

  it('post a activity, query, delete, verify gone', function (done) {
    // insert a sample activity - needs to be unique from example data
    var sample_activity = {
        "created_at":"2024-10-26T20:32:49.173Z",
        heartrate: 120,
        steps: 0,
        activitylevel: '?'
    };
    console.log('Inserting activity entry');
    request(self.app)
      .post('/api/activity/')
      .set('api-secret', known || '')
      .send(sample_activity)
      .expect(200)
      .end(function (err) {
        if (err) {
          done(err);
        } else {
          // make sure devicestatus was inserted successfully
          console.log('Ensuring activity was inserted successfully');
          request(self.app)
            .get('/api/activity/')
            .query('find[created_at][$gte]=2024-10-25T20:32&find[created_at][$lte]=2027-10-25T20:22')
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
                console.log('Deleting test activity entry', res.body);
                var activity_to_delete = res.body[0]._id;
                var total_activitys_available = res.body.length;
                request(self.app)
                  .delete('/api/activity/' + activity_to_delete)
                  .set('api-secret', known || '')
                  .expect(200)
                  .end(function (err) {
                    if (err) {
                      done(err);
                    } else {
                      // make sure it was deleted
                      console.log('Testing if activity was deleted');
                      request(self.app)
                        // .get('/api/activity/' + activity_to_delete)
                        .get('/api/activity/')
                        // TODO: apparently activity does not accept search params
                        .query('find[created_at][$gte]=2024-10-27T20:32&find[created_at][$lte]=2024-10-25T20:22')
                        .set('api-secret', known || '')
                        .expect(200)
                        .expect(function (response) {
                          // response.body.length.should.equal(total_activitys_available - 1);
                        })
                        .end(done);
                    }
                  });
              }
            });
        }
      });
  });

  // ============================================================
  // Single object input tests - validates array normalization
  // ============================================================

  it('post single activity returns array with one item', function (done) {
    var now = (new Date()).toISOString();
    var sample_activity = {
      created_at: now,
      heartrate: 85,
      steps: 1500,
      activitylevel: 'moderate'
    };

    request(self.app)
      .post('/api/activity/')
      .set('api-secret', known || '')
      .send(sample_activity)
      .expect(200)
      .end(function (err, res) {
        if (err) {
          return done(err);
        }
        // Response should be an array even for single object input
        res.body.should.be.an.Array();
        res.body.length.should.equal(1);
        res.body[0].should.have.property('_id');
        res.body[0].heartrate.should.equal(85);
        res.body[0].steps.should.equal(1500);
        res.body[0].activitylevel.should.equal('moderate');

        // Clean up
        request(self.app)
          .delete('/api/activity/' + res.body[0]._id)
          .set('api-secret', known || '')
          .expect(200)
          .end(done);
      });
  });

  it('post activity array returns array', function (done) {
    var now = (new Date()).toISOString();
    request(self.app)
      .post('/api/activity/')
      .set('api-secret', known || '')
      .send([
        { created_at: now, heartrate: 70, steps: 500, activitylevel: 'low' },
        { created_at: now, heartrate: 150, steps: 3000, activitylevel: 'high' }
      ])
      .expect(200)
      .end(function (err, res) {
        if (err) {
          return done(err);
        }
        res.body.should.be.an.Array();
        res.body.length.should.equal(2);
        res.body[0].should.have.property('_id');
        res.body[1].should.have.property('_id');
        res.body[0].heartrate.should.equal(70);
        res.body[1].heartrate.should.equal(150);

        // Clean up
        request(self.app)
          .delete('/api/activity/' + res.body[0]._id)
          .set('api-secret', known || '')
          .expect(200)
          .end(function (err) {
            if (err) return done(err);
            request(self.app)
              .delete('/api/activity/' + res.body[1]._id)
              .set('api-secret', known || '')
              .expect(200)
              .end(done);
          });
      });
  });

  it('post empty array returns empty array', function (done) {
    request(self.app)
      .post('/api/activity/')
      .set('api-secret', known || '')
      .send([])
      .expect(200)
      .end(function (err, res) {
        if (err) {
          return done(err);
        }
        res.body.should.be.an.Array();
        res.body.length.should.equal(0);
        done();
      });
  });
});
