'use strict';

require('should');

describe('API3 Shape Handling - Single Object vs Array Input', function() {
  const self = this;
  const testConst = require('./fixtures/api3/const.json');
  const instance = require('./fixtures/api3/instance');
  const authSubject = require('./fixtures/api3/authSubject');
  const opTools = require('../lib/api3/shared/operationTools');

  self.timeout(20000);

  before(async () => {
    self.instance = await instance.create({});
    self.app = self.instance.app;
    self.env = self.instance.env;

    let authResult = await authSubject(self.instance.ctx.authorization.storage, [
      'create',
      'update',
      'read',
      'delete',
      'all'
    ], self.instance.app);

    self.subject = authResult.subject;
    self.jwt = authResult.jwt;
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

  describe('Treatments Collection - /api/v3/treatments', function() {
    const col = 'treatments';
    const url = `/api/v3/${col}`;

    async function deleteDoc(identifier) {
      await self.instance.delete(`${url}/${identifier}?permanent=true`, self.jwt.delete)
        .expect(200);
    }

    it('POST accepts single valid object', async () => {
      const doc = {
        date: Date.now(),
        app: testConst.TEST_APP,
        device: testConst.TEST_DEVICE + ' shape-single',
        eventType: 'Note',
        notes: 'single object test'
      };
      doc.identifier = opTools.calculateIdentifier(doc);

      let res = await self.instance.post(url, self.jwt.create)
        .send(doc)
        .expect(201);

      res.body.status.should.equal(201);
      res.body.identifier.should.equal(doc.identifier);

      await deleteDoc(doc.identifier);
      self.cache.nextShouldEql(col, doc);
      self.cache.nextShouldDeleteLast(col);
    });

    it('POST rejects array input with 400', async () => {
      const docs = [
        {
          date: Date.now(),
          app: testConst.TEST_APP,
          device: testConst.TEST_DEVICE + ' shape-array-1',
          eventType: 'Note',
          notes: 'array test 1'
        },
        {
          date: Date.now() + 1000,
          app: testConst.TEST_APP,
          device: testConst.TEST_DEVICE + ' shape-array-2',
          eventType: 'Note',
          notes: 'array test 2'
        }
      ];

      let res = await self.instance.post(url, self.jwt.create)
        .send(docs)
        .expect(400);

      res.body.status.should.equal(400);
    });

    it('POST rejects empty array with 400', async () => {
      let res = await self.instance.post(url, self.jwt.create)
        .send([])
        .expect(400);

      res.body.status.should.equal(400);
    });

    it('POST rejects empty object with 400', async () => {
      let res = await self.instance.post(url, self.jwt.create)
        .send({})
        .expect(400);

      res.body.status.should.equal(400);
    });

    it('response format is object not array', async () => {
      const doc = {
        date: Date.now(),
        app: testConst.TEST_APP,
        device: testConst.TEST_DEVICE + ' shape-format',
        eventType: 'Correction Bolus',
        insulin: 0.5
      };
      doc.identifier = opTools.calculateIdentifier(doc);

      let res = await self.instance.post(url, self.jwt.create)
        .send(doc)
        .expect(201);

      res.body.should.be.an.Object();
      res.body.should.not.be.an.Array();
      res.body.status.should.equal(201);

      await deleteDoc(doc.identifier);
      self.cache.nextShouldEql(col, doc);
      self.cache.nextShouldDeleteLast(col);
    });
  });

  describe('Entries Collection - /api/v3/entries', function() {
    const col = 'entries';
    const url = `/api/v3/${col}`;

    async function deleteDoc(identifier) {
      await self.instance.delete(`${url}/${identifier}?permanent=true`, self.jwt.delete)
        .expect(200);
    }

    it('POST accepts single SGV entry', async () => {
      const now = Date.now();
      const doc = {
        date: now,
        app: testConst.TEST_APP,
        device: testConst.TEST_DEVICE + ' sgv-single',
        type: 'sgv',
        sgv: 120,
        direction: 'Flat'
      };
      doc.identifier = opTools.calculateIdentifier(doc);

      let res = await self.instance.post(url, self.jwt.create)
        .send(doc)
        .expect(201);

      res.body.status.should.equal(201);
      res.body.identifier.should.equal(doc.identifier);

      await deleteDoc(doc.identifier);
      self.cache.nextShouldEql(col, doc);
      self.cache.nextShouldDeleteLast(col);
    });

    it('POST rejects array of entries with 400', async () => {
      const now = Date.now();
      const docs = [
        {
          date: now,
          app: testConst.TEST_APP,
          device: testConst.TEST_DEVICE + ' sgv-array-1',
          type: 'sgv',
          sgv: 115
        },
        {
          date: now + 300000,
          app: testConst.TEST_APP,
          device: testConst.TEST_DEVICE + ' sgv-array-2',
          type: 'sgv',
          sgv: 125
        }
      ];

      let res = await self.instance.post(url, self.jwt.create)
        .send(docs)
        .expect(400);

      res.body.status.should.equal(400);
    });
  });

  describe('Devicestatus Collection - /api/v3/devicestatus', function() {
    const col = 'devicestatus';
    const url = `/api/v3/${col}`;

    async function deleteDoc(identifier) {
      await self.instance.delete(`${url}/${identifier}?permanent=true`, self.jwt.delete)
        .expect(200);
    }

    it('POST accepts single devicestatus', async () => {
      const now = Date.now();
      const doc = {
        date: now,
        app: testConst.TEST_APP,
        device: testConst.TEST_DEVICE + ' status-single',
        uploaderBattery: 85
      };
      doc.identifier = opTools.calculateIdentifier(doc);

      let res = await self.instance.post(url, self.jwt.create)
        .send(doc)
        .expect(201);

      res.body.status.should.equal(201);
      res.body.identifier.should.equal(doc.identifier);

      await deleteDoc(doc.identifier);
      self.cache.nextShouldEql(col, doc);
      self.cache.nextShouldDeleteLast(col);
    });

    it('POST rejects array of devicestatus with 400', async () => {
      const now = Date.now();
      const docs = [
        {
          date: now,
          app: testConst.TEST_APP,
          device: testConst.TEST_DEVICE + ' status-array-1',
          uploaderBattery: 80
        },
        {
          date: now + 1000,
          app: testConst.TEST_APP,
          device: testConst.TEST_DEVICE + ' status-array-2',
          uploaderBattery: 75
        }
      ];

      let res = await self.instance.post(url, self.jwt.create)
        .send(docs)
        .expect(400);

      res.body.status.should.equal(400);
    });
  });

  describe('Cross-API Consistency', function() {
    const treatmentsUrl = '/api/v3/treatments';

    async function deleteDoc(identifier) {
      await self.instance.delete(`${treatmentsUrl}/${identifier}?permanent=true`, self.jwt.delete)
        .expect(200);
    }

    it('document created via API v3 is readable via API v3 GET', async () => {
      const doc = {
        date: Date.now(),
        app: testConst.TEST_APP,
        device: testConst.TEST_DEVICE + ' cross-api',
        eventType: 'Note',
        notes: 'cross-api test'
      };
      doc.identifier = opTools.calculateIdentifier(doc);

      await self.instance.post(treatmentsUrl, self.jwt.create)
        .send(doc)
        .expect(201);

      self.cache.nextShouldEql('treatments', doc);

      let getRes = await self.instance.get(`${treatmentsUrl}/${doc.identifier}`, self.jwt.read)
        .expect(200);

      getRes.body.status.should.equal(200);
      getRes.body.result.notes.should.equal('cross-api test');

      await deleteDoc(doc.identifier);
      self.cache.nextShouldDeleteLast('treatments');
    });

    it('deduplication handles re-POST of same document', async () => {
      const doc = {
        date: Date.now(),
        app: testConst.TEST_APP,
        device: testConst.TEST_DEVICE + ' dedup-test',
        eventType: 'Note',
        notes: 'original note'
      };
      doc.identifier = opTools.calculateIdentifier(doc);

      let res1 = await self.instance.post(treatmentsUrl, self.jwt.create)
        .send(doc)
        .expect(201);

      res1.body.status.should.equal(201);
      self.cache.nextShouldEql('treatments', doc);

      const updatedDoc = Object.assign({}, doc, { notes: 'updated note' });

      let res2 = await self.instance.post(treatmentsUrl, self.jwt.all)
        .send(updatedDoc)
        .expect(200);

      res2.body.status.should.equal(200);
      res2.body.isDeduplication.should.equal(true);
      self.cache.nextShouldEql('treatments', updatedDoc);

      await deleteDoc(doc.identifier);
      self.cache.nextShouldDeleteLast('treatments');
    });
  });
});
