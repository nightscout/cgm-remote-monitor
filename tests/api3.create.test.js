/* eslint require-atomic-updates: 0 */
/* global should */
'use strict';

require('should');

describe('API3 CREATE', function() {
  const self = this
    , testConst = require('./fixtures/api3/const.json')
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , opTools = require('../lib/api3/shared/operationTools')
    , utils = require('./fixtures/api3/utils')
    ;

  self.validDoc = {
    date: (new Date()).getTime(),
    app: testConst.TEST_APP,
    device: testConst.TEST_DEVICE + ' API3 CREATE',
    eventType: 'Correction Bolus',
    insulin: 0.3
  };
  self.validDoc.identifier = opTools.calculateIdentifier(self.validDoc);

  self.timeout(20000);


  /**
   * Cleanup after successful creation
   */
  self.delete = async function deletePermanent (identifier) {
    let res = await self.instance.delete(`${self.url}/${identifier}?permanent=true&token=${self.token.delete}`)
      .expect(200);

    res.body.status.should.equal(200);
  };


  /**
   * Get document detail for futher processing
   */
  self.get = async function get (identifier) {
    let res = await self.instance.get(`${self.url}/${identifier}?token=${self.token.read}`)
      .expect(200);

    res.body.status.should.equal(200);
    return res.body.result;
  };


  /**
   * Get document detail for futher processing
   */
  self.search = async function search (date) {
    let res = await self.instance.get(`${self.url}?date$eq=${date}&token=${self.token.read}`)
      .expect(200);

    res.body.status.should.equal(200);
    return res.body.result;
  };


  before(async () => {
    self.instance = await instance.create({});

    self.app = self.instance.app;
    self.env = self.instance.env;
    self.col = 'treatments'
    self.url = `/api/v3/${self.col}`;

    let authResult = await authSubject(self.instance.ctx.authorization.storage);

    self.subject = authResult.subject;
    self.token = authResult.token;
    self.urlToken = `${self.url}?token=${self.token.create}`;
    self.cache = self.instance.cacheMonitor;
  });


  after(() => {
    self.instance.ctx.bus.teardown();
  });


  beforeEach(() => {
    self.cache.clear();
  });


  afterEach(() => {
    self.cache.shouldBeEmpty();
  });


  it('should require authentication', async () => {
    let res = await self.instance.post(`${self.url}`)
      .send(self.validDoc)
      .expect(401);

    res.body.status.should.equal(401);
    res.body.message.should.equal('Missing or bad access token or JWT');
  });


  it('should not found not existing collection', async () => {
    let res = await self.instance.post(`/api/v3/NOT_EXIST?token=${self.url}`)
      .send(self.validDoc)
      .expect(404);

    res.body.status.should.equal(404);
    should.not.exist(res.body.result);
  });


  it('should require create permission', async () => {
    let res = await self.instance.post(`${self.url}?token=${self.token.read}`)
      .send(self.validDoc)
      .expect(403);

    res.body.status.should.equal(403);
    res.body.message.should.equal('Missing permission api:treatments:create');
  });


  it('should reject empty body', async () => {
    let res = await self.instance.post(self.urlToken)
      .send({ })
      .expect(400);

    res.body.status.should.equal(400);
  });


  it('should accept valid document', async () => {
    let res = await self.instance.post(self.urlToken)
      .send(self.validDoc)
      .expect(201);

    res.body.status.should.equal(201);
    res.body.identifier.should.equal(self.validDoc.identifier);
    res.headers.location.should.equal(`${self.url}/${self.validDoc.identifier}`);
    const lastModifiedBody = res.body.lastModified;
    const lastModified = new Date(res.headers['last-modified']).getTime(); // Last-Modified has trimmed milliseconds

    let body = await self.get(self.validDoc.identifier);
    body.should.containEql(self.validDoc);
    body.srvModified.should.equal(lastModifiedBody);
    self.cache.nextShouldEql(self.col, self.validDoc)

    const ms = body.srvModified % 1000;
    (body.srvModified - ms).should.equal(lastModified);
    (body.srvCreated - ms).should.equal(lastModified);
    body.subject.should.equal(self.subject.apiCreate.name);

    await self.delete(self.validDoc.identifier);
    self.cache.nextShouldDeleteLast(self.col)
  });


  it('should reject missing date', async () => {
    let doc = Object.assign({}, self.validDoc);
    delete doc.date;

    let res = await self.instance.post(self.urlToken)
      .send(doc)
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Bad or missing date field');
  });


  it('should reject invalid date null', async () => {
    let res = await self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { date: null }))
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Bad or missing date field');
  });


  it('should reject invalid date ABC', async () => {
    let res = await self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { date: 'ABC' }))
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Bad or missing date field');
  });


  it('should reject invalid date -1', async () => {
    let res = await self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { date: -1 }))
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Bad or missing date field');
  });



  it('should reject invalid date 1 (too old)', async () => {
    let res = await self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { date: 1 }))
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Bad or missing date field');
  });


  it('should reject invalid date - illegal format', async () => {
    let res = await self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { date: '2019-20-60T50:90:90' }))
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Bad or missing date field');
  });


  it('should reject invalid utcOffset -5000', async () => {
    let res = await self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { utcOffset: -5000 }))
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Bad or missing utcOffset field');
  });


  it('should reject invalid utcOffset ABC', async () => {
    let res = await self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { utcOffset: 'ABC' }))
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Bad or missing utcOffset field');
  });


  it('should accept valid utcOffset', async () => {
    const doc = Object.assign({}, self.validDoc, { utcOffset: 120 });

    await self.instance.post(self.urlToken)
      .send(doc)
      .expect(201);

    let body = await self.get(self.validDoc.identifier);
    body.utcOffset.should.equal(120);
    self.cache.nextShouldEql(self.col, doc)

    await self.delete(self.validDoc.identifier);
    self.cache.nextShouldDeleteLast(self.col)
  });


  it('should reject invalid utcOffset null', async () => {
    let res = await self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { utcOffset: null }))
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Bad or missing utcOffset field');
  });


  it('should reject missing app', async () => {
    let doc = Object.assign({}, self.validDoc);
    delete doc.app;

    let res = await self.instance.post(self.urlToken)
      .send(doc)
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Bad or missing app field');
  });


  it('should reject invalid app null', async () => {
    let res = await self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { app: null }))
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Bad or missing app field');
  });


  it('should reject empty app', async () => {
    let res = await self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { app: '' }))
      .expect(400);

    res.body.status.should.equal(400);
    res.body.message.should.equal('Bad or missing app field');
  });


  it('should normalize date and store utcOffset', async () => {
    await self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { date: '2019-06-10T08:07:08,576+02:00' }))
      .expect(201);

    let body = await self.get(self.validDoc.identifier);
    body.date.should.equal(1560146828576);
    body.utcOffset.should.equal(120);
    self.cache.nextShouldEql(self.col, body)

    await self.delete(self.validDoc.identifier);
    self.cache.nextShouldDeleteLast(self.col)
  });


  it('should require update permission for deduplication', async () => {
    self.validDoc.date = (new Date()).getTime();
    self.validDoc.identifier = utils.randomString('32', 'aA#');

    const doc = Object.assign({}, self.validDoc);

    await self.instance.post(self.urlToken)
      .send(doc)
      .expect(201);

    let createdBody = await self.get(doc.identifier);
    createdBody.should.containEql(doc);
    self.cache.nextShouldEql(self.col, doc)

    const doc2 = Object.assign({}, doc);
    let res = await self.instance.post(self.urlToken)
      .send(doc2)
      .expect(403);

    res.body.status.should.equal(403);
    res.body.message.should.equal('Missing permission api:treatments:update');
    await self.delete(doc.identifier);
    self.cache.nextShouldDeleteLast(self.col)
  });


  it('should upsert document (matched by identifier)', async () => {
    self.validDoc.date = (new Date()).getTime();
    self.validDoc.identifier = utils.randomString('32', 'aA#');

    const doc = Object.assign({}, self.validDoc);

    await self.instance.post(self.urlToken)
      .send(doc)
      .expect(201);

    let createdBody = await self.get(doc.identifier);
    createdBody.should.containEql(doc);
    self.cache.nextShouldEql(self.col, doc)

    const doc2 = Object.assign({}, doc, {
      insulin: 0.5
    });

    let resPost2 = await self.instance.post(`${self.url}?token=${self.token.all}`)
      .send(doc2)
      .expect(200);

    resPost2.body.status.should.equal(200);

    let updatedBody = await self.get(doc2.identifier);
    updatedBody.should.containEql(doc2);
    self.cache.nextShouldEql(self.col, doc2)

    await self.delete(doc2.identifier);
    self.cache.nextShouldDeleteLast(self.col)
  });


  it('should deduplicate document by created_at+eventType', async () => {
    self.validDoc.date = (new Date()).getTime();
    self.validDoc.identifier = utils.randomString('32', 'aA#');

    const doc = Object.assign({}, self.validDoc, {
      created_at: new Date(self.validDoc.date).toISOString()
    });
    delete doc.identifier;

    await new Promise((resolve, reject) => {
      self.instance.ctx.treatments.create([doc], async (err) => {  // let's insert the document in APIv1's way
        should.not.exist(err);
        doc._id = doc._id.toString();
        self.cache.nextShouldEql(self.col, doc)

        err ? reject(err) : resolve(doc);
      });
    });

    const doc2 = Object.assign({}, doc, {
      insulin: 0.4,
      identifier: utils.randomString('32', 'aA#')
    });
    delete doc2._id; // APIv1 updates input document, we must get rid of _id for the next round

    const resPost2 = await self.instance.post(`${self.url}?token=${self.token.all}`)
      .send(doc2)
      .expect(200);

    resPost2.body.status.should.equal(200);
    resPost2.body.identifier.should.equal(doc2.identifier);
    resPost2.body.isDeduplication.should.equal(true);
    // doc (first document) was created "the old way" without identifier, so _id becomes the identifier for doc
    resPost2.body.deduplicatedIdentifier.should.equal(doc._id);

    let updatedBody = await self.get(doc2.identifier);
    updatedBody.should.containEql(doc2);
    self.cache.nextShouldEql(self.col, doc2)

    await self.delete(doc2.identifier);
    self.cache.nextShouldDeleteLast(self.col)
  });


  it('should not deduplicate treatment only by created_at', async () => {
    self.validDoc.date = (new Date()).getTime();
    self.validDoc.identifier = utils.randomString('32', 'aA#');

    const doc = Object.assign({}, self.validDoc, {
      created_at: new Date(self.validDoc.date).toISOString()
    });
    delete doc.identifier;

    await new Promise((resolve, reject) => {
      self.instance.ctx.treatments.create([doc], async (err) => {  // let's insert the document in APIv1's way
        should.not.exist(err);
        doc._id = doc._id.toString();

        self.cache.nextShouldEql(self.col, doc)
        err ? reject(err) : resolve(doc);
      });
    });

    const oldBody = await self.get(doc._id);
    delete doc._id; // APIv1 updates input document, we must get rid of _id for the next round
    oldBody.should.containEql(doc);

    const doc2 = Object.assign({}, doc, {
      eventType: 'Meal Bolus',
      insulin: 0.4,
      identifier: utils.randomString('32', 'aA#')
    });

    await self.instance.post(`${self.url}?token=${self.token.all}`)
      .send(doc2)
      .expect(201);

    let updatedBody = await self.get(doc2.identifier);
    updatedBody.should.containEql(doc2);
    updatedBody.identifier.should.not.equal(oldBody.identifier);
    should.not.exist(updatedBody.isDeduplication);
    should.not.exist(updatedBody.deduplicatedIdentifier);
    self.cache.nextShouldEql(self.col, doc2)

    await self.delete(doc2.identifier);
    self.cache.nextShouldDeleteLast(self.col)

    await self.delete(oldBody.identifier);
    self.cache.nextShouldDeleteLast(self.col)
  });


  it('should overwrite deleted document', async () => {
    const date1 = new Date()
      , identifier = utils.randomString('32', 'aA#')
      , doc = Object.assign({}, self.validDoc, { identifier, date: date1.toISOString() });

    await self.instance.post(self.urlToken)
      .send(doc)
      .expect(201);
    self.cache.nextShouldEql(self.col, Object.assign({}, doc, { date: date1.getTime() }));

    let res = await self.instance.delete(`${self.url}/${identifier}?token=${self.token.delete}`)
      .expect(200);
    res.body.status.should.equal(200);
    self.cache.nextShouldDeleteLast(self.col)

    const date2 = new Date();
    res = await self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { identifier, date: date2.toISOString() }))
      .expect(403);

    res.body.status.should.equal(403);
    res.body.message.should.equal('Missing permission api:treatments:update');
    self.cache.shouldBeEmpty()

    const doc2 = Object.assign({}, self.validDoc, { identifier, date: date2.toISOString() });
    res = await self.instance.post(`${self.url}?token=${self.token.all}`)
      .send(doc2)
      .expect(200);

    res.body.status.should.equal(200);
    res.body.identifier.should.equal(identifier);
    self.cache.nextShouldEql(self.col, Object.assign({}, doc2, { date: date2.getTime() }));

    let body = await self.get(identifier);
    body.date.should.equal(date2.getTime());
    body.identifier.should.equal(identifier);

    await self.delete(identifier);
    self.cache.nextShouldDeleteLast(self.col)
  });


  it('should calculate the identifier', async () => {
    self.validDoc.date = (new Date()).getTime();
    delete self.validDoc.identifier;
    const validIdentifier = opTools.calculateIdentifier(self.validDoc);

    let res = await self.instance.post(self.urlToken)
      .send(self.validDoc)
      .expect(201);

    res.body.status.should.equal(201);
    res.body.identifier.should.equal(validIdentifier);
    res.headers.location.should.equal(`${self.url}/${validIdentifier}`);
    self.validDoc.identifier = validIdentifier;

    let body = await self.get(validIdentifier);
    body.should.containEql(self.validDoc);
    self.cache.nextShouldEql(self.col, self.validDoc);

    await self.delete(validIdentifier);
    self.cache.nextShouldDeleteLast(self.col)
  });


  it('should deduplicate by identifier calculation', async () => {
    self.validDoc.date = (new Date()).getTime();
    delete self.validDoc.identifier;
    const validIdentifier = opTools.calculateIdentifier(self.validDoc);

    let res = await self.instance.post(self.urlToken)
      .send(self.validDoc)
      .expect(201);

    res.body.status.should.equal(201);
    res.body.identifier.should.equal(validIdentifier);
    res.headers.location.should.equal(`${self.url}/${validIdentifier}`);
    self.validDoc.identifier = validIdentifier;

    let body = await self.get(validIdentifier);
    body.should.containEql(self.validDoc);
    self.cache.nextShouldEql(self.col, self.validDoc);

    delete self.validDoc.identifier;
    res = await self.instance.post(`${self.url}?token=${self.token.update}`)
      .send(self.validDoc)
      .expect(200);

    res.body.status.should.equal(200);
    res.body.identifier.should.equal(validIdentifier);
    res.body.isDeduplication.should.equal(true);
    should.not.exist(res.body.deduplicatedIdentifier); // no identifier change occured
    res.headers.location.should.equal(`${self.url}/${validIdentifier}`);
    self.validDoc.identifier = validIdentifier;
    self.cache.nextShouldEql(self.col, self.validDoc);

    body = await self.search(self.validDoc.date);
    body.length.should.equal(1);

    await self.delete(validIdentifier);
    self.cache.nextShouldDeleteLast(self.col)
  });

});

