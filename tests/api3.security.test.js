'use strict';

const request = require('supertest')
  , apiConst = require('../lib/api3/const.json')
  , semver = require('semver')
  ;
require('should');
  
describe('Security of REST API3', function ( ) {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    ;

  this.timeout(30000);

  before(function (done) {
    instance.create({ useHttps: false })

    .then(http => {
      self.http = http;
      return instance.create({ });
    })
    .then(https => {
      self.https = https;
      return authSubject(https.ctx.authorization.storage);
    })
    .then(result => {
      self.subject = result.subject;
      done();
    })
    .catch(err => {
      done(err);
    })

  });

  
  after(function after () {
    self.http.server.close();
    self.https.server.close();
  });


  it('should require HTTPS', function (done) {
    if (semver.gte(process.version, '10.0.0')) { 
    request(self.http.baseUrl)  // hangs on 8.x.x (no reason why)
      .get('/api/v3/test') 
      .expect(403)
      .end(function (err, res) {
        res.body.status.should.equal(403);
        res.body.message.should.equal(apiConst.MSG.HTTP_403_NOT_USING_HTTPS);
        done();
      }); 
    }
    else {
      done();
    }
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


  it('should validate Date header syntax', function (done) {
    request(self.https.baseUrl)
      .get('/api/v3/test')
      .set('Date', 'invalid date header')
      .expect(401)
      .end(function (err, res) {
        res.body.status.should.equal(401);
        res.body.message.should.equal(apiConst.MSG.HTTP_401_BAD_DATE);

        done();
      });
  });


  it('should reject Date header out of tolerance', function (done) {
    const oldDate = new Date((new Date() * 1) - 2 * 3600 * 1000)
      , futureDate = new Date((new Date() * 1) + 2 * 3600 * 1000);

    request(self.https.baseUrl)
      .get('/api/v3/test')
      .set('Date', oldDate.toUTCString())
      .expect(401)
      .end(function (err, res) {
        res.body.status.should.equal(401);
        res.body.message.should.equal(apiConst.MSG.HTTP_401_DATE_OUT_OF_TOLERANCE);

        request(self.https.baseUrl)
          .get('/api/v3/test')
          .set('Date',futureDate.toUTCString())
          .expect(401)
          .end(function (err, res) {
            res.body.status.should.equal(401);
            res.body.message.should.equal(apiConst.MSG.HTTP_401_DATE_OUT_OF_TOLERANCE);

            done();
          });
      });
  });


  it('should require token', function (done) {
    request(self.https.baseUrl)
      .get('/api/v3/test')
      .set('Date', new Date().toUTCString())
      .expect(401)
      .end(function (err, res) {
        res.body.status.should.equal(401);
        res.body.message.should.equal(apiConst.MSG.HTTP_401_MISSING_OR_BAD_TOKEN);

        done();
      });
  });


  it('should require valid token', function (done) {
    request(self.https.baseUrl)
      .get('/api/v3/test?token=invalid_token')
      .set('Date', new Date().toUTCString())
      .expect(401)
      .end(function (err, res) {
        res.body.status.should.equal(401);
        res.body.message.should.equal(apiConst.MSG.HTTP_401_MISSING_OR_BAD_TOKEN);

        done();
      });
  });


  it('should deny subject denied', function (done) {
    request(self.https.baseUrl)
      .get('/api/v3/test?token=' + self.subject.denied.accessToken)
      .set('Date', new Date().toUTCString())
      .expect(403)
      .end(function (err, res) {
        res.body.status.should.equal(403);
        res.body.message.should.equal(apiConst.MSG.HTTP_403_MISSING_PERMISSION.replace('{0}', 'api:entries:read'));

        done();
      });
  });


  it('should allow subject readable', function (done) {
    request(self.https.baseUrl)
      .get('/api/v3/test?token=' + self.subject.readable.accessToken)
      .set('Date', new Date().toUTCString())
      .expect(200)
      .end(function () {

        done();
      });
  });

});