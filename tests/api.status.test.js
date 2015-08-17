'use strict';

var request = require('supertest');
require('should');

describe('Status REST api', function ( ) {
  var api = require('../lib/api/');
  before(function (done) {
    var env = require('../env')( );
    env.settings.enable = 'careportal rawbg';
    env.api_secret = 'this is my long pass phrase';
    this.wares = require('../lib/middleware/')(env);
    this.app = require('express')( );
    this.app.enable('api');
    var self = this;
    require('../lib/bootevent')(env).boot(function booted (ctx) {
      self.app.use('/api', api(env, ctx));
      done();
    });
  });

  it('/status.json', function (done) {
    request(this.app)
      .get('/api/status.json')
      .expect(200)
      .end(function (err, res)  {
        res.body.apiEnabled.should.equal(true);
        res.body.careportalEnabled.should.equal(true);
        res.body.settings.enable.should.equal('careportal rawbg');
        done( );
      });
  });

  it('/status.html', function (done) {
    request(this.app)
      .get('/api/status.html')
      .end(function(err, res) {
        res.type.should.equal('text/html');
        res.statusCode.should.equal(200);
        done();
      });
  });

  it('/status.js', function (done) {
    request(this.app)
      .get('/api/status.js')
      .end(function(err, res) {
        res.type.should.equal('application/javascript');
        res.statusCode.should.equal(200);
        res.text.should.startWith('this.serverSettings =');
        done();
      });
  });

  it('/status.png', function (done) {
    request(this.app)
      .get('/api/status.png')
      .end(function(err, res) {
        res.headers.location.should.equal('http://img.shields.io/badge/Nightscout-OK-green.png');
        res.statusCode.should.equal(302);
        done();
      });
  });


});

