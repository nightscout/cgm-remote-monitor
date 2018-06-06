'use strict';

var _ = require('lodash');
var request = require('supertest');
require('should');

describe('Throttle', function ( ) {
  var self = this;

  var api = require('../lib/api/');
  before(function (done) {
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../env')();
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

  it('only update once when there are multiple posts', function (done) {

    //if the data-loaded event is triggered more than once the test will fail
    self.ctx.bus.on('data-loaded', function dataWasLoaded ( ) {
      done();
    });

    function post () {
      request(self.app)
        .post('/api/entries/')
        .set('api-secret', self.env.api_secret || '')
        .send({type: 'sgv', sgv: 100, date: Date.now()})
        .expect(200)
        .end(function(err) {
          if (err) {
            done(err);
          }
        });
    }

    _.times(10, post);
  });

});
