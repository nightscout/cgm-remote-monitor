'use strict';

var _ = require('lodash');
var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();

describe('Treatment API', function ( ) {
  this.timeout(10000);
  var self = this;

  var api = require('../lib/api/');
  beforeEach(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../env')();
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

  after(function () {
    // delete process.env.API_SECRET;
  });

  it('post single treatments', function (done) {

    self.ctx.treatments().remove({ }, function ( ) {
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', self.env.api_secret || '')
        .send({eventType: 'Meal Bolus', carbs: '30', insulin: '2.00', preBolus: '15', glucose: 100, glucoseType: 'Finger', units: 'mg/dl'})
        .expect(200)
        .end(function (err) {
          if (err) {
            done(err);
          } else {
            self.ctx.treatments.list({}, function (err, list) {
              var sorted = _.sortBy(list, function (treatment) {
                return treatment.created_at;
              });
              sorted.length.should.equal(2);
              sorted[0].glucose.should.equal(100);
              should.not.exist(sorted[0].eventTime);
              sorted[0].insulin.should.equal(2);
              sorted[1].carbs.should.equal(30);

              done();
            });
          }
        });

    });
  });

  it('post a treatment array', function (done) {
    self.ctx.treatments().remove({ }, function ( ) {
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', self.env.api_secret || '')
        .send([
          {eventType: 'BG Check', glucose: 100, preBolus: '0', glucoseType: 'Finger', units: 'mg/dl', notes: ''}
          , {eventType: 'Meal Bolus', carbs: '30', insulin: '2.00', preBolus: '15', glucose: 100, glucoseType: 'Finger', units: 'mg/dl'}
         ])
        .expect(200)
        .end(function (err) {
          if (err) {
            done(err);
          } else {
            self.ctx.treatments.list({}, function (err, list) {
              list.length.should.equal(3);
              should.not.exist(list[0].eventTime);
              should.not.exist(list[1].eventTime);

              done();
            });
          }
        });
    });
  });

  it('post a treatment array and dedupe', function (done) {
    self.ctx.treatments().remove({ }, function ( ) {
      var now = (new Date()).toISOString();
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', self.env.api_secret || '')
        .send([
          {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now}
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now}
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now}
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now}
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now}
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now}
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now}
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now}
          , {eventType: 'Meal Bolus', carbs: '30', insulin: '2.00', preBolus: '15', glucose: 100, glucoseType: 'Finger', units: 'mg/dl'}
        ])
        .expect(200)
        .end(function (err) {
          if (err) {
            done(err);
          } else {
            self.ctx.treatments.list({}, function (err, list) {
              var sorted = _.sortBy(list, function (treatment) {
                return treatment.created_at;
              });

              if (sorted.length !== 3) {
                console.info('unexpected result length, sorted treatments:', sorted);
              }
              sorted.length.should.equal(3);
              sorted[0].glucose.should.equal(100);

              done();
            });
          }
        });
    });
  });
  it('post a treatment, query, delete, verify gone', function (done) {
    // insert a treatment - needs to be unique from example data
    console.log('Inserting treatment entry');
    request(self.app)
      .post('/api/treatments/')
      .set('api-secret', self.env.api_secret || '')
      .send({eventType: 'Meal Bolus', carbs: '99', insulin: '2.00', preBolus: '15', glucose: 100, glucoseType: 'Finger', units: 'mg/dl'})
      .expect(200)
      .end(function (err) {
        if (err) {
          done(err);
        } else {
          // make sure treatment was inserted successfully
          console.log('Ensuring treatment entry was inserted successfully');
          request(self.app)
            .get('/api/treatments/')
            .query('find[carbs]=99')
            .set('api-secret', self.env.api_secret || '')
            .expect(200)
            .expect(function (response) {
              response.body[0].carbs.should.equal(99);
            })
            .end(function (err) {
              if (err) {
                done(err);
              } else {
                // delete the treatment
                console.log('Deleting test treatment entry');
                request(self.app)
                  .delete('/api/treatments/')
                  .query('find[carbs]=99')
                  .set('api-secret', self.env.api_secret || '')
                  .expect(200)
                  .end(function (err) {
                    if (err) {
                      done(err);
                    } else {
                      // make sure it was deleted
                      console.log('Testing if entry was deleted');
                      request(self.app)
                        .get('/api/treatments/')
                        .query('find[carbs]=99')
                        .set('api-secret', self.env.api_secret || '')
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
});
