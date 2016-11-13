'use strict';

var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();

describe('Treatment API', function ( ) {
  this.timeout(2000);
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
    require('../lib/bootevent')(self.env, language).boot(function booted(ctx) {
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
    var doneCalled = false;

    self.ctx.bus.on('data-loaded', function dataWasLoaded ( ) {
      self.ctx.ddata.treatments.length.should.equal(3);
      self.ctx.ddata.treatments[0].mgdl.should.equal(100);
      should.not.exist(self.ctx.ddata.treatments[0].eventTime);
      should.not.exist(self.ctx.ddata.treatments[0].notes);

      should.not.exist(self.ctx.ddata.treatments[1].eventTime);
      self.ctx.ddata.treatments[1].insulin.should.equal(2);
      self.ctx.ddata.treatments[2].carbs.should.equal(30);

      //if travis is slow the 2 posts take long enough that 2 data-loaded events are emitted
      if (!doneCalled) { done(); }

      doneCalled = true;
    });

    self.ctx.treatments().remove({ }, function ( ) {
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', self.env.api_secret || '')
        .send({eventType: 'BG Check', glucose: 100, preBolus: '0', glucoseType: 'Finger', units: 'mg/dl', notes: ''})
        .expect(200)
        .end(function (err) {
          if (err) {
            done(err);
          }
        });

      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', self.env.api_secret || '')
        .send({eventType: 'Meal Bolus', carbs: '30', insulin: '2.00', preBolus: '15', glucose: 100, glucoseType: 'Finger', units: 'mg/dl'})
        .expect(200)
        .end(function (err) {
          if (err) {
            done(err);
          }
        });

    });
  });

  it('post a treatment array', function (done) {
    var doneCalled = false;

    self.ctx.bus.on('data-loaded', function dataWasLoaded ( ) {
      self.ctx.ddata.treatments.length.should.equal(3);
      should.not.exist(self.ctx.ddata.treatments[0].eventTime);
      should.not.exist(self.ctx.ddata.treatments[1].eventTime);

      //if travis is slow the 2 posts take long enough that 2 data-loaded events are emitted
      if (!doneCalled) { done(); }

      doneCalled = true;
    });

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
          }
        });
    });
  });

  it('post a treatment array and dedupe', function (done) {
    var doneCalled = false;

    self.ctx.bus.on('data-loaded', function dataWasLoaded ( ) {
      self.ctx.ddata.treatments.length.should.equal(3);
      self.ctx.ddata.treatments[0].mgdl.should.equal(100);

      //if travis is slow the 2 posts take long enough that 2 data-loaded events are emitted
      if (!doneCalled) { done(); }

      doneCalled = true;
    });

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
          }
        });
    });
  });
});
