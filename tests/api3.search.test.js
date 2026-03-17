/* eslint require-atomic-updates: 0 */
/* global should */
'use strict';

require('should');

/**
 * Given an array of objects, and an array of properties to preserve in the
 * objects, returns a new array of objects with only the given properties.
 *
 * docs - array of objects to process
 * propertiesToKeep - array of strings representing properties to transfer to
 *                    objects in the return array
 */
function reduceFeatures(docs, propertiesToKeep) {
  const modifiedDocs = [];

  docs.forEach((doc) => {
    const newDoc = {};

    propertiesToKeep.forEach((property) => {
      newDoc[property] = doc[property];
    });

    modifiedDocs.push(newDoc);
  });

  return modifiedDocs;
}

/**
 * Given two arrays of objects, ensures the array of properties given in
 * propertiesToCompare matches for every member of the given arrays.
 *
 * a - first array to compare
 * b - second array to compare
 * propertiesToCompare - array of strings representing properties to compare
 */
function membersAreEqual(a, b, propertiesToCompare) {
  const modifiedA = reduceFeatures(a, propertiesToCompare);
  const modifiedB = reduceFeatures(b, propertiesToCompare);

  modifiedA.should.eql(modifiedB);
}

/**
 * Given two arrays of objects, ensures the array of properties given in
 * propertiesToCompare matches for every member of the requiredMembers array.
 *
 * requiredMembers - array of members that must exist in arrayToCheck
 * arrayToCheck - second array to compare
 * propertiesToCompare - array of strings representing properties to compare
 */
function containsMembers(requiredMembers, arrayToCheck, propertiesToCompare) {
  const modifiedRequiredMembers = reduceFeatures(requiredMembers, propertiesToCompare);
  const modifiedArrayToCheck = reduceFeatures(arrayToCheck, propertiesToCompare);

  modifiedRequiredMembers.forEach((member) => {
    modifiedArrayToCheck.should.containEql(member);
  });
}

function cloneDoc(doc) {
  return JSON.parse(JSON.stringify(doc));
}

