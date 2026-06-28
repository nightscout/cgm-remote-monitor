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

  function rolesCollection() {
    return self.ctx.store.collection(self.env.authentication_collections_prefix + 'roles');
  }

  function subjectsCollection() {
    return self.ctx.store.collection(self.env.authentication_collections_prefix + 'subjects');
  }

  async function getBearerToken(accessToken) {
    const res = await request(self.app)
      .get('/api/v2/authorization/request/' + accessToken)
      .expect(200);

    return res.body.token;
  }

  before(function(done) {
    var api = require('../lib/api/');
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'denied';
    self.env.settings.authFailDelay = 50;
    this.wares = require('../lib/middleware/')(self.env);
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(async function booted (ctx) {
      self.ctx = ctx;
      self.app.use('/api/v1', api(self.env, ctx));
      self.app.use('/api/v2/authorization', ctx.authorization.endpoints);
      let authResult = await authSubject(ctx.authorization.storage);
      self.subject = authResult.subject;
      self.token = authResult.accessToken;

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

  it('Should return a JWT with default roles on broken role token', function(done) {
    const now = Math.round(Date.now() / 1000) - 1;
    request(self.app)
      .get('/api/v2/authorization/request/' + self.token.noneSubject)
      .expect(200)
      .end(function(err, res) {
        const decodedToken = jwt.decode(res.body.token);
        decodedToken.accessToken.should.equal(self.token.noneSubject);
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

  it('Data load should fail with a false bearer token without logging a JWT TypeError', function(done) {
    const originalError = console.error;
    const errors = [];
    console.error = function captureConsoleError () {
      errors.push(Array.prototype.slice.call(arguments).join(' '));
      return originalError.apply(console, arguments);
    };

    request(self.app)
      .get('/api/v1/entries.json')
      .set('Authorization', 'Bearer 1234567890')
      .expect(401)
      .end(function(err) {
        console.error = originalError;
        if (err) return done(err);
        errors.join('\n').should.not.containEql('Cannot read properties of null');
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

  describe('Authorization admin save endpoints', function () {
    beforeEach(async function () {
      await rolesCollection().deleteMany({ name: /^api-security-role/ });
      await subjectsCollection().deleteMany({ name: /^api-security-subject/ });
    });

    afterEach(async function () {
      await rolesCollection().deleteMany({ name: /^api-security-role/ });
      await subjectsCollection().deleteMany({ name: /^api-security-subject/ });
    });

    it('PUT /api/v2/authorization/subjects updates an existing subject by _id', async function () {
      const insertResult = await subjectsCollection().insertOne({
        name: 'api-security-subject-update',
        roles: ['readable'],
        notes: 'original',
        created_at: '2024-10-26T20:32:49.173Z'
      });
      const token = await getBearerToken(self.token.adminAll);

      await request(self.app)
        .put('/api/v2/authorization/subjects')
        .set('Authorization', 'Bearer ' + token)
        .send({
          _id: insertResult.insertedId.toString(),
          name: 'api-security-subject-update',
          roles: ['admin'],
          notes: 'updated',
          created_at: '2024-10-26T21:32:49.173Z'
        })
        .expect(200);

      const docs = await subjectsCollection().find({ name: 'api-security-subject-update' }).toArray();
      docs.length.should.equal(1);
      docs[0].roles.should.deepEqual(['admin']);
      docs[0].notes.should.equal('updated');
    });

    it('PUT /api/v2/authorization/roles updates an existing role by _id', async function () {
      const insertResult = await rolesCollection().insertOne({
        name: 'api-security-role-update',
        permissions: ['api:entries:read'],
        notes: 'original',
        created_at: '2024-10-26T20:32:49.173Z'
      });
      const token = await getBearerToken(self.token.adminAll);

      await request(self.app)
        .put('/api/v2/authorization/roles')
        .set('Authorization', 'Bearer ' + token)
        .send({
          _id: insertResult.insertedId.toString(),
          name: 'api-security-role-update',
          permissions: ['api:entries:update'],
          notes: 'updated',
          created_at: '2024-10-26T21:32:49.173Z'
        })
        .expect(200);

      const docs = await rolesCollection().find({ name: 'api-security-role-update' }).toArray();
      docs.length.should.equal(1);
      docs[0].permissions.should.deepEqual(['api:entries:update']);
      docs[0].notes.should.equal('updated');
    });

    it('PUT /api/v2/authorization/subjects fails when _id is missing', async function () {
      const token = await getBearerToken(self.token.adminAll);

      await request(self.app)
        .put('/api/v2/authorization/subjects')
        .set('Authorization', 'Bearer ' + token)
        .send({
          name: 'api-security-subject-missing-id',
          roles: ['readable'],
          notes: 'should fail'
        })
        .expect(500);

      const docs = await subjectsCollection().find({ name: 'api-security-subject-missing-id' }).toArray();
      docs.length.should.equal(0);
    });

    it('PUT /api/v2/authorization/subjects fails when _id is invalid', async function () {
      const token = await getBearerToken(self.token.adminAll);

      await request(self.app)
        .put('/api/v2/authorization/subjects')
        .set('Authorization', 'Bearer ' + token)
        .send({
          _id: 'not-a-valid-objectid',
          name: 'api-security-subject-invalid-id',
          roles: ['readable'],
          notes: 'should fail'
        })
        .expect(500);

      const docs = await subjectsCollection().find({ name: 'api-security-subject-invalid-id' }).toArray();
      docs.length.should.equal(0);
    });

    it('PUT /api/v2/authorization/roles fails when _id is missing', async function () {
      const token = await getBearerToken(self.token.adminAll);

      await request(self.app)
        .put('/api/v2/authorization/roles')
        .set('Authorization', 'Bearer ' + token)
        .send({
          name: 'api-security-role-missing-id',
          permissions: ['api:entries:read'],
          notes: 'should fail'
        })
        .expect(500);

      const docs = await rolesCollection().find({ name: 'api-security-role-missing-id' }).toArray();
      docs.length.should.equal(0);
    });

    it('PUT /api/v2/authorization/roles fails when _id is invalid', async function () {
      const token = await getBearerToken(self.token.adminAll);

      await request(self.app)
        .put('/api/v2/authorization/roles')
        .set('Authorization', 'Bearer ' + token)
        .send({
          _id: 'not-a-valid-objectid',
          name: 'api-security-role-invalid-id',
          permissions: ['api:entries:read'],
          notes: 'should fail'
        })
        .expect(500);

      const docs = await rolesCollection().find({ name: 'api-security-role-invalid-id' }).toArray();
      docs.length.should.equal(0);
    });
  });

});
