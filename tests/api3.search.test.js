/* eslint require-atomic-updates: 0 */
/* global should */
'use strict';

require('should');

describe('API3 SEARCH', function() {
  const self = this
    , testConst = require('./fixtures/api3/const.json')
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , opTools = require('../lib/api3/shared/operationTools')
    ;

  self.docs = testConst.SAMPLE_ENTRIES;

  self.timeout(15000);


  /**
   * Get document detail for futher processing
   */
  self.get = function get (identifier, done) {
    self.instance.get(`${self.url}/${identifier}?token=${self.token.read}`)
      .expect(200)
      .end((err, res) => {
        should.not.exist(err);
        done(res.body);
      });
  };


  /**
   * Create given document in a promise
   */
  self.create = (doc) => new Promise((resolve) => {
    doc.identifier = opTools.calculateIdentifier(doc);
    self.instance.post(`${self.url}?token=${self.token.all}`)
      .send(doc)
      .end((err) => {
        should.not.exist(err);
        self.get(doc.identifier, resolve);
      });
  });


  before(async () => {
    self.testStarted = new Date();
    self.instance = await instance.create({});

    self.app = self.instance.app;
    self.env = self.instance.env;
    self.url = '/api/v3/entries';

    let authResult = await authSubject(self.instance.ctx.authorization.storage);

    self.subject = authResult.subject;
    self.token = authResult.token;
    self.urlToken = `${self.url}?token=${self.token.read}`;
    self.urlTest = `${self.urlToken}&srvModified$gte=${self.testStarted.getTime()}`;

    const promises = testConst.SAMPLE_ENTRIES.map(doc => self.create(doc));
    self.docs = await Promise.all(promises);
  });


  after(() => {
    self.instance.server.close();
  });


  it('should require authentication', async () => {
    let res = await self.instance.get(self.url)
      .expect(401);

    res.body.status.should.equal(401);
    res.body.message.should.equal('Missing or bad access token or JWT');
  });


  it('should not found not existing collection', async () => {
    let res = await self.instance.get(`/api/v3/NOT_EXIST?token=${self.url}`)
      .send(self.validDoc)
      .expect(404);

    res.body.should.be.empty();
  });


  it('should found at least 10 documents', async () => {
    let res = await self.instance.get(self.urlToken)
      .expect(200);

    res.body.length.should.be.aboveOrEqual(self.docs.length);
  });


  it('should found at least 10 documents from test start', async () => {
    let res = await self.instance.get(self.urlTest)
      .expect(200);

    res.body.length.should.be.aboveOrEqual(self.docs.length);
  });


  it('should reject invalid limit - not a number', async () => {
    let res = await self.instance.get(`${self.urlToken}&limit=INVALID`)
      .expect(400);

    res.body.status.should.be.equal(400);
    res.body.message.should.be.equal('Parameter limit out of tolerance');
  });


  it('should reject invalid limit - negative number', async () => {
    let res = await self.instance.get(`${self.urlToken}&limit=-1`)
      .expect(400);

    res.body.status.should.be.equal(400);
    res.body.message.should.be.equal('Parameter limit out of tolerance');
  });


  it('should reject invalid limit - zero', async () => {
    let res = await self.instance.get(`${self.urlToken}&limit=0`)
      .expect(400);

    res.body.status.should.be.equal(400);
    res.body.message.should.be.equal('Parameter limit out of tolerance');
  });


  it('should accept valid limit', async () => {
    let res = await self.instance.get(`${self.urlToken}&limit=3`)
      .expect(200);

    res.body.length.should.be.equal(3);
  });


  it('should reject invalid skip - not a number', async () => {
    let res = await self.instance.get(`${self.urlToken}&skip=INVALID`)
      .expect(400);

    res.body.status.should.be.equal(400);
    res.body.message.should.be.equal('Parameter skip out of tolerance');
  });


  it('should reject invalid skip - negative number', async () => {
    let res = await self.instance.get(`${self.urlToken}&skip=-5`)
      .expect(400);

    res.body.status.should.be.equal(400);
    res.body.message.should.be.equal('Parameter skip out of tolerance');
  });


  it('should reject both sort and sort$desc', async () => {
    let res = await self.instance.get(`${self.urlToken}&sort=date&sort$desc=created_at`)
      .expect(400);

    res.body.status.should.be.equal(400);
    res.body.message.should.be.equal('Parameters sort and sort_desc cannot be combined');
  });


  it('should sort well by date field', async () => {
    let res = await self.instance.get(`${self.urlTest}&sort=date`)
      .expect(200);

    const ascending = res.body;
    const length = ascending.length;
    length.should.be.aboveOrEqual(self.docs.length);

    res = await self.instance.get(`${self.urlTest}&sort$desc=date`)
      .expect(200);

    const descending = res.body;
    descending.length.should.equal(length);

    for (let i in ascending) {
      ascending[i].should.eql(descending[length - i - 1]);

      if (i > 0) {
        ascending[i - 1].date.should.be.lessThanOrEqual(ascending[i].date);
      }
    }
  });


  it('should skip documents', async () => {
    let res = await self.instance.get(`${self.urlToken}&sort=date&limit=8`)
      .expect(200);

    const fullDocs = res.body;
    fullDocs.length.should.be.equal(8);

    res = await self.instance.get(`${self.urlToken}&sort=date&skip=3&limit=5`)
      .expect(200);

    const skipDocs = res.body;
    skipDocs.length.should.be.equal(5);

    for (let i = 0; i < 3; i++) {
      skipDocs[i].should.be.eql(fullDocs[i + 3]);
    }
  });


  it('should project selected fields', async () => {
    let res = await self.instance.get(`${self.urlToken}&fields=date,app,subject`)
      .expect(200);

    res.body.forEach(doc => {
      const docFields = Object.getOwnPropertyNames(doc);
      docFields.sort().should.be.eql(['app', 'date', 'subject']);
    });
  });


  it('should project all fields', async () => {
    let res = await self.instance.get(`${self.urlToken}&fields=_all`)
      .expect(200);

    res.body.forEach(doc => {
      Object.getOwnPropertyNames(doc).length.should.be.aboveOrEqual(10);
      Object.prototype.hasOwnProperty.call(doc, '_id').should.not.be.true();
      Object.prototype.hasOwnProperty.call(doc, 'identifier').should.be.true();
      Object.prototype.hasOwnProperty.call(doc, 'srvModified').should.be.true();
      Object.prototype.hasOwnProperty.call(doc, 'srvCreated').should.be.true();
    });
  });


  it('should not exceed the limit of docs count', async () => {
    const apiApp = self.instance.ctx.apiApp
      , limitBackup = apiApp.get('API3_MAX_LIMIT');
    apiApp.set('API3_MAX_LIMIT', 5);
    let res = await self.instance.get(`${self.urlToken}&limit=10`)
      .expect(400);

    res.body.status.should.be.equal(400);
    res.body.message.should.be.equal('Parameter limit out of tolerance');
    apiApp.set('API3_MAX_LIMIT', limitBackup);
  });


  it('should respect the ceiling (hard) limit of docs', async () => {
    const apiApp = self.instance.ctx.apiApp
      , limitBackup = apiApp.get('API3_MAX_LIMIT');
    apiApp.set('API3_MAX_LIMIT', 5);
    let res = await self.instance.get(`${self.urlToken}`)
      .expect(200);

    res.body.length.should.be.equal(5);
    apiApp.set('API3_MAX_LIMIT', limitBackup);
  });

});

