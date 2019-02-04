'use strict';

var request = require('supertest');

require('should');

describe('Security of REST API3', function ( ) {
  var instance = require('./fixtures/api3/instance')
    , self = this;

  this.timeout(30000);

  before(function (done) {
    self.https = instance.initHttps(function initialized () {
      done();
    });
  });
  
  it('GET /test', function (done) {
    request(self.https.baseUrl)
      .get('/api/v3/test')
      .expect(401)
      .end(function (err, res) {
        var apiConst = require('../lib/api3/const.json')

        res.body.status.should.equal(401);
        res.body.message.should.equal(apiConst.MSG.HTTP_401_MISSING_DATE);

        done();
      });
  });

  after(function after () {
    self.https.server.close();
  });
});