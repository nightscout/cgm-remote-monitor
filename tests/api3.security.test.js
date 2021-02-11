/* eslint require-atomic-updates: 0 */
'use strict';

const request = require('supertest')
  , apiConst = require('../lib/api3/const.json')
  ;
require('should');

describe('Security of REST API3', function() {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    ;

  this.timeout(30000);


  before(async () => {
    self.http = await instance.create({ useHttps: false });
    self.https = await instance.create({ });

    let authResult = await authSubject(self.https.ctx.authorization.storage, [
      'denied',
      'read',
      'delete'
    ], self.https.app);
    self.subject = authResult.subject;
    self.jwt = authResult.jwt;
  });


  after(() => {
    self.http.ctx.bus.teardown();
    self.https.ctx.bus.teardown();
  });


  it('should require token', async () => {
    let res = await request(self.https.baseUrl)
      .get('/api/v3/test')
      .expect(401);

    res.body.status.should.equal(401);
    res.body.message.should.equal(apiConst.MSG.HTTP_401_MISSING_OR_BAD_TOKEN);
  });


  it('should require valid token', async () => {
    let res = await request(self.https.baseUrl)
      .get('/api/v3/test')
      .set('Authorization', 'Bearer invalid_token')
      .expect(401);

    res.body.status.should.equal(401);
    res.body.message.should.equal(apiConst.MSG.HTTP_401_BAD_TOKEN);
  });


  it('should deny subject denied', async () => {
    let res = await request(self.https.baseUrl)
      .get('/api/v3/test')
      .set('Authorization', `Bearer ${self.jwt.denied}`)
      .expect(403);

    res.body.status.should.equal(403);
    res.body.message.should.equal(apiConst.MSG.HTTP_403_MISSING_PERMISSION.replace('{0}', 'api:entries:read'));
  });


  it('should allow subject with read permission', async () => {
    await request(self.https.baseUrl)
      .get('/api/v3/test', self.jwt.read)
      .set('Authorization', `Bearer ${self.jwt.read}`)
      .expect(200);
  });


});
