'use strict';

var request = require('supertest');
var language = require('../lib/language')();

require('should');

describe('Basic REST API3', function ( ) {
  var api = require('../lib/api3/')
    , testConst = require('./fixtures/api3/const.json')

  this.timeout(15000);

  before(function (done) {
    var env = require('../env')( );
    env.settings.enable = ['careportal', 'rawbg'];
    env.settings.authDefaultRoles = 'readable';
    env.api_secret = 'this is my long pass phrase';
    this.wares = require('../lib/middleware/')(env);
    this.app = require('express')( );
    this.app.enable('api');
    var self = this;
    require('../lib/server/bootevent')(env, language).boot(function booted (ctx) {
      self.app.use('/api/v3', api(env, ctx));
      done();
    });
  });

  it('GET /swagger', function (done) {
    request(this.app)
      .get('/api/v3/swagger.yaml')
      .expect(200)
      .end(function (err, res)  {
        done( );
      });
  });

  it('GET /version', function (done) {
    request(this.app)
      .get('/api/v3/version')
      .expect(200)
      .end(function (err, res) {
        var apiConst = require('../lib/api3/const.json')
          , software = require('../package.json');
        res.body.version.should.equal(software.version);
        res.body.apiVersion.should.equal(apiConst.API3_VERSION);
        res.body.storage.srvDate.should.be.within(testConst.YEAR_2019, testConst.YEAR_2050);

        res.body.storage.srvDateString.length.should.be.above(23);
        var srvDate = new Date(res.body.storage.srvDateString);
        srvDate.getTime().should.be.within(testConst.YEAR_2019, testConst.YEAR_2050);
        srvDate.getTime().should.equal(res.body.storage.srvDate);

        done();
      });
  });

});

