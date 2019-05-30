'use strict';

var request = require('supertest')
  , apiConst = require('../lib/api3/const.json')

require('should');

describe('Security of REST API3', function ( ) {
  var instance = require('./fixtures/api3/instance')
    , self = this;

  this.timeout(30000);

  before(function (done) {
    console.debug('api3.security.test-starting HTTP', (new Date()).toISOString());
    self.http = instance.initHttp(function initialized () {
      console.debug('api3.security.test-starting HTTPS', (new Date()).toISOString());
      self.https = instance.initHttps(function initialized () {
        
        console.debug('api3.security.test-HTTP and HTTPS initialized', (new Date()).toISOString(), self.http.baseUrl, self.https.baseUrl);

        require('./fixtures/api3/authSubject')(self.https.env, self.https.ctx, self.https.ctx.authorization.storage, 
          function subjectsReady (authSubjects) {
          self.subjects = authSubjects;

          done();
        });
      });
    });
  });
  
  it('should require HTTPS', function (done) {
    try
    {
      request(self.http.baseUrl)
        .get('/api/v3/test')
        .expect(403)
        .end(function (err, res) {
          try
          {
            console.debug('should require HTTPS response:', res.body);
            res.body.status.should.equal(403);
            res.body.message.should.equal(apiConst.MSG.HTTP_403_NOT_USING_HTTPS);

            done();
          } catch (err) {
            console.error(err);
            done();
            throw err;
          }
        });
    } catch (err) {
      console.error(err);
      done();
      throw err;
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
    var oldDate = new Date((new Date() * 1) - 2 * 3600 * 1000);
    var futureDate = new Date((new Date() * 1) + 2 * 3600 * 1000);

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
      .get('/api/v3/test?token=' + self.subjects.denied.accessToken)
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
      .get('/api/v3/test?token=' + self.subjects.readable.accessToken)
      .set('Date', new Date().toUTCString())
      .expect(200)
      .end(function () {

        done();
      });
  });

  after(function after () {
    self.http.server.close();
    self.https.server.close();
  });
});