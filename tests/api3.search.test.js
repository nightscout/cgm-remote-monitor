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
  let modifiedDocs = [];

  docs.forEach((doc) => {
    let newDoc = {};

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
  let modifiedA = reduceFeatures(a, propertiesToCompare);
  let modifiedB = reduceFeatures(b, propertiesToCompare);

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
  let modifiedRequiredMembers = reduceFeatures(requiredMembers, propertiesToCompare);
  let modifiedArrayToCheck = reduceFeatures(arrayToCheck, propertiesToCompare);

  modifiedRequiredMembers.forEach((member) => {
    modifiedArrayToCheck.should.containEql(member);
  });
}


describe('API3 SEARCH INPUT', function() {
  const input = require('../lib/api3/generic/search/input');

  it('should ignore non-scalar filter_parameters values without string coercion', function() {
    const maliciousValue = {
      length: 1e100
      , toString: function toString () {
        throw new Error('filter_parameters object should not be coerced');
      }
    };

    const filter = input.parseFilter({
      query: {
        filter_parameters: maliciousValue
      }
    }, {});

    filter.should.eql([]);
  });
});


describe('API3 SEARCH', function() {
  const self = this
    , testConst = require('./fixtures/api3/const.json')
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , opTools = require('../lib/api3/shared/operationTools')
    , utils = require('./fixtures/api3/utils')
    ;


  /**
   * Create given document in a promise
   */
  self.createDocument = (doc, url) => new Promise((resolve, reject) => {
    doc.identifier = opTools.calculateIdentifier(doc);
    self.instance.post(url, self.jwt.all)
      .send(doc)
      .end((err, res) => {
        if (err) {
          return reject(err);
        }
        resolve(res);
      });
  });


  /**
   * Get document detail for futher processing
   */
  self.deleteDocument = (identifier, url) => new Promise((resolve, reject) => {
    self.instance.delete(`${url}/${identifier}`, self.jwt.read)
      .expect(200)
      .end((err) => {
        if (err) {
          return reject(err);
        }
        resolve();
      });
  });


  /**
   * Suite of tests executed against all search API endpoints.
   *
   * endpoint - the API endpoint to test
   * testDocs - docs inserted for test
   * commonProperties - properties all test docs contain
   * dynamicProperties - properties that cannot be compared against input
   *                     entries as they are created dynamically when stored
   *                     in the database
   */
  function shouldHaveCommonAPIBehaviors(endpoint, testDocs, commonProperties, dynamicProperties, jwtToUse) {


    const allProperties = commonProperties.concat(dynamicProperties);


    let createdDocs = [];


    before(async () => {
      // Create the sample CGM entries in the database
      const promises = testDocs.map(function(doc) { return self.createDocument(doc, endpoint); });

      await Promise.all(promises);
    });


    after(async () => {
      // Clean up any created docs
      const promises = createdDocs.map(function(doc) { return self.deleteDocument(doc.identifier, endpoint); });

      Promise.all(promises);
    });


    it('should require authentication', async function() {
      let res = await self.instance.get(endpoint)
        .expect(401);

      res.body.status.should.equal(401);
      res.body.message.should.equal('Missing or bad access token or JWT');
      should.not.exist(res.body.result);
    });


    it('should retrieve up to the max documents', async () => {
      const apiApp = self.instance.ctx.apiApp;
      const docLimit = Math.min(testDocs.length, apiApp.get('API3_MAX_LIMIT'));

      let res = await self.instance.get(endpoint, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);
      res.body.result.length.should.equal(docLimit);
      containsMembers(res.body.result, testDocs, commonProperties);
    });


    it('should retrieve the documents added after test start', async () => {
      let res = await self.instance.get(`${endpoint}?srvModified$gte=${self.testStarted.getTime()}`, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);
      res.body.result.length.should.equal(testDocs.length);
      containsMembers(res.body.result, testDocs, commonProperties);
    });


    it('should filter by a single parameter', async () => {
      const expectedDocs = testDocs.filter(doc => doc.date === testDocs[4].date);
      let res = await self.instance.get(`${endpoint}?date$eq=${testDocs[4].date}`, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);
      res.body.result.length.should.equal(expectedDocs.length);
      containsMembers(expectedDocs, res.body.result, commonProperties);
    });


    it('should filter by ISO8601 date', async () => {
      const isoDate = encodeURIComponent(new Date(testDocs[3].date).toISOString());
      const expectedDocs = testDocs.filter(doc => doc.date === testDocs[3].date);
      let res = await self.instance.get(`${endpoint}?date$eq=${isoDate}`, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);
      res.body.result.length.should.equal(expectedDocs.length);
      containsMembers(expectedDocs, res.body.result, commonProperties);
    });


    it('should filter by ISO8601 date with timezone', async () => {
      const timezoneDate = new Date(testDocs[3].date + (6 * 60 * 60 * 1000)).toISOString().replace('Z', '+06:00');
      const expectedDocs = testDocs.filter(doc => doc.date === testDocs[3].date);
      let res = await self.instance.get(`${endpoint}?date$eq=${encodeURIComponent(timezoneDate)}`, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);
      res.body.result.length.should.equal(expectedDocs.length);
      containsMembers(expectedDocs, res.body.result, commonProperties);
    });


    it('should filter by multiple operators on the same field', async () => {
      const sortedDocs = testDocs.slice().sort((a, b) => a.date - b.date);
      const lowerDate = sortedDocs[2].date;
      const upperDate = sortedDocs[7].date;
      const expectedDocs = testDocs.filter(doc => doc.date > lowerDate && doc.date < upperDate);
      let res = await self.instance.get(`${endpoint}?date$gt=${lowerDate}&date$lt=${upperDate}`, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);
      res.body.result.length.should.equal(expectedDocs.length);
      containsMembers(expectedDocs, res.body.result, commonProperties);
    });


    it('should accept a filter_parameters query argument', async () => {
      const filterParameters = encodeURIComponent(`date$eq=${testDocs[4].date}`);
      const expectedDocs = testDocs.filter(doc => doc.date === testDocs[4].date);
      let res = await self.instance.get(`${endpoint}?filter_parameters=${filterParameters}`, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);
      res.body.result.length.should.equal(expectedDocs.length);
      containsMembers(expectedDocs, res.body.result, commonProperties);
    });


    it('should accept multiple filter_parameters values', async () => {
      const sortedDocs = testDocs.slice().sort((a, b) => a.date - b.date);
      const lowerDate = sortedDocs[2].date;
      const upperDate = sortedDocs[7].date;
      const filterParameters = encodeURIComponent(`date$gt=${lowerDate} date$lt=${upperDate}`);
      const expectedDocs = testDocs.filter(doc => doc.date > lowerDate && doc.date < upperDate);
      let res = await self.instance.get(`${endpoint}?filter_parameters=${filterParameters}`, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);
      res.body.result.length.should.equal(expectedDocs.length);
      containsMembers(expectedDocs, res.body.result, commonProperties);
    });


    it('should accept repeated filter_parameters query arguments', async () => {
      const sortedDocs = testDocs.slice().sort((a, b) => a.date - b.date);
      const lowerDate = sortedDocs[2].date;
      const upperDate = sortedDocs[7].date;
      const lowerFilter = encodeURIComponent(`date$gt=${lowerDate}`);
      const upperFilter = encodeURIComponent(`date$lt=${upperDate}`);
      const expectedDocs = testDocs.filter(doc => doc.date > lowerDate && doc.date < upperDate);
      let res = await self.instance.get(`${endpoint}?filter_parameters=${lowerFilter}&filter_parameters=${upperFilter}`, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);
      res.body.result.length.should.equal(expectedDocs.length);
      containsMembers(expectedDocs, res.body.result, commonProperties);
    });


    it('should reject both sort and sort$desc', async () => {
      let res = await self.instance.get(`${endpoint}?sort=date&sort$desc=created_at`, self.jwt[jwtToUse])
        .expect(400);

      res.body.status.should.equal(400);
      res.body.message.should.equal('Parameters sort and sort_desc cannot be combined');
      should.not.exist(res.body.result);
    });


    it('should accept valid limit', async () => {
      // Requires at least 3 test documents
      let res = await self.instance.get(`${endpoint}?limit=3`, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);
      res.body.result.length.should.equal(3);
      containsMembers(res.body.result, testDocs, commonProperties);
    });


    it('should reject invalid limit - not a number', async () => {
      let res = await self.instance.get(`${endpoint}?limit=INVALID`, self.jwt[jwtToUse])
        .expect(400);

      res.body.status.should.equal(400);
      res.body.message.should.equal('Parameter limit out of tolerance');
      should.not.exist(res.body.result);
    });


    it('should reject invalid limit - negative number', async () => {
      let res = await self.instance.get(`${endpoint}?limit=-1`, self.jwt[jwtToUse])
        .expect(400);

      res.body.status.should.equal(400);
      res.body.message.should.equal('Parameter limit out of tolerance');
      should.not.exist(res.body.result);
    });


    it('should reject invalid limit - zero', async () => {
      let res = await self.instance.get(`${endpoint}?limit=0`, self.jwt[jwtToUse])
        .expect(400);

      res.body.status.should.equal(400);
      res.body.message.should.equal('Parameter limit out of tolerance');
      should.not.exist(res.body.result);
    });


    it('should not exceed the limit of docs count', async () => {
      const apiApp = self.instance.ctx.apiApp
        , limitBackup = apiApp.get('API3_MAX_LIMIT');
      apiApp.set('API3_MAX_LIMIT', 5);
      let res = await self.instance.get(`${endpoint}?limit=10`, self.jwt[jwtToUse])
        .expect(400);

      res.body.status.should.equal(400);
      res.body.message.should.equal('Parameter limit out of tolerance');
      apiApp.set('API3_MAX_LIMIT', limitBackup);
    });


    it('should respect the ceiling (hard) limit of docs', async () => {
      // This test requires at least 5 documents
      const apiApp = self.instance.ctx.apiApp
        , limitBackup = apiApp.get('API3_MAX_LIMIT');
      apiApp.set('API3_MAX_LIMIT', 5);
      let res = await self.instance.get(endpoint, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);
      res.body.result.length.should.equal(5);
      containsMembers(res.body.result, testDocs, commonProperties);
      apiApp.set('API3_MAX_LIMIT', limitBackup);
    });


    it('should respect string API3_MAX_LIMIT defaults', async () => {
      // This test requires at least 5 documents
      const apiApp = self.instance.ctx.apiApp
        , limitBackup = apiApp.get('API3_MAX_LIMIT');
      apiApp.set('API3_MAX_LIMIT', '5');
      let res = await self.instance.get(endpoint, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);
      res.body.result.length.should.equal(5);
      containsMembers(res.body.result, testDocs, commonProperties);
      apiApp.set('API3_MAX_LIMIT', limitBackup);
    });


    it('should skip documents', async () => {
      // This test requires at least 8 documents
      let res = await self.instance.get(`${endpoint}?sort=date&limit=8`, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);

      membersAreEqual(res.body.result, testDocs.slice(0, 8), commonProperties);

      res = await self.instance.get(`${endpoint}?sort=date&skip=3&limit=5`, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);

      membersAreEqual(res.body.result, testDocs.slice(3, 8), commonProperties);
    });


    it('should reject invalid skip - not a number', async () => {
      let res = await self.instance.get(`${endpoint}?skip=INVALID`, self.jwt[jwtToUse])
        .expect(400);

      res.body.status.should.equal(400);
      res.body.message.should.equal('Parameter skip out of tolerance');
      should.not.exist(res.body.result);
    });


    it('should reject invalid skip - negative number', async () => {
      let res = await self.instance.get(`${endpoint}?skip=-5`, self.jwt[jwtToUse])
        .expect(400);

      res.body.status.should.equal(400);
      res.body.message.should.equal('Parameter skip out of tolerance');
      should.not.exist(res.body.result);
    });


    it('should project all fields', async () => {
      let res = await self.instance.get(`${endpoint}?fields=_all`, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);
      res.body.result.forEach(doc => {
        // Sort because order doesn't matter
        (Object.getOwnPropertyNames(doc).sort()).should.eql(allProperties.sort());
        Object.prototype.hasOwnProperty.call(doc, '_id').should.not.be.true();
      });
    });


    it('should project selected fields', async () => {
      // Project the first half of given properties, then the second half
      const halfProperties = Math.ceil(commonProperties.length / 2);

      const lowerFields = commonProperties.slice(0, halfProperties);
      const upperFields = commonProperties.slice(halfProperties, commonProperties.length);

      let res = await self.instance.get(`${endpoint}?fields=${lowerFields.join(',')}&sort=date`, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);

      membersAreEqual(res.body.result, testDocs, lowerFields);

      res = await self.instance.get(`${endpoint}?fields=${upperFields.join(',')}&sort=date`, self.jwt[jwtToUse])
        .expect(200);

      res.body.status.should.equal(200);

      membersAreEqual(res.body.result, testDocs, upperFields);
    });


    it('should sort by the given property', async () => {
      // Test sorting by every property. A regular for loop is used to avoid
      // the complexity of promise composition.
      // Because Javascript sorts aren't stable, and some properties may have
      // repeated values,  we check that the resulting sort is valid instead
      // of checking against an exact sort
      for (let i = 0; i < allProperties.length; i++) {
        const property = allProperties[i];

        let res = await self.instance.get(`${endpoint}?sort=${property}`, self.jwt[jwtToUse])
          .expect(200);

        res.body.status.should.equal(200);

        res.body.result.length.should.equal(testDocs.length);
        containsMembers(res.body.result, testDocs, commonProperties);

        // Make sure the sort is valid, skipping the first idx
        (res.body.result.every((value, idx, arr) => !idx || arr[idx - 1][property] <= value[property])).should.be.true();

        res = await self.instance.get(`${endpoint}?sort$desc=${property}`, self.jwt[jwtToUse])
          .expect(200);

        res.body.status.should.equal(200);

        res.body.result.length.should.equal(testDocs.length);
        containsMembers(res.body.result, testDocs, commonProperties);

        (res.body.result.every((value, idx, arr) => !idx || arr[idx - 1][property] >= value[property])).should.be.true();
      }
    });
  }


  before(async () => {
    self.testStarted = new Date();
    self.instance = await instance.create({});

    self.app = self.instance.app;
    self.env = self.instance.env;

    let authResult = await authSubject(self.instance.ctx.authorization.storage, [
      'read',
      'all'
    ], self.instance.app);

    self.subject = authResult.subject;
    self.jwt = authResult.jwt;
  });


  after(async () => {
    await utils.storageClear(self.instance.ctx);
    self.instance.ctx.bus.teardown();
  });


  it('should not found not existing collection', async () => {
    let res = await self.instance.get('/api/v3/NOT_EXIST', self.jwt.read)
      .send(self.validDoc)
      .expect(404);

    res.body.status.should.equal(404);
    should.not.exist(res.body.result);
  });


  describe('device status endpoint', () => {
    const DEVICE_STATUSES_URL = '/api/v3/devicestatus';

    // Properties all test entries have
    const DEVICE_STATUS_PROPERTIES = ['date', 'app', 'some_property', 'identifier'];
    const DEVICE_STATUS_DYNAMIC_PROPERTIES = ['created_at', 'subject', 'srvModified', 'srvCreated', 'utcOffset'];


    // Check the common behaviors
    shouldHaveCommonAPIBehaviors(DEVICE_STATUSES_URL, testConst.SAMPLE_DEVICE_STATUSES, DEVICE_STATUS_PROPERTIES, DEVICE_STATUS_DYNAMIC_PROPERTIES, 'read');
  });


  describe('food endpoint', () => {
    const FOOD_URL = '/api/v3/food';

    // Properties all test entries have
    const FOOD_PROPERTIES = ['app', 'date', 'identifier', 'food', 'category', 'subcategory', 'name', 'portion', 'unit', 'carbs', 'fat', 'protein', 'energy', 'gi', 'hideafteruse', 'hidden', 'position', 'portions', 'foods'];
    const FOOD_DYNAMIC_PROPERTIES = ['created_at', 'subject', 'srvModified', 'srvCreated', 'utcOffset'];


    // Check the common behaviors
    shouldHaveCommonAPIBehaviors(FOOD_URL, testConst.SAMPLE_FOODS, FOOD_PROPERTIES, FOOD_DYNAMIC_PROPERTIES, 'read');
  });


  describe('entries endpoint', () => {
    const ENTRIES_URL = '/api/v3/entries';

    // Properties all test entries have
    const ENTRY_PROPERTIES = ['date', 'device', 'direction', 'filtered', 'noise', 'rssi', 'sgv', 'type', 'unfiltered', 'app', 'identifier'];
    const ENTRY_DYNAMIC_PROPERTIES = ['created_at', 'subject', 'srvModified', 'srvCreated', 'utcOffset'];


    // Check the common behaviors
    shouldHaveCommonAPIBehaviors(ENTRIES_URL, testConst.SAMPLE_ENTRIES, ENTRY_PROPERTIES, ENTRY_DYNAMIC_PROPERTIES, 'read');
  });


  describe('profiles endpoint', () => {
    const PROFILES_URL = '/api/v3/profile';

    // Properties all test entries have
    const PROFILE_PROPERTIES = ['date', 'app', 'some_property', 'identifier'];
    const PROFILE_DYNAMIC_PROPERTIES = ['created_at', 'subject', 'srvModified', 'srvCreated', 'utcOffset'];


    // Check the common behaviors
    shouldHaveCommonAPIBehaviors(PROFILES_URL, testConst.SAMPLE_PROFILES, PROFILE_PROPERTIES, PROFILE_DYNAMIC_PROPERTIES, 'read');
  });


  describe('settings endpoint', () => {
    const SETTINGS_URL = '/api/v3/settings';

    // Properties all test entries have
    const SETTING_PROPERTIES = ['date', 'app', 'some_property', 'identifier'];
    const SETTING_DYNAMIC_PROPERTIES = ['created_at', 'subject', 'srvModified', 'srvCreated', 'utcOffset'];


    // Make sure more than read is required
    it('should require all permission', async function() {
      let res = await self.instance.get(SETTINGS_URL, self.jwt.read)
        .expect(403);

      res.body.status.should.equal(403);
      res.body.message.should.equal('Missing permission api:settings:admin');
      should.not.exist(res.body.result);
    });

    // Check the common behaviors
    shouldHaveCommonAPIBehaviors(SETTINGS_URL, testConst.SAMPLE_SETTINGS, SETTING_PROPERTIES, SETTING_DYNAMIC_PROPERTIES, 'all');
  });


  describe('treatments endpoint', () => {
    const TREATMENTS_URL = '/api/v3/treatments';

    // Properties all test treatments have
    const TREATMENT_PROPERTIES = ['app', 'enteredBy', 'eventType', 'utcOffset', 'date', 'created_at', 'identifier'];
    const TREATMENT_DYNAMIC_PROPERTIES = ['subject', 'srvModified', 'srvCreated'];


    shouldHaveCommonAPIBehaviors(TREATMENTS_URL, testConst.SAMPLE_TREATMENTS,  TREATMENT_PROPERTIES, TREATMENT_DYNAMIC_PROPERTIES, 'read');
  });
});
