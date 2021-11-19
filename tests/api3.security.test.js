/* eslint require-atomic-updates: 0 */
'use strict';

const request = require('supertest')
  , apiConst = require('../lib/api3/const.json')
  , moment = require('moment')
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

    let authResult = await authSubject(self.https.ctx.authorization.storage);
    self.subject = authResult.subject;
    self.token = authResult.token;
  });


  after(() => {
    self.http.ctx.bus.teardown();
    self.https.ctx.bus.teardown();
  });


  it('should require token', async () => {
    let res = await request(self.https.baseUrl)
      .get('/api/v3/test')
      .set('Date', new Date().toUTCString())
      .expect(401);

    res.body.status.should.equal(401);
    res.body.message.should.equal(apiConst.MSG.HTTP_401_MISSING_OR_BAD_TOKEN);
  });


  it('should require valid token', async () => {
    let res = await request(self.https.baseUrl)
      .get('/api/v3/test?token=invalid_token')
      .set('Date', new Date().toUTCString())
      .expect(401);

    res.body.status.should.equal(401);
    res.body.message.should.equal(apiConst.MSG.HTTP_401_MISSING_OR_BAD_TOKEN);
  });


  it('should deny subject denied', async () => {
    let res = await request(self.https.baseUrl)
      .get('/api/v3/test?token=' + self.subject.denied.accessToken)
      .set('Date', new Date().toUTCString())
      .expect(403);

    res.body.status.should.equal(403);
    res.body.message.should.equal(apiConst.MSG.HTTP_403_MISSING_PERMISSION.replace('{0}', 'api:entries:read'));
  });


  it('should allow subject with read permission', async () => {
    await request(self.https.baseUrl)
      .get('/api/v3/test?token=' + self.token.read)
      .set('Date', new Date().toUTCString())
      .expect(200);
  });


  it('should accept valid now - epoch in ms', async () => {
    await request(self.https.baseUrl)
      .get(`/api/v3/test?token=${self.token.read}&now=${moment().valueOf()}`)
      .expect(200);
  });


  it('should accept valid now - epoch in seconds', async () => {
    await request(self.https.baseUrl)
      .get(`/api/v3/test?token=${self.token.read}&now=${moment().unix()}`)
      .expect(200);
  });


  it('should accept valid now - ISO 8601', async () => {
    await request(self.https.baseUrl)
      .get(`/api/v3/test?token=${self.token.read}&now=${moment().toISOString()}`)
      .expect(200);
  });


  it('should accept valid now - RFC 2822', async () => {
    await request(self.https.baseUrl)
      .get(`/api/v3/test?token=${self.token.read}&now=${moment().utc().format('ddd, DD MMM YYYY HH:mm:ss [GMT]')}`)
      .expect(200);
  });

});
