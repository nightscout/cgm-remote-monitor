'use strict';

var request = require('supertest');
var language = require('../lib/language')();

require('should');

describe('Status REST api', function ( ) {
  var api = require('../lib/api/');
  before(function (done) {
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    var env = require('../lib/server/env')( );
    env.settings.enable = ['careportal', 'rawbg'];
    env.settings.authDefaultRoles = 'readable';
    env.api_secret = 'this is my long pass phrase';
    this.wares = require('../lib/middleware/')(env);
    this.app = require('express')( );
    this.app.enable('api');
    var self = this;
    require('../lib/server/bootevent')(env, language).boot(function booted (ctx) {
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
        res.body.settings.enable.length.should.equal(2);
        res.body.settings.enable.should.containEql('careportal');
        res.body.settings.enable.should.containEql('rawbg');
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

  it('/status.svg', function (done) {
    request(this.app)
      .get('/api/status.svg')
      .end(function(err, res) {
        res.statusCode.should.equal(302);
        done();
      });
  });

  it('/status.txt', function (done) {
    request(this.app)
      .get('/api/status.txt')
      .expect(200, 'STATUS OK')
      .end(function(err, res) {
        res.type.should.equal('text/plain');
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

