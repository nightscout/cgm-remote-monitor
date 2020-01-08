/* eslint require-atomic-updates: 0 */
/* global should */
'use strict';

require('should');

describe('API3 READ', function() {
  const self = this
    , testConst = require('./fixtures/api3/const.json')
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , opTools = require('../lib/api3/shared/operationTools')
    ;

  self.validDoc = {
    date: (new Date()).getTime(),
    app: testConst.TEST_APP,
    device: testConst.TEST_DEVICE,
    uploaderBattery: 58
  };
  self.validDoc.identifier = opTools.calculateIdentifier(self.validDoc);

  self.timeout(15000);


  before(async () => {
    self.instance = await instance.create({});

    self.app = self.instance.app;
    self.env = self.instance.env;
    self.url = '/api/v3/devicestatus';

    let authResult = await authSubject(self.instance.ctx.authorization.storage);

    self.subject = authResult.subject;
    self.token = authResult.token;
  });


  after(() => {
    self.instance.ctx.bus.teardown();
  });


  it('should require authentication', async () => {
    let res = await self.instance.get(`${self.url}/FAKE_IDENTIFIER`)
      .expect(401);

    res.body.status.should.equal(401);
    res.body.message.should.equal('Missing or bad access token or JWT');
  });


  it('should not found not existing collection', async () => {
    let res = await self.instance.get(`/api/v3/NOT_EXIST/NOT_EXIST?token=${self.url}`)
      .send(self.validDoc)
      .expect(404);

    res.body.should.be.empty();
  });


  it('should not found not existing document', async () => {
    await self.instance.get(`${self.url}/${self.validDoc.identifier}?token=${self.token.read}`)
      .expect(404);
  });


  it('should read just created document', async () => {
    let res = await self.instance.post(`${self.url}?token=${self.token.create}`)
      .send(self.validDoc)
      .expect(201);

    res.body.should.be.empty();

    res = await self.instance.get(`${self.url}/${self.validDoc.identifier}?token=${self.token.read}`)
      .expect(200);

    res.body.should.containEql(self.validDoc);
    res.body.should.have.property('srvCreated').which.is.a.Number();
    res.body.should.have.property('srvModified').which.is.a.Number();
    res.body.should.have.property('subject');
    self.validDoc.subject = res.body.subject; // let's store subject for later tests
  });


  it('should contain only selected fields', async () => {
    let res = await self.instance.get(`${self.url}/${self.validDoc.identifier}?fields=date,device,subject&token=${self.token.read}`)
      .expect(200);

    const correct = {
      date: self.validDoc.date,
      device: self.validDoc.device,
      subject: self.validDoc.subject
    };
    res.body.should.eql(correct);
  });


  it('should contain all fields', async () => {
    let res = await self.instance.get(`${self.url}/${self.validDoc.identifier}?fields=_all&token=${self.token.read}`)
      .expect(200);

    for (let fieldName of ['app', 'date', 'device', 'identifier', 'srvModified', 'uploaderBattery', 'subject']) {
      res.body.should.have.property(fieldName);
    }
  });


  it('should not send unmodified document since', async () => {
    let res = await self.instance.get(`${self.url}/${self.validDoc.identifier}?token=${self.token.read}`)
      .set('If-Modified-Since', new Date(new Date().getTime() + 1000).toUTCString())
      .expect(304);

    res.body.should.be.empty();
  });


  it('should send modified document since', async () => {
    let res = await self.instance.get(`${self.url}/${self.validDoc.identifier}?token=${self.token.read}`)
      .set('If-Modified-Since', new Date(new Date(self.validDoc.date).getTime() - 1000).toUTCString())
      .expect(200);

    res.body.should.containEql(self.validDoc);
  });


  it('should recognize softly deleted document', async () => {
    let res = await self.instance.delete(`${self.url}/${self.validDoc.identifier}?token=${self.token.delete}`)
      .expect(204);

    res.body.should.be.empty();

    res = await self.instance.get(`${self.url}/${self.validDoc.identifier}?token=${self.token.read}`)
      .expect(410);

    res.body.should.be.empty();
  });


  it('should not found permanently deleted document', async () => {
    let res = await self.instance.delete(`${self.url}/${self.validDoc.identifier}?permanent=true&token=${self.token.delete}`)
      .expect(204);

    res.body.should.be.empty();

    res = await self.instance.get(`${self.url}/${self.validDoc.identifier}?token=${self.token.read}`)
      .expect(404);

    res.body.should.be.empty();
  });


  it('should found document created by APIv1', async () => {

    const doc = Object.assign({}, self.validDoc, { 
      created_at: new Date(self.validDoc.date).toISOString() 
    });
    delete doc.identifier;

    self.instance.ctx.devicestatus.create([doc], async (err) => {  // let's insert the document in APIv1's way
      should.not.exist(err);
      const identifier = doc._id.toString();
      delete doc._id;

      let res = await self.instance.get(`${self.url}/${identifier}?token=${self.token.read}`)
          .expect(200);

      res.body.should.containEql(doc);

      res = await self.instance.delete(`${self.url}/${identifier}?permanent=true&token=${self.token.delete}`)
        .expect(204);

      res.body.should.be.empty();
    });
  });


});

