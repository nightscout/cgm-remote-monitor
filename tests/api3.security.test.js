/* eslint require-atomic-updates: 0 */
'use strict';

const request = require('supertest')
  , apiConst = require('../lib/api3/const.json')
  , semver = require('semver')
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


//  it('should require HTTPS', async () => {
//    if (semver.gte(process.version, '10.0.0')) {
//      let res = await request(self.http.baseUrl)  // hangs on 8.x.x (no reason why)
//        .get('/api/v3/test')
//        .expect(403);
//
//      res.body.status.should.equal(403);
//      res.body.message.should.equal(apiConst.MSG.HTTP_403_NOT_USING_HTTPS);
//    }
//  });


  it('should require Date header', async () => {
    let res = await request(self.https.baseUrl)
      .get('/api/v3/test')
      .expect(401);

    res.body.status.should.equal(401);
    res.body.message.should.equal(apiConst.MSG.HTTP_401_MISSING_DATE);
  });


  it('should validate Date header syntax', async () => {
    let res = await request(self.https.baseUrl)
      .get('/api/v3/test')
      .set('Date', 'invalid date header')
      .expect(401);

    res.body.status.should.equal(401);
    res.body.message.should.equal(apiConst.MSG.HTTP_401_BAD_DATE);
  });


  it('should reject Date header out of tolerance', async () => {
    const oldDate = new Date((new Date() * 1) - 2 * 3600 * 1000)
      , futureDate = new Date((new Date() * 1) + 2 * 3600 * 1000);

    let res = await request(self.https.baseUrl)
      .get('/api/v3/test')
      .set('Date', oldDate.toUTCString())
      .expect(401);

    res.body.status.should.equal(401);
    res.body.message.should.equal(apiConst.MSG.HTTP_401_DATE_OUT_OF_TOLERANCE);

    res = await request(self.https.baseUrl)
      .get('/api/v3/test')
      .set('Date',futureDate.toUTCString())
      .expect(401);

    res.body.status.should.equal(401);
    res.body.message.should.equal(apiConst.MSG.HTTP_401_DATE_OUT_OF_TOLERANCE);
  });


  it('should reject invalid now ABC', async () => {
    let res = await request(self.https.baseUrl)
      .get(`/api/v3/test?now=ABC`)
      .expect(401);

    res.body.status.should.equal(401);
    res.body.message.should.equal('Bad Date header');
  });


  it('should reject invalid now -1', async () => {
    let res = await request(self.https.baseUrl)
      .get(`/api/v3/test?now=-1`)
      .expect(401);

    res.body.status.should.equal(401);
    res.body.message.should.equal('Bad Date header');
  });


  it('should reject invalid now - illegal format', async () => {
    let res = await request(self.https.baseUrl)
      .get(`/api/v3/test?now=2019-20-60T50:90:90`)
      .expect(401);

    res.body.status.should.equal(401);
    res.body.message.should.equal('Bad Date header');
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
