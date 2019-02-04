'use strict';

var request = require('supertest')
  , apiConst = require('../lib/api3/const.json')

require('should');

describe('Security of REST API3', function ( ) {
  var instance = require('./fixtures/api3/instance')
    , self = this;

  this.timeout(30000);

  before(function (done) {
    self.http = instance.initHttp(function initialized () {
      self.https = instance.initHttps(function initialized () {
        done();
      });
    });
  });
  
  it('should require HTTPS', function (done) {
    request(self.http.baseUrl)
      .get('/api/v3/test')
      .expect(403)
      .end(function (err, res) {
        res.body.status.should.equal(403);
        res.body.message.should.equal(apiConst.MSG.HTTP_403_NOT_USING_HTTPS);

        done();
      });
  });

  it('should require Date header', function (done) {
    request(self.https.baseUrl)
      .get('/api/v3/test')
      .expect(401)
      .end(function (err, res) {
        res.body.status.should.equal(401);
        res.body.message.should.equal(apiConst.MSG.HTTP_401_MISSING_DATE);

        done();
      });
  });

  after(function after () {
    self.http.server.close();
    self.https.server.close();
  });
});