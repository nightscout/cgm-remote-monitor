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
    
    beforeEach(function (done) {
      self.ctx.entries().deleteMany({}, function () {
        done();
      });
    });

    afterEach(function (done) {
      self.ctx.entries().deleteMany({}, function () {
        done();
      });
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
    
    beforeEach(function (done) {
      self.ctx.profile().deleteMany({}, function () {
        done();
      });
    });

    afterEach(function (done) {
      self.ctx.profile().deleteMany({}, function () {
        done();
      });
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
      
      self.ctx.profile.create(profile, function (err, doc) {
        should.not.exist(err);
        should.exist(doc);
        doc.defaultProfile.should.equal('Default');
        done();
      });
    });
  });

  describe('Food Storage - lib/server/food.js', function () {
    
    beforeEach(function (done) {
      self.ctx.food().deleteMany({}, function () {
        done();
      });
    });

    afterEach(function (done) {
      self.ctx.food().deleteMany({}, function () {
        done();
      });
    });

    it('create() accepts single food object', function (done) {
      var food = {
        name: 'Test Food',
        category: 'Test',
        carbs: 20,
        protein: 10,
        fat: 5
      };
      
      self.ctx.food.create(food, function (err, doc) {
        should.not.exist(err);
        should.exist(doc);
        doc.name.should.equal('Test Food');
        done();
      });
    });
  });

  describe('Activity Storage - lib/server/activity.js', function () {
    
    beforeEach(function (done) {
      self.ctx.activity().deleteMany({}, function () {
        done();
      });
    });

    afterEach(function (done) {
      self.ctx.activity().deleteMany({}, function () {
        done();
      });
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
    
    it('insertOne with object inserts correctly', function (done) {
      var testCollection = self.ctx.store.collection('test_shape_handling');
      
      testCollection.deleteMany({}, function () {
        testCollection.insertOne({ type: 'test', value: 42 }, function (err, result) {
          should.not.exist(err);
          should.exist(result);
          result.insertedId.should.be.ok();
          
          testCollection.find({}).toArray(function (err, docs) {
            docs.length.should.equal(1);
            docs[0].value.should.equal(42);
            testCollection.deleteMany({}, done);
          });
        });
      });
    });

    it('insertOne with array creates single document containing array (NOT multiple docs)', function (done) {
      var testCollection = self.ctx.store.collection('test_shape_handling');
      
      testCollection.deleteMany({}, function () {
        var arrayData = [
          { type: 'test', value: 1 },
          { type: 'test', value: 2 },
          { type: 'test', value: 3 }
        ];
        
        testCollection.insertOne(arrayData, function (err, result) {
          if (err) {
            console.log('insertOne with array error:', err.message);
            done();
          } else {
            testCollection.find({}).toArray(function (err, docs) {
              console.log('Documents after insertOne with array:', JSON.stringify(docs, null, 2));
              console.log('Number of documents:', docs.length);
              
              testCollection.deleteMany({}, done);
            });
          }
        });
      });
    });

    it('insertMany with array creates multiple documents', function (done) {
      var testCollection = self.ctx.store.collection('test_shape_handling');
      
      testCollection.deleteMany({}, function () {
        var arrayData = [
          { type: 'test', value: 1 },
          { type: 'test', value: 2 },
          { type: 'test', value: 3 }
        ];
        
        testCollection.insertMany(arrayData, function (err, result) {
          should.not.exist(err);
          should.exist(result);
          result.insertedCount.should.equal(3);
          
          testCollection.find({}).toArray(function (err, docs) {
            docs.length.should.equal(3);
            testCollection.deleteMany({}, done);
          });
        });
      });
    });
  });
});
