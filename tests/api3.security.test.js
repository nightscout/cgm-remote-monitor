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
  
  it('should require HTTPS', function () {
    request(self.http.baseUrl)
      .get('/api/v3/test')
      .expect(403)
      .end(function (err, res) {
        res.body.status.should.equal(403);
        res.body.message.should.equal(apiConst.MSG.HTTP_403_NOT_USING_HTTPS);
      });
  });

  it('should require Date header', function () {
    request(self.https.baseUrl)
      .get('/api/v3/test')
      .expect(401)
      .end(function (err, res) {
        res.body.status.should.equal(401);
        res.body.message.should.equal(apiConst.MSG.HTTP_401_MISSING_DATE);
      });
  });

  it('should validate Date header syntax', function () {
    request(self.https.baseUrl)
      .get('/api/v3/test')
      .set('Date', 'invalid date header')
      .expect(401)
      .end(function (err, res) {
        res.body.status.should.equal(401);
        res.body.message.should.equal(apiConst.MSG.HTTP_401_BAD_DATE);
      });
  });

  it('should reject Date header out of tolerance', function () {
    var oldDate =  new Date((new Date() * 1) - 2 * 3600 * 1000);
    var futureDate =  new Date((new Date() * 1) + 2 * 3600 * 1000);

    request(self.https.baseUrl)
      .get('/api/v3/test')
      .set('Date',oldDate.toUTCString())
      .expect(401)
      .end(function (err, res) {
        res.body.status.should.equal(401);
        res.body.message.should.equal(apiConst.MSG.HTTP_401_DATE_OUT_OF_TOLERANCE);
      });

    request(self.https.baseUrl)
      .get('/api/v3/test')
      .set('Date',futureDate.toUTCString())
      .expect(401)
      .end(function (err, res) {
        res.body.status.should.equal(401);
        res.body.message.should.equal(apiConst.MSG.HTTP_401_DATE_OUT_OF_TOLERANCE);
      });
  });

  after(function after () {
    self.http.server.close();
    self.https.server.close();
  });
});