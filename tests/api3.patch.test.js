/* eslint require-atomic-updates: 0 */
'use strict';

require('should');

describe('API3 PATCH', function() {
  const self = this
    , testConst = require('./fixtures/api3/const.json')
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , opTools = require('../lib/api3/shared/operationTools')
    ;

  self.validDoc = {
    date: (new Date()).getTime(),
    utcOffset: -180,
    app: testConst.TEST_APP,
    device: testConst.TEST_DEVICE + ' API3 PATCH',
    eventType: 'Correction Bolus',
    insulin: 0.3
  };
  self.validDoc.identifier = opTools.calculateIdentifier(self.validDoc);
  
  self.timeout(15000);


  /**
   * Get document detail for futher processing
   */
  self.get = async function get (identifier) {
    let res = await self.instance.get(`${self.url}/${identifier}?token=${self.token.read}`)
      .expect(200);

    return res.body;
  };


  before(async () => {
    self.instance = await instance.create({});

    self.app = self.instance.app;
    self.env = self.instance.env;
    self.url = '/api/v3/treatments';

    let authResult = await authSubject(self.instance.ctx.authorization.storage);

    self.subject = authResult.subject;
    self.token = authResult.token;
    self.urlToken = `${self.url}/${self.validDoc.identifier}?token=${self.token.update}`;
  });


  after(() => {
    self.instance.ctx.bus.teardown();
  });


  it('should require authentication', async () => {
    let res = await self.instance.patch(`${self.url}/FAKE_IDENTIFIER`)
      .expect(401);

    res.body.status.should.equal(401);
    res.body.message.should.equal('Missing or bad access token or JWT');
  });


  it('should not found not existing collection', async () => {
    let res = await self.instance.patch(`/api/v3/NOT_EXIST?token=${self.url}`)
      .send(self.validDoc)
      .expect(404);

    res.body.should.be.empty();
  });


  it('should not found not existing document', async () => {
    let res = await self.instance.patch(self.urlToken)
      .send(self.validDoc)
      .expect(404);

    res.body.should.be.empty();

    // now let's insert the document for further patching
    res = await self.instance.post(`${self.url}?token=${self.token.create}`)
      .send(self.validDoc)
      .expect(201);

    res.body.should.be.empty();
  });


  it('should reject identifier alteration', async () => {
    let res = await self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { identifier: 'MODIFIED'}))
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Field identifier cannot be modified by the client');
  });


  it('should reject date alteration', async () => {
    let res = await self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { date: self.validDoc.date + 10000 }))
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Field date cannot be modified by the client');
  });


  it('should reject utcOffset alteration', async () => {
    let res = await self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { utcOffset: self.utcOffset - 120 }))
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Field utcOffset cannot be modified by the client');
  });


  it('should reject eventType alteration', async () => {
    let res = await self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { eventType: 'MODIFIED' }))
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Field eventType cannot be modified by the client');
  });


  it('should reject device alteration', async () => {
    let res = await self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { device: 'MODIFIED' }))
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Field device cannot be modified by the client');
  });


  it('should reject app alteration', async () => {
    let res = await self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { app: 'MODIFIED' }))
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Field app cannot be modified by the client');
  });


  it('should reject srvCreated alteration', async () => {
    let res = await self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { srvCreated: self.validDoc.date - 10000 }))
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Field srvCreated cannot be modified by the client');
  });


  it('should reject subject alteration', async () => {
    let res = await self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { subject: 'MODIFIED' }))
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Field subject cannot be modified by the client');
  });


  it('should reject srvModified alteration', async () => {
    let res = await self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { srvModified: self.validDoc.date - 100000 }))
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Field srvModified cannot be modified by the client');
  });


  it('should reject modifiedBy alteration', async () => {
    let res = await self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { modifiedBy: 'MODIFIED' }))
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Field modifiedBy cannot be modified by the client');
  });


  it('should reject isValid alteration', async () => {
    let res = await self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { isValid: false }))
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Field isValid cannot be modified by the client');
  });


  it('should patch document', async () => {
    self.validDoc.carbs = 10;

    let res = await self.instance.patch(self.urlToken)
      .send(self.validDoc)
      .expect(204);

    res.body.should.be.empty();

    let body = await self.get(self.validDoc.identifier);
    body.carbs.should.equal(10);
    body.insulin.should.equal(0.3);
    body.subject.should.equal(self.subject.apiCreate.name);
    body.modifiedBy.should.equal(self.subject.apiUpdate.name);
  });

});

