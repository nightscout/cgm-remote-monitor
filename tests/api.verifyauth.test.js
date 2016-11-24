'use strict';

var request = require('supertest');
var language = require('../lib/language')();

require('should');

describe('Verifyauth REST api', function ( ) {
  var self = this;
  
  var api = require('../lib/api/');
  before(function (done) {
    self.env = require('../env')( );
    self.env.api_secret = 'this is my long pass phrase';
    this.wares = require('../lib/middleware/')(self.env);
    self.app = require('express')( );
    self.app.enable('api');
    require('../lib/bootevent')(self.env, language).boot(function booted (ctx) {
      self.app.use('/api', api(self.env, ctx));
      done();
    });
  });

  it('/verifyauth should return UNAUTHORIZED', function (done) {
    request(self.app)
      .get('/api/verifyauth')
      .expect(200)
      .end(function(err, res) {
        res.body.message.should.equal('UNAUTHORIZED');
        done();
      });
  });

  it('/verifyauth should return OK', function (done) {
    request(self.app)
      .get('/api/verifyauth')
      .set('api-secret', self.env.api_secret || '')
      .expect(200)
      .end(function(err, res) {
        res.body.message.should.equal('OK');
        done();
      });
  });


});

