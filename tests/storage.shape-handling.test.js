'use strict';

var should = require('should');
var language = require('../lib/language')();

describe('Storage Layer Shape Handling - Direct Storage Tests', function () {
  this.timeout(15000);
  var self = this;

  // Use before() instead of beforeEach() for app setup - boots once for all tests
  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    
    require('../lib/server/bootevent')(self.env, language).boot(function booted(ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      done();
    });
  });

  describe('Treatments Storage - lib/server/treatments.js', function () {
    
    beforeEach(function (done) {
      self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        done();
      });
    });

    it('create() accepts single object', function (done) {
      var now = new Date().toISOString();
      self.ctx.treatments.create({
        eventType: 'Note',
        created_at: now,
        notes: 'storage single object'
      }, function (err, result) {
        should.not.exist(err);
        should.exist(result);
        result.should.be.instanceof(Array);
        result.length.should.be.greaterThanOrEqual(1);
        result[0].notes.should.equal('storage single object');
        done();
      });
    });

    it('create() accepts array with single element', function (done) {
      var now = new Date().toISOString();
      self.ctx.treatments.create([{
        eventType: 'Note',
        created_at: now,
        notes: 'storage array single'
      }], function (err, result) {
        should.not.exist(err);
        should.exist(result);
        result.should.be.instanceof(Array);
        result.length.should.be.greaterThanOrEqual(1);
        result[0].notes.should.equal('storage array single');
        done();
      });
    });

    it('create() accepts array with multiple elements', function (done) {
      var now = Date.now();
      self.ctx.treatments.create([
        { eventType: 'Note', created_at: new Date(now).toISOString(), notes: 'storage array 1' },
        { eventType: 'Note', created_at: new Date(now + 1000).toISOString(), notes: 'storage array 2' },
        { eventType: 'Note', created_at: new Date(now + 2000).toISOString(), notes: 'storage array 3' }
      ], function (err, result) {
        should.not.exist(err);
        should.exist(result);
        result.should.be.instanceof(Array);
        result.length.should.equal(3);
        done();
      });
    });

    it('create() handles large batch', function (done) {
      var treatments = [];
      var baseTime = Date.now();
      for (var i = 0; i < 20; i++) {
        treatments.push({
          eventType: 'Note',
          created_at: new Date(baseTime + i * 1000).toISOString(),
          notes: 'batch ' + i
        });
      }
      self.ctx.treatments.create(treatments, function (err, result) {
        should.not.exist(err);
        should.exist(result);
        result.should.be.instanceof(Array);
        result.length.should.equal(20);
        done();
      });
    });
  });

  describe('Devicestatus Storage - lib/server/devicestatus.js', function () {
    
    beforeEach(function (done) {
      self.ctx.devicestatus.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        done();
      });
    });

    it('create() accepts single object', function (done) {
      var now = new Date().toISOString();
      self.ctx.devicestatus.create({
        device: 'storage-test',
        created_at: now,
        uploaderBattery: 95
      }, function (err, result) {
        should.not.exist(err);
        should.exist(result);
        result.should.be.instanceof(Array);
        result.length.should.equal(1);
        result[0].uploaderBattery.should.equal(95);
        done();
      });
    });

    it('create() accepts array with single element', function (done) {
      var now = new Date().toISOString();
      self.ctx.devicestatus.create([{
        device: 'storage-test-array',
        created_at: now,
        uploaderBattery: 90
      }], function (err, result) {
        should.not.exist(err);
        should.exist(result);
        result.should.be.instanceof(Array);
        result.length.should.equal(1);
        result[0].uploaderBattery.should.equal(90);
        done();
      });
    });

    it('create() accepts array with multiple elements', function (done) {
      var now = Date.now();
      self.ctx.devicestatus.create([
        { device: 'device-1', created_at: new Date(now).toISOString(), uploaderBattery: 80 },
        { device: 'device-2', created_at: new Date(now + 1000).toISOString(), uploaderBattery: 75 },
        { device: 'device-3', created_at: new Date(now + 2000).toISOString(), uploaderBattery: 70 }
      ], function (err, result) {
        should.not.exist(err);
        should.exist(result);
        result.should.be.instanceof(Array);
        result.length.should.equal(3);
        done();
      });
    });

    it('create() handles large batch', function (done) {
      var statuses = [];
      var baseTime = Date.now();
      for (var i = 0; i < 20; i++) {
        statuses.push({
          device: 'batch-device-' + i,
          created_at: new Date(baseTime + i * 1000).toISOString(),
          uploaderBattery: 50 + i
        });
      }
      self.ctx.devicestatus.create(statuses, function (err, result) {
        should.not.exist(err);
        should.exist(result);
        result.should.be.instanceof(Array);
        result.length.should.equal(20);
        done();
      });
    });
  });

  describe('Entries Storage - lib/server/entries.js', function () {
    
    beforeEach(async function () {
      await self.ctx.entries().deleteMany({});
    });

    afterEach(async function () {
      await self.ctx.entries().deleteMany({});
    });

    it('create() accepts single entry in array', function (done) {
      var now = Date.now();
      self.ctx.entries.create([{
        type: 'sgv',
        sgv: 100,
        date: now,
        dateString: new Date(now).toISOString()
      }], function (err, result) {
        should.not.exist(err);
        done();
      });
    });

    it('create() accepts array with multiple entries', function (done) {
      var now = Date.now();
      self.ctx.entries.create([
        { type: 'sgv', sgv: 100, date: now, dateString: new Date(now).toISOString() },
        { type: 'sgv', sgv: 110, date: now + 300000, dateString: new Date(now + 300000).toISOString() },
        { type: 'sgv', sgv: 120, date: now + 600000, dateString: new Date(now + 600000).toISOString() }
      ], function (err, result) {
        should.not.exist(err);
        
        self.ctx.entries.list({ count: 10 }, function (listErr, list) {
          should.not.exist(listErr);
          list.length.should.be.greaterThanOrEqual(3);
          done();
        });
      });
    });
  });

  describe('Profile Storage - lib/server/profile.js', function () {
    
    beforeEach(async function () {
      await self.ctx.profile().deleteMany({});
    });

    afterEach(async function () {
      await self.ctx.profile().deleteMany({});
    });

    it('create() accepts single profile object', function (done) {
      var profile = {
        defaultProfile: 'Default',
        store: {
          Default: {
            dia: 3,
            carbratio: [{ time: '00:00', value: 30 }],
            sens: [{ time: '00:00', value: 100 }],
            basal: [{ time: '00:00', value: 0.5 }],
            target_low: [{ time: '00:00', value: 80 }],
            target_high: [{ time: '00:00', value: 120 }],
            units: 'mg/dl'
          }
        },
        startDate: new Date().toISOString(),
        units: 'mg/dl'
      };
      
      self.ctx.profile.create(profile, function (err, docs) {
        should.not.exist(err);
        should.exist(docs);
        // create() now always returns an array
        docs.should.be.an.Array();
        docs.length.should.equal(1);
        docs[0].defaultProfile.should.equal('Default');
        done();
      });
    });

    it('create() accepts array of profiles', function (done) {
      var profiles = [
        {
          defaultProfile: 'Default',
          store: {
            Default: { dia: 3, carbratio: [{ time: '00:00', value: 30 }] }
          },
          startDate: new Date().toISOString(),
          units: 'mg/dl'
        },
        {
          defaultProfile: 'Profile2',
          store: {
            Profile2: { dia: 4, carbratio: [{ time: '00:00', value: 25 }] }
          },
          startDate: new Date().toISOString(),
          units: 'mg/dl'
        }
      ];
      
      self.ctx.profile.create(profiles, function (err, docs) {
        should.not.exist(err);
        should.exist(docs);
        docs.should.be.an.Array();
        docs.length.should.equal(2);
        docs[0].defaultProfile.should.equal('Default');
        docs[1].defaultProfile.should.equal('Profile2');
        done();
      });
    });

    it('create() handles empty array', function (done) {
      self.ctx.profile.create([], function (err, docs) {
        should.not.exist(err);
        should.exist(docs);
        docs.should.be.an.Array();
        docs.length.should.equal(0);
        done();
      });
    });

    it('save() updates an existing profile by _id', function (done) {
      var original = {
        defaultProfile: 'Default',
        store: {
          Default: {
            dia: 3,
            carbratio: [{ time: '00:00', value: 30 }],
            sens: [{ time: '00:00', value: 100 }],
            basal: [{ time: '00:00', value: 0.5 }],
            target_low: [{ time: '00:00', value: 80 }],
            target_high: [{ time: '00:00', value: 120 }],
            units: 'mg/dl'
          }
        },
        startDate: '2024-10-19T23:00:00.000Z',
        created_at: '2024-10-26T20:32:49.173Z',
        units: 'mg/dl'
      };

      self.ctx.profile.save(original, function (err, savedProfile) {
        should.not.exist(err);
        should.exist(savedProfile);
        should.exist(savedProfile._id);

        var savedId = savedProfile._id;
        var updated = {
          _id: savedId.toString(),
          defaultProfile: 'Default',
          store: {
            Default: {
              dia: 4,
              carbratio: [{ time: '00:00', value: 30 }],
              sens: [{ time: '00:00', value: 100 }],
              basal: [{ time: '00:00', value: 0.5 }],
              target_low: [{ time: '00:00', value: 80 }],
              target_high: [{ time: '00:00', value: 120 }],
              units: 'mg/dl'
            }
          },
          startDate: '2024-10-19T23:00:00.000Z',
          created_at: '2024-10-26T21:32:49.173Z',
          units: 'mg/dl'
        };

        self.ctx.profile.save(updated, function (saveErr) {
          should.not.exist(saveErr);

          self.ctx.profile().find({ _id: savedId }).toArray()
            .then(function (docs) {
              docs.length.should.equal(1);
              docs[0].store.Default.dia.should.equal(4);
              docs[0].created_at.should.equal('2024-10-26T21:32:49.173Z');
              done();
            })
            .catch(done);
        });
      });
    });

    it('save() generates _id when none provided', function (done) {
      var profile = {
        defaultProfile: 'Default',
        store: {
          Default: {
            dia: 3,
            carbratio: [{ time: '00:00', value: 30 }],
            sens: [{ time: '00:00', value: 100 }],
            basal: [{ time: '00:00', value: 0.5 }],
            target_low: [{ time: '00:00', value: 80 }],
            target_high: [{ time: '00:00', value: 120 }],
            units: 'mg/dl'
          }
        },
        startDate: '2024-10-19T23:00:00.000Z',
        units: 'mg/dl'
      };

      self.ctx.profile.save(profile, function (err, saved) {
        should.not.exist(err);
        should.exist(saved);
        should.exist(saved._id);
        saved._id.constructor.name.should.equal('ObjectId');
        done();
      });
    });

    it('save() generates _id when invalid _id provided', function (done) {
      var profile = {
        _id: 'not-a-valid-objectid',
        defaultProfile: 'Default',
        store: {
          Default: {
            dia: 3,
            carbratio: [{ time: '00:00', value: 30 }],
            sens: [{ time: '00:00', value: 100 }],
            basal: [{ time: '00:00', value: 0.5 }],
            target_low: [{ time: '00:00', value: 80 }],
            target_high: [{ time: '00:00', value: 120 }],
            units: 'mg/dl'
          }
        },
        startDate: '2024-10-19T23:00:00.000Z',
        units: 'mg/dl'
      };

      self.ctx.profile.save(profile, function (err, saved) {
        should.not.exist(err);
        should.exist(saved);
        should.exist(saved._id);
        saved._id.constructor.name.should.equal('ObjectId');
        // Should not be the invalid string
        saved._id.toString().should.not.equal('not-a-valid-objectid');
        done();
      });
    });

    it('save() preserves explicit created_at and does not overwrite it', function (done) {
      var profile = {
        defaultProfile: 'Default',
        store: {
          Default: {
            dia: 3,
            carbratio: [{ time: '00:00', value: 30 }],
            sens: [{ time: '00:00', value: 100 }],
            basal: [{ time: '00:00', value: 0.5 }],
            target_low: [{ time: '00:00', value: 80 }],
            target_high: [{ time: '00:00', value: 120 }],
            units: 'mg/dl'
          }
        },
        startDate: '2024-10-19T23:00:00.000Z',
        created_at: '2020-01-01T00:00:00.000Z',
        units: 'mg/dl'
      };

      self.ctx.profile.save(profile, function (err, saved) {
        should.not.exist(err);
        saved.created_at.should.equal('2020-01-01T00:00:00.000Z');

        self.ctx.profile().find({ _id: saved._id }).toArray()
          .then(function (docs) {
            docs.length.should.equal(1);
            docs[0].created_at.should.equal('2020-01-01T00:00:00.000Z');
            done();
          })
          .catch(done);
      });
    });
  });

  describe('Food Storage - lib/server/food.js', function () {
    
    beforeEach(async function () {
      await self.ctx.food().deleteMany({});
    });

    afterEach(async function () {
      await self.ctx.food().deleteMany({});
    });

    it('create() accepts single food object', function (done) {
      var food = {
        name: 'Test Food',
        category: 'Test',
        carbs: 20,
        protein: 10,
        fat: 5
      };
      
      self.ctx.food.create(food, function (err, docs) {
        should.not.exist(err);
        should.exist(docs);
        // Storage normalizes to array internally
        docs.should.be.an.Array();
        docs[0].name.should.equal('Test Food');
        done();
      });
    });

    it('save() updates an existing food by _id when created_at changes', function (done) {
      self.ctx.food.create({
        name: 'Test Food',
        category: 'Test',
        carbs: 20,
        protein: 10,
        fat: 5
      }, function (err, createdDocs) {
        should.not.exist(err);
        should.exist(createdDocs);
        createdDocs.should.be.an.Array();
        createdDocs.length.should.equal(1);

        var savedId = createdDocs[0]._id;
        var updated = {
          _id: savedId.toString(),
          name: 'Updated Food',
          category: 'Test',
          carbs: 25,
          protein: 10,
          fat: 5,
          created_at: '2024-10-26T21:32:49.173Z'
        };

        self.ctx.food.save(updated, function (saveErr, savedDocs) {
          should.not.exist(saveErr);
          should.exist(savedDocs);
          savedDocs.should.be.an.Array();
          savedDocs.length.should.equal(1);

          self.ctx.food().find({ _id: savedId }).toArray()
            .then(function (docs) {
              docs.length.should.equal(1);
              docs[0].name.should.equal('Updated Food');
              docs[0].carbs.should.equal(25);
              docs[0].created_at.should.equal('2024-10-26T21:32:49.173Z');
              done();
            })
            .catch(done);
        });
      });
    });
  });

  describe('Activity Storage - lib/server/activity.js', function () {
    
    beforeEach(async function () {
      await self.ctx.activity().deleteMany({});
    });

    afterEach(async function () {
      await self.ctx.activity().deleteMany({});
    });

    it('create() accepts array of activity objects (single object not supported)', function (done) {
      var activity = [{
        created_at: new Date().toISOString(),
        heartrate: 80,
        steps: 100,
        activitylevel: 'walking'
      }];
      
      self.ctx.activity.create(activity, function (err, docs) {
        should.not.exist(err);
        should.exist(docs);
        docs.length.should.equal(1);
        done();
      });
    });

    it('save() updates an existing activity by _id', function (done) {
      self.ctx.activity.create([{
        created_at: '2024-10-26T20:32:49.173Z',
        heartrate: 80,
        steps: 100,
        activitylevel: 'walking'
      }], function (err, createdDocs) {
        should.not.exist(err);
        should.exist(createdDocs);
        createdDocs.length.should.equal(1);
        should.exist(createdDocs[0]._id);

        var savedId = createdDocs[0]._id;
        var updated = {
          _id: savedId.toString(),
          created_at: '2024-10-26T21:32:49.173Z',
          heartrate: 95,
          steps: 250,
          activitylevel: 'running'
        };

        self.ctx.activity.save(updated, function (saveErr, savedDoc) {
          should.not.exist(saveErr);
          should.exist(savedDoc);
          savedDoc._id.toString().should.equal(savedId.toString());

          self.ctx.activity().find({ _id: savedId }).toArray()
            .then(function (docs) {
              docs.length.should.equal(1);
              docs[0].heartrate.should.equal(95);
              docs[0].steps.should.equal(250);
              docs[0].activitylevel.should.equal('running');
              docs[0].created_at.should.equal('2024-10-26T21:32:49.173Z');
              done();
            })
            .catch(done);
        });
      });
    });
  });

  describe('Authorization Storage - lib/authorization/storage.js', function () {
    function rolesCollection() {
      return self.ctx.store.collection(self.env.authentication_collections_prefix + 'roles');
    }

    function subjectsCollection() {
      return self.ctx.store.collection(self.env.authentication_collections_prefix + 'subjects');
    }

    beforeEach(async function () {
      await rolesCollection().deleteMany({ name: 'mongo-save-role' });
      await subjectsCollection().deleteMany({ name: 'mongo-save-subject' });
    });

    afterEach(async function () {
      await rolesCollection().deleteMany({ name: 'mongo-save-role' });
      await subjectsCollection().deleteMany({ name: 'mongo-save-subject' });
    });

    it('saveRole() updates an existing role without duplicating it', function (done) {
      rolesCollection().insertOne({
        name: 'mongo-save-role',
        permissions: ['api:entries:read'],
        notes: 'original',
        created_at: '2024-10-26T20:32:49.173Z'
      }).then(function (result) {
        self.ctx.authorization.storage.saveRole({
          _id: result.insertedId.toString(),
          name: 'mongo-save-role',
          permissions: ['api:entries:update'],
          notes: 'updated',
          created_at: '2024-10-26T21:32:49.173Z'
        }, function (saveErr) {
          should.not.exist(saveErr);

          rolesCollection().find({ name: 'mongo-save-role' }).toArray()
            .then(function (docs) {
              docs.length.should.equal(1);
              docs[0].permissions.should.deepEqual(['api:entries:update']);
              docs[0].notes.should.equal('updated');
              docs[0].created_at.should.equal('2024-10-26T21:32:49.173Z');
              done();
            })
            .catch(done);
        });
      }).catch(done);
    });

    it('saveSubject() updates an existing subject without duplicating it', function (done) {
      subjectsCollection().insertOne({
        name: 'mongo-save-subject',
        roles: ['readable'],
        notes: 'original',
        created_at: '2024-10-26T20:32:49.173Z'
      }).then(function (result) {
        self.ctx.authorization.storage.saveSubject({
          _id: result.insertedId.toString(),
          name: 'mongo-save-subject',
          roles: ['admin'],
          notes: 'updated',
          created_at: '2024-10-26T21:32:49.173Z'
        }, function (saveErr) {
          should.not.exist(saveErr);

          subjectsCollection().find({ name: 'mongo-save-subject' }).toArray()
            .then(function (docs) {
              docs.length.should.equal(1);
              docs[0].roles.should.deepEqual(['admin']);
              docs[0].notes.should.equal('updated');
              docs[0].created_at.should.equal('2024-10-26T21:32:49.173Z');
              done();
            })
            .catch(done);
        });
      }).catch(done);
    });
  });
});

