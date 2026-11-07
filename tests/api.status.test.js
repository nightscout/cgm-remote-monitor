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
    require('../lib/middleware/configure-request')(this.app);
    this.app.enable('api');
    var self = this;
    require('../lib/server/bootevent')(env, language).boot(function booted (ctx) {
      self.ctx = ctx;
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


  it('preserves JavaScript status by extension and explicit Accept header', async function () {
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const endpoint of ['/api/status.js?count=1', '/api/status']) {
        const res = await request(this.app).get(endpoint)
          .set('Accept', 'application/javascript').expect(200);
        res.type.should.equal('application/javascript');
        res.text.should.startWith('this.serverSettings =');
        const info = JSON.parse(res.text.slice('this.serverSettings = '.length, -2));
        info.status.should.equal('ok');
        info.apiEnabled.should.equal(true);
      }
    }
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


  it('returns the same subject authorization for header and legacy query credentials', async function () {
    const crypto = require('node:crypto');
    const auth = this.ctx.authorization;
    const previous = auth.storage.subjects;
    const token = 'fixture-0123456789abcdef';
    auth.storage.subjects = [{name:'Status fixture', accessToken:token,
      digest:'0123456789abcdef0123456789abcdef',
      accessTokenDigest:crypto.createHash('sha1').update(token).digest('hex'), roles:['readable']}];
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        for (const transport of ['header', 'token', 'secret']) {
          let call = request(this.app).get('/api/status.json');
          call = transport === 'header' ? call.set('api-secret', token) : call.query({[transport]:token});
          const result = await call.expect(200);
          result.body.authorized.sub.should.equal('Status fixture');
          result.body.authorized.permissionGroups.should.be.an.Array();
        }
      }
    } finally { auth.storage.subjects = previous; }
  });

});

