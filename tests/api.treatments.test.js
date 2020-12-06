'use strict';

var request = require('supertest');
var should = require('should');

describe('Treatment API', function ( ) {
  var self = this;

  var api = require('../lib/api/');
  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../env')();
    self.env.settings.enable = ['careportal'];
    this.wares = require('../lib/middleware/')(self.env);
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/bootevent')(self.env).boot(function booted(ctx) {
      self.ctx = ctx;
      self.app.use('/api', api(self.env, ctx));
      done();
    });
  });

  after(function () {
    delete process.env.API_SECRET;
  });

  it('post a some treatments', function (done) {
    self.ctx.bus.on('data-loaded', function dataWasLoaded ( ) {
      self.ctx.data.treatments.length.should.equal(3);
      self.ctx.data.treatments[0].mgdl.should.equal(100);
      should.not.exist(self.ctx.data.treatments[0].eventTime);
      should.not.exist(self.ctx.data.treatments[0].notes);

      should.not.exist(self.ctx.data.treatments[1].eventTime);
      should.not.exist(self.ctx.data.treatments[1].glucose);
      should.not.exist(self.ctx.data.treatments[1].glucoseType);
      should.not.exist(self.ctx.data.treatments[1].units);
      self.ctx.data.treatments[1].insulin.should.equal(2);
      self.ctx.data.treatments[2].carbs.should.equal(30);

      done();
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
        .send({eventType: 'Meal Bolus', carbs: '30', insulin: '2.00', preBolus: '15', glucoseType: 'Finger', units: 'mg/dl'})
        .expect(200)
        .end(function (err) {
          if (err) {
            done(err);
          }
        });

    });
  });

});