describe('API3 SEARCH', function() {
  const self = this
    , testConst = require('./fixtures/api3/const.json')
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , opTools = require('../lib/api3/shared/operationTools')
    ;

  const docCount = 10;
  const baseDate = testConst.YEAR_2019;

  const makeDocs = (builder) => Array.from({ length: docCount }, (_, index) => builder(index));

  const sampleDeviceStatuses = makeDocs((index) => ({
    date: baseDate + (index * 60000),
    utcOffset: 0,
    app: testConst.TEST_APP,
    some_property: `device-status-${index}`
  }));

  const sampleFoods = makeDocs((index) => ({
    date: baseDate + (index * 60000),
    utcOffset: 0,
    app: testConst.TEST_APP,
    food: 'quickpick',
    category: `category-${index % 3}`,
    subcategory: `subcategory-${index % 2}`,
    name: `food-${index}`,
    portion: index + 1,
    unit: 'g',
    carbs: 10 + index,
    fat: 5 + index,
    protein: 3 + index,
    energy: 50 + index,
    gi: 20 + index,
    hideafteruse: index % 2 === 0,
    hidden: index % 3 === 0,
    position: index,
    portions: [],
    foods: []
  }));

  const sampleEntries = testConst.SAMPLE_ENTRIES.map((doc) => Object.assign({ utcOffset: 0 }, cloneDoc(doc)));

  const sampleProfiles = makeDocs((index) => ({
    date: baseDate + (index * 60000),
    utcOffset: 0,
    app: testConst.TEST_APP,
    some_property: `profile-${index}`
  }));

  const sampleSettings = makeDocs((index) => ({
    date: baseDate + (index * 60000),
    utcOffset: 0,
    app: testConst.TEST_APP,
    some_property: `settings-${index}`
  }));

  const sampleTreatments = makeDocs((index) => ({
    date: baseDate + (index * 60000),
    utcOffset: 0,
    app: testConst.TEST_APP,
    enteredBy: `search-test-${index}`,
    eventType: index % 2 === 0 ? 'Note' : 'Correction Bolus',
    notes: `note-${index}`
  }));

  self.timeout(30000);

  function deleteMany(collection) {
    return new Promise((resolve, reject) => {
      collection.deleteMany({}, function(err) {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  }

  self.clearCollection = async function clearCollection(endpoint) {
    const collectionName = endpoint.replace('/api/v3/', '');

    switch (collectionName) {
      case 'devicestatus':
        return deleteMany(self.instance.ctx.devicestatus());
      case 'entries':
        return deleteMany(self.instance.ctx.entries());
      case 'food':
        return deleteMany(self.instance.ctx.food());
      case 'profile':
        return deleteMany(self.instance.ctx.profile());
      case 'settings':
        return deleteMany(self.instance.ctx.store.collection(self.env.settings_collection));
      case 'treatments':
        return deleteMany(self.instance.ctx.treatments());
      default:
        throw new Error(`Unsupported API3 collection: ${collectionName}`);
    }
  };

  self.clearAllCollections = async function clearAllCollections() {
    await Promise.all([
      self.clearCollection('/api/v3/devicestatus'),
      self.clearCollection('/api/v3/entries'),
      self.clearCollection('/api/v3/food'),
      self.clearCollection('/api/v3/profile'),
      self.clearCollection('/api/v3/settings'),
      self.clearCollection('/api/v3/treatments')
    ]);
  };

  /**
   * Create given document in a promise
   */
  self.createDocument = async function createDocument(doc, url) {
    const createDoc = cloneDoc(doc);
    createDoc.identifier = opTools.calculateIdentifier(createDoc);

    const res = await self.instance.post(url, self.jwt.all)
      .send(createDoc)
      .expect(201);

    res.body.status.should.equal(201);
    res.body.identifier.should.equal(createDoc.identifier);

    return createDoc;
  };

  /**
   * Suite of tests executed against all search API endpoints.
   *
   * endpoint - the API endpoint to test
   * testDocs - docs inserted for test
   * commonProperties - properties all test docs contain
   * dynamicProperties - properties generated or normalized by storage
   * jwtToUse - which token to use for the search endpoint
   */
  function shouldHaveCommonAPIBehaviors(endpoint, testDocs, commonProperties, dynamicProperties, jwtToUse) {
    const allProperties = commonProperties.concat(dynamicProperties);
    let createdDocs = [];

    before(async () => {
      await self.clearCollection(endpoint);
      createdDocs = await Promise.all(testDocs.map((doc) => self.createDocument(doc, endpoint)));
    });

    after(async () => {
      await self.clearCollection(endpoint);
    });

    it('should require authentication', async function() {
      const res = await self.instance.get(endpoint)
        .expect(401);

      res.body.status.should.equal(401);
      res.body.message.should.equal('Missing or bad access token or JWT');
      should.not.exist(res.body.result);
    });

    it('should retrieve up to the max documents', async () => {
      const apiApp = self.instance.ctx.apiApp;
      const docLimit = Math.min(createdDocs.length, Number(apiApp.get('API3_MAX_LIMIT')));

      const res = await self.instance.get(endpoint, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);
      res.body.result.length.should.equal(docLimit);
      containsMembers(res.body.result, createdDocs, commonProperties);
    });

    it('should retrieve the documents added after test start', async () => {
      const res = await self.instance.get(`${endpoint}?srvModified$gte=${self.testStarted.getTime()}`, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);
      res.body.result.length.should.equal(createdDocs.length);
      containsMembers(res.body.result, createdDocs, commonProperties);
    });

    it('should reject both sort and sort$desc', async () => {
      const res = await self.instance.get(`${endpoint}?sort=date&sort$desc=created_at`, self.jwt[jwtToUse])
        .expect(400);

      res.body.status.should.equal(400);
      res.body.message.should.equal('Parameters sort and sort_desc cannot be combined');
      should.not.exist(res.body.result);
    });

    it('should accept valid limit', async () => {
      const expectedLength = Math.min(createdDocs.length, 3);
      const res = await self.instance.get(`${endpoint}?limit=3`, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);
      res.body.result.length.should.equal(expectedLength);
      containsMembers(res.body.result, createdDocs, commonProperties);
    });

    it('should reject invalid limit - not a number', async () => {
      const res = await self.instance.get(`${endpoint}?limit=INVALID`, self.jwt[jwtToUse])
        .expect(400);

      res.body.status.should.equal(400);
      res.body.message.should.equal('Parameter limit out of tolerance');
      should.not.exist(res.body.result);
    });

    it('should reject invalid limit - negative number', async () => {
      const res = await self.instance.get(`${endpoint}?limit=-1`, self.jwt[jwtToUse])
        .expect(400);

      res.body.status.should.equal(400);
      res.body.message.should.equal('Parameter limit out of tolerance');
      should.not.exist(res.body.result);
    });

    it('should reject invalid limit - zero', async () => {
      const res = await self.instance.get(`${endpoint}?limit=0`, self.jwt[jwtToUse])
        .expect(400);

      res.body.status.should.equal(400);
      res.body.message.should.equal('Parameter limit out of tolerance');
      should.not.exist(res.body.result);
    });

    it('should not exceed the limit of docs count', async () => {
      const apiApp = self.instance.ctx.apiApp;
      const limitBackup = apiApp.get('API3_MAX_LIMIT');

      try {
        apiApp.set('API3_MAX_LIMIT', 5);
        const res = await self.instance.get(`${endpoint}?limit=10`, self.jwt[jwtToUse])
          .expect(400);

        res.body.status.should.equal(400);
        res.body.message.should.equal('Parameter limit out of tolerance');
      } finally {
        apiApp.set('API3_MAX_LIMIT', limitBackup);
      }
    });

    it('should respect the ceiling (hard) limit of docs', async () => {
      const apiApp = self.instance.ctx.apiApp;
      const limitBackup = apiApp.get('API3_MAX_LIMIT');

      try {
        apiApp.set('API3_MAX_LIMIT', 5);
        const res = await self.instance.get(endpoint, self.jwt[jwtToUse])
          .expect(200);

        res.body.status.should.equal(200);
        res.body.result.length.should.equal(Math.min(createdDocs.length, 5));
        containsMembers(res.body.result, createdDocs, commonProperties);
      } finally {
        apiApp.set('API3_MAX_LIMIT', limitBackup);
      }
    });

    it('should respect string API3_MAX_LIMIT defaults', async () => {
      const apiApp = self.instance.ctx.apiApp;
      const limitBackup = apiApp.get('API3_MAX_LIMIT');

      try {
        apiApp.set('API3_MAX_LIMIT', '5');
        const res = await self.instance.get(endpoint, self.jwt[jwtToUse])
          .expect(200);

        res.body.status.should.equal(200);
        res.body.result.length.should.equal(Math.min(createdDocs.length, 5));
        containsMembers(res.body.result, createdDocs, commonProperties);
      } finally {
        apiApp.set('API3_MAX_LIMIT', limitBackup);
      }
    });

    it('should skip documents', async () => {
      let res = await self.instance.get(`${endpoint}?sort=date&limit=8`, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);
      membersAreEqual(res.body.result, createdDocs.slice(0, 8), commonProperties);

      res = await self.instance.get(`${endpoint}?sort=date&skip=3&limit=5`, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);
      membersAreEqual(res.body.result, createdDocs.slice(3, 8), commonProperties);
    });

    it('should reject invalid skip - not a number', async () => {
      const res = await self.instance.get(`${endpoint}?skip=INVALID`, self.jwt[jwtToUse])
        .expect(400);

      res.body.status.should.equal(400);
      res.body.message.should.equal('Parameter skip out of tolerance');
      should.not.exist(res.body.result);
    });

    it('should reject invalid skip - negative number', async () => {
      const res = await self.instance.get(`${endpoint}?skip=-5`, self.jwt[jwtToUse])
        .expect(400);

      res.body.status.should.equal(400);
      res.body.message.should.equal('Parameter skip out of tolerance');
      should.not.exist(res.body.result);
    });

    it('should project all fields', async () => {
      const res = await self.instance.get(`${endpoint}?fields=_all`, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);
      res.body.result.forEach((doc) => {
        const resultProperties = Object.getOwnPropertyNames(doc);

        allProperties.forEach((property) => {
          resultProperties.should.containEql(property);
        });
        Object.prototype.hasOwnProperty.call(doc, '_id').should.not.be.true();
      });
    });

    it('should project selected fields', async () => {
      const halfProperties = Math.ceil(commonProperties.length / 2);
      const lowerFields = commonProperties.slice(0, halfProperties);
      const upperFields = commonProperties.slice(halfProperties);

      let res = await self.instance.get(`${endpoint}?fields=${lowerFields.join(',')}&sort=date`, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);
      membersAreEqual(res.body.result, createdDocs, lowerFields);

      res = await self.instance.get(`${endpoint}?fields=${upperFields.join(',')}&sort=date`, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);
      membersAreEqual(res.body.result, createdDocs, upperFields);
    });

    it('should sort by the given property', async () => {
      for (let i = 0; i < allProperties.length; i++) {
        const property = allProperties[i];

        let res = await self.instance.get(`${endpoint}?sort=${property}`, self.jwt[jwtToUse])
          .expect(200);

        res.body.status.should.equal(200);
        res.body.result.length.should.equal(createdDocs.length);
        containsMembers(res.body.result, createdDocs, commonProperties);
        (res.body.result.every((value, idx, arr) => !idx || arr[idx - 1][property] <= value[property])).should.be.true();

        res = await self.instance.get(`${endpoint}?sort$desc=${property}`, self.jwt[jwtToUse])
          .expect(200);

        res.body.status.should.equal(200);
        res.body.result.length.should.equal(createdDocs.length);
        containsMembers(res.body.result, createdDocs, commonProperties);
        (res.body.result.every((value, idx, arr) => !idx || arr[idx - 1][property] >= value[property])).should.be.true();
      }
    });
  }

  before(async () => {
    self.testStarted = new Date();
    self.instance = await instance.create({});

    self.app = self.instance.app;
    self.env = self.instance.env;

    const authResult = await authSubject(self.instance.ctx.authorization.storage, [
      'read',
      'all'
    ], self.instance.app);

    self.subject = authResult.subject;
    self.jwt = authResult.jwt;

    await self.clearAllCollections();
  });

  after(async () => {
    if (!self.instance || !self.instance.ctx) {
      return;
    }

    await self.clearAllCollections();
    self.instance.ctx.bus.teardown();
  });

  it('should not found not existing collection', async () => {
    const res = await self.instance.get('/api/v3/NOT_EXIST', self.jwt.read)
      .expect(404);

    res.body.status.should.equal(404);
    should.not.exist(res.body.result);
  });

  describe('device status endpoint', () => {
    const DEVICE_STATUSES_URL = '/api/v3/devicestatus';
    const DEVICE_STATUS_PROPERTIES = ['date', 'utcOffset', 'app', 'some_property', 'identifier'];
    const DEVICE_STATUS_DYNAMIC_PROPERTIES = ['created_at', 'subject', 'srvModified', 'srvCreated'];

    shouldHaveCommonAPIBehaviors(
      DEVICE_STATUSES_URL,
      sampleDeviceStatuses,
      DEVICE_STATUS_PROPERTIES,
      DEVICE_STATUS_DYNAMIC_PROPERTIES,
      'read'
    );
  });

  describe('food endpoint', () => {
    const FOOD_URL = '/api/v3/food';
    const FOOD_PROPERTIES = [
      'app', 'date', 'utcOffset', 'identifier', 'food', 'category', 'subcategory',
      'name', 'portion', 'unit', 'carbs', 'fat', 'protein', 'energy', 'gi',
      'hideafteruse', 'hidden', 'position'
    ];
    const FOOD_DYNAMIC_PROPERTIES = ['created_at', 'subject', 'srvModified', 'srvCreated'];

    shouldHaveCommonAPIBehaviors(
      FOOD_URL,
      sampleFoods,
      FOOD_PROPERTIES,
      FOOD_DYNAMIC_PROPERTIES,
      'read'
    );
  });

  describe('entries endpoint', () => {
    const ENTRIES_URL = '/api/v3/entries';
    const ENTRY_PROPERTIES = ['date', 'utcOffset', 'device', 'direction', 'filtered', 'noise', 'rssi', 'sgv', 'type', 'unfiltered', 'app', 'identifier'];
    const ENTRY_DYNAMIC_PROPERTIES = ['created_at', 'subject', 'srvModified', 'srvCreated'];

    shouldHaveCommonAPIBehaviors(
      ENTRIES_URL,
      sampleEntries,
      ENTRY_PROPERTIES,
      ENTRY_DYNAMIC_PROPERTIES,
      'read'
    );
  });

  describe('profiles endpoint', () => {
    const PROFILES_URL = '/api/v3/profile';
    const PROFILE_PROPERTIES = ['date', 'utcOffset', 'app', 'some_property', 'identifier'];
    const PROFILE_DYNAMIC_PROPERTIES = ['created_at', 'subject', 'srvModified', 'srvCreated'];

    shouldHaveCommonAPIBehaviors(
      PROFILES_URL,
      sampleProfiles,
      PROFILE_PROPERTIES,
      PROFILE_DYNAMIC_PROPERTIES,
      'read'
    );
  });

  describe('settings endpoint', () => {
    const SETTINGS_URL = '/api/v3/settings';
    const SETTING_PROPERTIES = ['date', 'utcOffset', 'app', 'some_property', 'identifier'];
    const SETTING_DYNAMIC_PROPERTIES = ['created_at', 'subject', 'srvModified', 'srvCreated'];

    it('should require all permission', async function() {
      const res = await self.instance.get(SETTINGS_URL, self.jwt.read)
        .expect(403);

      res.body.status.should.equal(403);
      res.body.message.should.equal('Missing permission api:settings:admin');
      should.not.exist(res.body.result);
    });

    shouldHaveCommonAPIBehaviors(
      SETTINGS_URL,
      sampleSettings,
      SETTING_PROPERTIES,
      SETTING_DYNAMIC_PROPERTIES,
      'all'
    );
  });

  describe('treatments endpoint', () => {
    const TREATMENTS_URL = '/api/v3/treatments';
    const TREATMENT_PROPERTIES = ['app', 'enteredBy', 'eventType', 'notes', 'utcOffset', 'date', 'identifier'];
    const TREATMENT_DYNAMIC_PROPERTIES = ['created_at', 'subject', 'srvModified', 'srvCreated'];

    shouldHaveCommonAPIBehaviors(
      TREATMENTS_URL,
      sampleTreatments,
      TREATMENT_PROPERTIES,
      TREATMENT_DYNAMIC_PROPERTIES,
      'read'
    );
  });
});
