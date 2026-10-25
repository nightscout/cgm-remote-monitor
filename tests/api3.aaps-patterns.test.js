'use strict';

require('should');

describe('API3 AAPS Patterns - Deduplication and Real-world Scenarios', function() {
  const self = this;
  const testConst = require('./fixtures/api3/const.json');
  const aapsPatterns = require('./fixtures/aaps-patterns.json');
  const instance = require('./fixtures/api3/instance');
  const authSubject = require('./fixtures/api3/authSubject');
  const opTools = require('../lib/api3/shared/operationTools');

  self.timeout(30000);

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

  describe('Deduplication Tests - identifier-based (device + date + eventType)', function() {
    const col = 'treatments';
    const url = `/api/v3/${col}`;

    async function deleteDoc(identifier) {
      self.cache.clear();
      await self.instance.delete(`${url}/${identifier}?permanent=true`, self.jwt.delete)
        .expect(200);
      self.cache.clear();
    }

    async function getDoc(identifier) {
      let res = await self.instance.get(`${url}/${identifier}`, self.jwt.read)
        .expect(200);
      return res.body.result;
    }

    it('returns 201 for new treatment with unique identifier and persists AAPS fields', async () => {
      const baseFixture = aapsPatterns.DEDUPLICATION_TESTS.ORIGINAL;
      const doc = {
        device: 'test-device-unique-' + Date.now(),
        date: Date.now(),
        app: testConst.TEST_APP,
        eventType: baseFixture.eventType,
        insulin: baseFixture.insulin,
        pumpId: baseFixture.pumpId,
        pumpType: baseFixture.pumpType,
        pumpSerial: baseFixture.pumpSerial,
        isValid: baseFixture.isValid
      };
      doc.identifier = opTools.calculateIdentifier(doc);

      let res = await self.instance.post(url, self.jwt.create)
        .send(doc)
        .expect(201);

      res.body.status.should.equal(201);
      res.body.identifier.should.equal(doc.identifier);

      const persisted = await getDoc(doc.identifier);
      persisted.pumpId.should.equal(baseFixture.pumpId);
      persisted.pumpType.should.equal(baseFixture.pumpType);
      persisted.pumpSerial.should.equal(baseFixture.pumpSerial);
      persisted.insulin.should.equal(baseFixture.insulin);

      await deleteDoc(doc.identifier);
    });

    it('returns 200 for duplicate with same device+date+eventType (deduplication)', async () => {
      const doc = {
        device: 'test-device-dedup-' + Date.now(),
        date: Date.now(),
        app: testConst.TEST_APP,
        eventType: 'Correction Bolus',
        insulin: 0.5,
        isValid: true
      };
      doc.identifier = opTools.calculateIdentifier(doc);

      let res1 = await self.instance.post(url, self.jwt.create)
        .send(doc)
        .expect(201);

      res1.body.status.should.equal(201);
      self.cache.clear();

      let res2 = await self.instance.post(url, self.jwt.update)
        .send(doc)
        .expect(200);

      res2.body.status.should.equal(200);
      res2.body.identifier.should.equal(doc.identifier);

      await deleteDoc(doc.identifier);
    });

    it('different pumpId but same device+date+eventType triggers dedup (pumpId not in identifier)', async () => {
      const baseTime = Date.now();
      const device = 'test-device-pumpid-' + baseTime;

      const doc1 = {
        device: device,
        date: baseTime,
        app: testConst.TEST_APP,
        eventType: 'Correction Bolus',
        insulin: 0.5,
        pumpId: 9998,
        pumpType: 'DANA_R',
        pumpSerial: '12345'
      };
      doc1.identifier = opTools.calculateIdentifier(doc1);

      const doc2 = {
        device: device,
        date: baseTime,
        app: testConst.TEST_APP,
        eventType: 'Correction Bolus',
        insulin: 0.5,
        pumpId: 9999,
        pumpType: 'DANA_R',
        pumpSerial: '12345'
      };
      doc2.identifier = opTools.calculateIdentifier(doc2);

      let res1 = await self.instance.post(url, self.jwt.create)
        .send(doc1)
        .expect(201);

      res1.body.status.should.equal(201);
      self.cache.clear();

      let res2 = await self.instance.post(url, self.jwt.update)
        .send(doc2)
        .expect(200);

      res2.body.status.should.equal(200);
      res2.body.identifier.should.equal(doc1.identifier);

      await deleteDoc(doc1.identifier);
    });

    it('different date creates new unique treatment (201)', async () => {
      const baseTime = Date.now();
      const device = 'test-device-date-' + baseTime;

      const doc1 = {
        device: device,
        date: baseTime,
        app: testConst.TEST_APP,
        eventType: 'Correction Bolus',
        insulin: 0.5
      };
      doc1.identifier = opTools.calculateIdentifier(doc1);

      const doc2 = {
        device: device,
        date: baseTime + 300000,
        app: testConst.TEST_APP,
        eventType: 'Correction Bolus',
        insulin: 0.5
      };
      doc2.identifier = opTools.calculateIdentifier(doc2);

      let res1 = await self.instance.post(url, self.jwt.create)
        .send(doc1)
        .expect(201);

      res1.body.status.should.equal(201);
      self.cache.clear();

      let res2 = await self.instance.post(url, self.jwt.create)
        .send(doc2)
        .expect(201);

      res2.body.status.should.equal(201);
      res2.body.identifier.should.not.equal(res1.body.identifier);

      await deleteDoc(doc1.identifier);
      await deleteDoc(doc2.identifier);
    });

    it('different eventType creates new unique treatment (201)', async () => {
      const baseTime = Date.now();
      const device = 'test-device-event-' + baseTime;

      const doc1 = {
        device: device,
        date: baseTime,
        app: testConst.TEST_APP,
        eventType: 'Correction Bolus',
        insulin: 0.5
      };
      doc1.identifier = opTools.calculateIdentifier(doc1);

      const doc2 = {
        device: device,
        date: baseTime,
        app: testConst.TEST_APP,
        eventType: 'Meal Bolus',
        insulin: 0.5
      };
      doc2.identifier = opTools.calculateIdentifier(doc2);

      let res1 = await self.instance.post(url, self.jwt.create)
        .send(doc1)
        .expect(201);

      res1.body.status.should.equal(201);
      self.cache.clear();

      let res2 = await self.instance.post(url, self.jwt.create)
        .send(doc2)
        .expect(201);

      res2.body.status.should.equal(201);
      res2.body.identifier.should.not.equal(res1.body.identifier);

      await deleteDoc(doc1.identifier);
      await deleteDoc(doc2.identifier);
    });

    it('rapid duplicate submissions result in single persisted document with latest srvModified', async () => {
      const baseTime = Date.now();
      const device = 'test-device-rapid-dedup-' + baseTime;

      const doc = {
        device: device,
        date: baseTime,
        app: testConst.TEST_APP,
        eventType: 'Correction Bolus',
        insulin: 0.5,
        pumpId: 8888,
        pumpType: aapsPatterns.PUMP_IDENTIFIERS.DANA_R.pumpType,
        pumpSerial: aapsPatterns.PUMP_IDENTIFIERS.DANA_R.pumpSerial
      };
      doc.identifier = opTools.calculateIdentifier(doc);

      let res1 = await self.instance.post(url, self.jwt.create)
        .send(doc)
        .expect(201);
      res1.body.status.should.equal(201);
      const firstSrvModified = res1.body.lastModified;
      self.cache.clear();

      await new Promise(resolve => setTimeout(resolve, 50));

      let res2 = await self.instance.post(url, self.jwt.update)
        .send(doc)
        .expect(200);
      res2.body.status.should.equal(200);
      res2.body.identifier.should.equal(doc.identifier);
      const secondSrvModified = res2.body.lastModified;
      secondSrvModified.should.be.greaterThan(firstSrvModified,
        'Second srvModified should be strictly greater than first');
      self.cache.clear();

      await new Promise(resolve => setTimeout(resolve, 50));

      let res3 = await self.instance.post(url, self.jwt.update)
        .send(doc)
        .expect(200);
      res3.body.status.should.equal(200);
      res3.body.identifier.should.equal(doc.identifier);
      const thirdSrvModified = res3.body.lastModified;
      thirdSrvModified.should.be.greaterThan(secondSrvModified,
        'Third srvModified should be strictly greater than second');
      self.cache.clear();

      const persisted = await getDoc(doc.identifier);
      persisted.identifier.should.equal(doc.identifier);
      persisted.pumpId.should.equal(8888);
      persisted.srvModified.should.be.greaterThan(persisted.srvCreated,
        'Persisted srvModified should be strictly greater than srvCreated after updates');

      persisted.srvModified.should.equal(thirdSrvModified,
        'Persisted srvModified must exactly match the lastModified from the final API response');

      let searchByIdentifier = await self.instance.get(`${url}?identifier=${doc.identifier}`, self.jwt.read)
        .expect(200);
      searchByIdentifier.body.result.length.should.equal(1,
        'Exactly one document should exist when searching by identifier');
      searchByIdentifier.body.result[0].identifier.should.equal(doc.identifier);
      searchByIdentifier.body.result[0].srvModified.should.equal(thirdSrvModified);

      let searchByDeviceDate = await self.instance.get(`${url}?device=${device}&date$eq=${baseTime}`, self.jwt.read)
        .expect(200);
      searchByDeviceDate.body.result.length.should.equal(1,
        'Exactly one document should exist when searching by device + date');
      searchByDeviceDate.body.result[0].identifier.should.equal(doc.identifier);
      searchByDeviceDate.body.result[0].srvModified.should.equal(thirdSrvModified);

      await deleteDoc(doc.identifier);
    });

    it('full AAPS fixture payload with created_at and dateString persists correctly', async () => {
      const baseTime = Date.now();
      const baseFixture = aapsPatterns.DEDUPLICATION_TESTS.ORIGINAL;

      const doc = {
        device: 'test-device-full-fixture-' + baseTime,
        date: baseTime,
        created_at: new Date(baseTime).toISOString(),
        dateString: new Date(baseTime).toISOString(),
        app: testConst.TEST_APP,
        eventType: baseFixture.eventType,
        insulin: baseFixture.insulin,
        pumpId: baseFixture.pumpId,
        pumpType: baseFixture.pumpType,
        pumpSerial: baseFixture.pumpSerial,
        isValid: baseFixture.isValid,
        isSMB: false,
        type: 'NORMAL'
      };
      doc.identifier = opTools.calculateIdentifier(doc);

      let res = await self.instance.post(url, self.jwt.create)
        .send(doc)
        .expect(201);

      res.body.status.should.equal(201);
      self.cache.clear();

      const persisted = await getDoc(doc.identifier);
      persisted.identifier.should.equal(doc.identifier);
      persisted.pumpId.should.equal(baseFixture.pumpId);
      persisted.pumpType.should.equal(baseFixture.pumpType);
      persisted.pumpSerial.should.equal(baseFixture.pumpSerial);
      persisted.insulin.should.equal(baseFixture.insulin);
      persisted.eventType.should.equal(baseFixture.eventType);
      persisted.should.have.property('srvCreated');
      persisted.should.have.property('srvModified');

      await deleteDoc(doc.identifier);
    });
  });

  describe('SMB Burst Pattern - rapid sequential micro-boluses', function() {
    const col = 'treatments';
    const url = `/api/v3/${col}`;

    async function deleteDoc(identifier) {
      self.cache.clear();
      await self.instance.delete(`${url}/${identifier}?permanent=true`, self.jwt.delete)
        .expect(200);
      self.cache.clear();
    }

    async function getDoc(identifier) {
      let res = await self.instance.get(`${url}/${identifier}`, self.jwt.read)
        .expect(200);
      return res.body.result;
    }

    it('handles sequential SMB corrections with full AAPS-realistic payloads', async () => {
      const baseTime = Date.now();
      const device = 'test-device-smb-' + baseTime;
      const identifiers = [];
      const smbFixtures = aapsPatterns.SMB_BURSTS.CORRECTION_SEQUENCE;

      for (let i = 0; i < 3; i++) {
        const fixtureSmb = smbFixtures[i];
        const smb = {
          device: device,
          date: baseTime + (i * 300000),
          created_at: new Date(baseTime + (i * 300000)).toISOString(),
          app: testConst.TEST_APP,
          eventType: fixtureSmb.eventType,
          insulin: fixtureSmb.insulin,
          isSMB: fixtureSmb.isSMB,
          pumpId: fixtureSmb.pumpId,
          pumpType: fixtureSmb.pumpType,
          pumpSerial: fixtureSmb.pumpSerial,
          type: fixtureSmb.type || 'NORMAL',
          isValid: fixtureSmb.isValid
        };
        smb.identifier = opTools.calculateIdentifier(smb);

        let res = await self.instance.post(url, self.jwt.create)
          .send(smb)
          .expect(201);

        res.body.status.should.equal(201);
        identifiers.push(res.body.identifier);
        self.cache.clear();

        const persisted = await getDoc(res.body.identifier);
        persisted.pumpId.should.equal(fixtureSmb.pumpId);
        persisted.isSMB.should.equal(true);
        persisted.insulin.should.equal(fixtureSmb.insulin);
        self.cache.clear();
      }

      const uniqueIds = [...new Set(identifiers)];
      uniqueIds.length.should.equal(3);

      for (const id of identifiers) {
        await deleteDoc(id);
      }
    });
  });

  describe('Meal Scenario - carbs, bolus wizard, meal bolus', function() {
    const col = 'treatments';
    const url = `/api/v3/${col}`;

    async function deleteDoc(identifier) {
      self.cache.clear();
      await self.instance.delete(`${url}/${identifier}?permanent=true`, self.jwt.delete)
        .expect(200);
      self.cache.clear();
    }

    async function getDoc(identifier) {
      let res = await self.instance.get(`${url}/${identifier}`, self.jwt.read)
        .expect(200);
      return res.body.result;
    }

    it('creates all meal-related treatments with full AAPS payloads and verifies persisted fields', async () => {
      const baseTime = Date.now();
      const device = 'test-device-meal-' + baseTime;
      const identifiers = [];
      const mealFixtures = aapsPatterns.MEAL_SCENARIO;

      const carbsFixture = mealFixtures.CARB_ENTRY;
      const carbs = {
        device: device,
        date: baseTime,
        created_at: new Date(baseTime).toISOString(),
        app: testConst.TEST_APP,
        eventType: carbsFixture.eventType,
        carbs: carbsFixture.carbs,
        isValid: carbsFixture.isValid
      };
      carbs.identifier = opTools.calculateIdentifier(carbs);

      let res1 = await self.instance.post(url, self.jwt.create)
        .send(carbs)
        .expect(201);
      identifiers.push(res1.body.identifier);
      self.cache.clear();

      const persistedCarbs = await getDoc(res1.body.identifier);
      persistedCarbs.carbs.should.equal(carbsFixture.carbs);
      persistedCarbs.eventType.should.equal(carbsFixture.eventType);
      persistedCarbs.should.have.property('srvCreated');
      self.cache.clear();

      const wizardFixture = mealFixtures.BOLUS_WIZARD;
      const wizard = {
        device: device,
        date: baseTime + 1000,
        created_at: new Date(baseTime + 1000).toISOString(),
        app: testConst.TEST_APP,
        eventType: wizardFixture.eventType,
        glucose: wizardFixture.glucose,
        glucoseType: wizardFixture.glucoseType,
        carbs: wizardFixture.carbs,
        insulin: wizardFixture.insulin
      };
      wizard.identifier = opTools.calculateIdentifier(wizard);

      let res2 = await self.instance.post(url, self.jwt.create)
        .send(wizard)
        .expect(201);
      identifiers.push(res2.body.identifier);
      self.cache.clear();

      const persistedWizard = await getDoc(res2.body.identifier);
      persistedWizard.glucose.should.equal(wizardFixture.glucose);
      persistedWizard.insulin.should.equal(wizardFixture.insulin);
      persistedWizard.should.have.property('srvCreated');
      self.cache.clear();

      const bolusFixture = mealFixtures.MEAL_BOLUS;
      const bolus = {
        device: device,
        date: baseTime + 2000,
        created_at: new Date(baseTime + 2000).toISOString(),
        app: testConst.TEST_APP,
        eventType: bolusFixture.eventType,
        insulin: bolusFixture.insulin,
        pumpId: bolusFixture.pumpId,
        pumpType: bolusFixture.pumpType,
        pumpSerial: bolusFixture.pumpSerial
      };
      bolus.identifier = opTools.calculateIdentifier(bolus);

      let res3 = await self.instance.post(url, self.jwt.create)
        .send(bolus)
        .expect(201);
      identifiers.push(res3.body.identifier);
      self.cache.clear();

      const persistedBolus = await getDoc(res3.body.identifier);
      persistedBolus.pumpId.should.equal(bolusFixture.pumpId);
      persistedBolus.pumpType.should.equal(bolusFixture.pumpType);
      persistedBolus.pumpSerial.should.equal(bolusFixture.pumpSerial);
      persistedBolus.insulin.should.equal(bolusFixture.insulin);
      persistedBolus.should.have.property('srvCreated');
      self.cache.clear();

      const uniqueIds = [...new Set(identifiers)];
      uniqueIds.length.should.equal(3);

      for (const id of identifiers) {
        await deleteDoc(id);
      }
    });
  });

  describe('SGV Entry Pattern - high-frequency glucose readings', function() {
    const col = 'entries';
    const url = `/api/v3/${col}`;

    async function deleteDoc(identifier) {
      self.cache.clear();
      await self.instance.delete(`${url}/${identifier}?permanent=true`, self.jwt.delete)
        .expect(200);
      self.cache.clear();
    }

    async function getDoc(identifier) {
      let res = await self.instance.get(`${url}/${identifier}`, self.jwt.read)
        .expect(200);
      return res.body.result;
    }

    it('handles rapid sequential SGV entries with full AAPS payloads and verifies persisted fields', async () => {
      const baseTime = Date.now();
      const device = 'test-device-sgv-' + baseTime;
      const identifiers = [];
      const sgvFixtures = aapsPatterns.SGV_ENTRIES.HIGH_FREQUENCY_BATCH;

      for (let i = 0; i < 3; i++) {
        const fixtureEntry = sgvFixtures[i];
        const sgv = {
          device: device,
          date: baseTime + (i * 300000),
          dateString: new Date(baseTime + (i * 300000)).toISOString(),
          app: testConst.TEST_APP,
          type: fixtureEntry.type,
          sgv: fixtureEntry.sgv,
          direction: fixtureEntry.direction,
          utcOffset: fixtureEntry.utcOffset
        };
        sgv.identifier = opTools.calculateIdentifier(sgv);

        let res = await self.instance.post(url, self.jwt.create)
          .send(sgv)
          .expect(201);

        res.body.status.should.equal(201);
        identifiers.push(res.body.identifier);
        self.cache.clear();

        const persisted = await getDoc(res.body.identifier);
        persisted.sgv.should.equal(fixtureEntry.sgv);
        persisted.direction.should.equal(fixtureEntry.direction);
        persisted.should.have.property('srvCreated');
        persisted.should.have.property('srvModified');
        self.cache.clear();
      }

      const uniqueIds = [...new Set(identifiers)];
      uniqueIds.length.should.equal(3);

      for (const id of identifiers) {
        await deleteDoc(id);
      }
    });
  });

  describe('Profile sync via REST (V3) - AAPS createProfileStore behavior', function() {
    const url = '/api/v3/profile';

    function profileCollection() {
      return self.instance.ctx.store.collection(self.env.profile_collection);
    }

    function aapsV3Profile(dateMs, overrides) {
      const iso = new Date(dateMs).toISOString();
      return Object.assign({
        app: 'AAPS',
        date: dateMs,
        created_at: iso,
        startDate: iso,
        defaultProfile: 'aaps-v3-test',
        units: 'mg/dl',
        store: {
          'aaps-v3-test': {
            dia: 5,
            carbratio: [{ time: '00:00', value: 10 }],
            sens: [{ time: '00:00', value: 50 }],
            basal: [{ time: '00:00', value: 0.5 }],
            target_low: [{ time: '00:00', value: 100 }],
            target_high: [{ time: '00:00', value: 120 }],
            timezone: 'UTC'
          }
        }
      }, overrides || {});
    }

    async function cleanupTestProfiles() {
      await profileCollection().deleteMany({ defaultProfile: 'aaps-v3-test' });
    }

    beforeEach(cleanupTestProfiles);
    after(cleanupTestProfiles);

    it('first AAPS V3 profile POST returns 201 and inserts a new doc', async () => {
      const profile = aapsV3Profile(Date.now());
      const res = await self.instance.post(url, self.jwt.create).send(profile);
      res.status.should.equal(201);

      const docs = await profileCollection().find({ defaultProfile: 'aaps-v3-test' }).toArray();
      docs.length.should.equal(1);
    });

    it('resending the SAME profile (same date) returns 200 and dedups in place', async () => {
      const profile = aapsV3Profile(Date.now());
      const res1 = await self.instance.post(url, self.jwt.create).send(profile);
      res1.status.should.equal(201);
      self.cache.clear();

      // resend identical payload (e.g. retry after network failure)
      const res2 = await self.instance.post(url, self.jwt.update).send(profile);
      res2.status.should.equal(200);
      res2.body.identifier.should.equal(res1.body.identifier);

      const docs = await profileCollection().find({ defaultProfile: 'aaps-v3-test' }).toArray();
      docs.length.should.equal(1);
    });

    it('AAPS edit (new date from LocalProfileLastChange) creates a SECOND doc, not an update', async () => {
      // Simulates: user edits profile in AAPS twice -> two distinct LocalProfileLastChange values
      const t1 = Date.now() - 60000;
      const first = aapsV3Profile(t1);
      first.store['aaps-v3-test'].carbratio[0].value = 8;
      const second = aapsV3Profile(Date.now());
      second.store['aaps-v3-test'].carbratio[0].value = 14;

      const res1 = await self.instance.post(url, self.jwt.create).send(first);
      res1.status.should.equal(201);
      self.cache.clear();

      const res2 = await self.instance.post(url, self.jwt.create).send(second);
      // V3 inserts a NEW doc because identifier (uuidv5 of "undefined_<date>") differs
      res2.status.should.equal(201);
      res2.body.identifier.should.not.equal(res1.body.identifier);

      const docs = await profileCollection().find({ defaultProfile: 'aaps-v3-test' }).toArray();
      docs.length.should.equal(2);

      // Verify ctx.profile.last() returns the newer profile (post-fix sort: startDate desc, _id desc)
      await new Promise((resolve, reject) => {
        self.instance.ctx.profile.last((err, lastDocs) => {
          if (err) return reject(err);
          try {
            lastDocs.length.should.equal(1);
            lastDocs[0].store['aaps-v3-test'].carbratio[0].value.should.equal(14);
            resolve();
          } catch (e) { reject(e); }
        });
      });
    });
  });
});