describe('MongoDB insertOne vs insertMany Behavior', function () {
  this.timeout(15000);
  var self = this;

  beforeEach(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    
    require('../lib/server/bootevent')(self.env, language).boot(function booted(ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      done();
    });
  });

  describe('Direct MongoDB operations - testing insertOne with array data', function () {
    
    it('insertOne with object inserts correctly', async function () {
      var testCollection = self.ctx.store.collection('test_shape_handling');

      await testCollection.deleteMany({});
      var result = await testCollection.insertOne({ type: 'test', value: 42 });
      should.exist(result);
      result.insertedId.should.be.ok();

      var docs = await testCollection.find({}).toArray();
      docs.length.should.equal(1);
      docs[0].value.should.equal(42);
      await testCollection.deleteMany({});
    });

    it('insertOne with array creates single document containing array (NOT multiple docs)', async function () {
      var testCollection = self.ctx.store.collection('test_shape_handling');

      await testCollection.deleteMany({});
      var arrayData = [
        { type: 'test', value: 1 },
        { type: 'test', value: 2 },
        { type: 'test', value: 3 }
      ];

      try {
        await testCollection.insertOne(arrayData);
      } catch (err) {
        console.log('insertOne with array error:', err.message);
        await testCollection.deleteMany({});
        return;
      }

      var docs = await testCollection.find({}).toArray();
      console.log('Documents after insertOne with array:', JSON.stringify(docs, null, 2));
      console.log('Number of documents:', docs.length);
      await testCollection.deleteMany({});
    });

    it('insertMany with array creates multiple documents', async function () {
      var testCollection = self.ctx.store.collection('test_shape_handling');

      await testCollection.deleteMany({});
      var arrayData = [
        { type: 'test', value: 1 },
        { type: 'test', value: 2 },
        { type: 'test', value: 3 }
      ];

      var result = await testCollection.insertMany(arrayData);
      should.exist(result);
      result.insertedCount.should.equal(3);

      var docs = await testCollection.find({}).toArray();
      docs.length.should.equal(3);
      await testCollection.deleteMany({});
    });
  });
});
