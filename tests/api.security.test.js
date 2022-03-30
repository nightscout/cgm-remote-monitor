/* eslint require-atomic-updates: 0 */
'use strict';

const request = require('supertest');
var language = require('../lib/language')();
require('should');
const jwt = require('jsonwebtoken');

describe('Security of REST API V1', function() {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject');

  this.timeout(30000);

  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

  before(function(done) {
    var api = require('../lib/api/');
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'denied';
    this.wares = require('../lib/middleware/')(self.env);
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(async function booted (ctx) {
      self.app.use('/api/v1', api(self.env, ctx));
      self.app.use('/api/v2/authorization', ctx.authorization.endpoints);
      let authResult = await authSubject(ctx.authorization.storage);
      self.subject = authResult.subject;
      self.token = authResult.token;

      done();
    });
  });

  it('Should fail on false token', function(done) {
    request(self.app)
      .get('/api/v2/authorization/request/12345')
      .expect(401)
      .end(function(err, res) {
        console.log(res.error);
        res.error.status.should.equal(401);
        done();
      });
  });

  it('Data load should fail unauthenticated', function(done) {
    request(self.app)
      .get('/api/v1/entries.json')
      .expect(401)
      .end(function(err, res) {
        console.log(res.error);
        res.error.status.should.equal(401);
        done();
      });
  });

  it('Should return a JWT on token', function(done) {
    const now = Math.round(Date.now() / 1000) - 1;
    request(self.app)
      .get('/api/v2/authorization/request/' + self.token.read)
      .expect(200)
      .end(function(err, res) {
        const decodedToken = jwt.decode(res.body.token);
        decodedToken.accessToken.should.equal(self.token.read);
        decodedToken.iat.should.be.aboveOrEqual(now);
        decodedToken.exp.should.be.above(decodedToken.iat);
        done();
      });
  });

  it('Data load should succeed with API SECRET', function(done) {
    request(self.app)
      .get('/api/v1/entries.json')
      .set('api-secret', known)
      .expect(200)
      .end(function(err, res) {
        done();
      });
  });

  it('Data load should succeed with GET token', function(done) {
    request(self.app)
      .get('/api/v1/entries.json?token=' + self.token.read)
      .expect(200)
      .end(function(err, res) {
        done();
      });
  });

  it('Data load should succeed with token in place of a secret', function(done) {
    request(self.app)
      .get('/api/v1/entries.json')
      .set('api-secret', self.token.read)
      .expect(200)
      .end(function(err, res) {
        done();
      });
  });

  it('Data load should succeed with a bearer token', function(done) {
    request(self.app)
      .get('/api/v2/authorization/request/' + self.token.read)
      .expect(200)
      .end(function(err, res) {
        const token = res.body.token;
        request(self.app)
          .get('/api/v1/entries.json')
          .set('Authorization', 'Bearer ' + token)
          .expect(200)
          .end(function(err, res) {
            done();
          });
      });
  });

  it('Data load fail succeed with a false bearer token', function(done) {
    request(self.app)
      .get('/api/v1/entries.json')
      .set('Authorization', 'Bearer 1234567890')
      .expect(401)
      .end(function(err, res) {
        done();
      });
  });

  it('/verifyauth should return OK for Bearer tokens', function (done) {
    request(self.app)
    .get('/api/v2/authorization/request/' + self.token.adminAll)
    .expect(200)
    .end(function(err, res) {
      const token = res.body.token;
      request(self.app)
      .get('/api/v1/verifyauth')
      .set('Authorization', 'Bearer ' + token)
      .expect(200)
      .end(function(err, res) {
        res.body.message.message.should.equal('OK');
        res.body.message.isAdmin.should.equal(true);        
        done();
      });
    });
  });

});
